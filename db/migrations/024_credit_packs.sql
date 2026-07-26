-- Migration 024 — one-time credit packs
--
-- "Buy a 10-pack, no subscription" — the standard on-ramp for a new
-- facility. Members purchase a pack via Stripe Checkout
-- (mode='payment' on the tenant's connected account) and the webhook
-- grants credits through apply_credit_change (new reason
-- 'pack_purchase').
--
-- Purchased credits must SURVIVE the weekly reset (migration 022
-- deliberately clawed back everything above the plan allotment and
-- deferred this protection to the packs slice). The v1 model:
--
--   * credit_balances.purchased_credits — how many of the member's
--     current_credits came from packs and are still unspent. Always
--     a SUBSET of current_credits (CHECK below).
--   * pack_purchase grants increment BOTH current_credits and
--     purchased_credits.
--   * DRAW-DOWN ORDER: spends consume subscription-week credits
--     FIRST, purchased credits LAST. Implemented as a clamp inside
--     apply_credit_change: after any negative change,
--     purchased_credits = LEAST(purchased_credits, new_balance).
--     While the balance stays above the purchased amount, purchased
--     credits are untouched; only once a spend digs below that line
--     do purchased credits start draining.
--   * The weekly reset SETS balance to credits_per_week +
--     purchased_credits — the subscription bucket refills, unspent
--     purchased credits roll over indefinitely.
--   * v1 simplification (documented in CLAUDE.md): positive non-pack
--     changes (booking_refund, admin_adjustment, ...) do NOT restore
--     purchased_credits. A refund that lands after purchased credits
--     were consumed comes back in the subscription bucket and expires
--     at the next reset. Precise per-spend restoration needs per-entry
--     bucket bookkeeping — deferred until it hurts.
--
-- Pieces:
--   1. credit_packs — the tenant-defined pack catalog (name, credits,
--      price_cents, active). Standard tenant conventions: tenant_id
--      CASCADE FK, UNIQUE (tenant_id, id), set_updated_at trigger,
--      RLS + FORCE + isolation policy. Grants: migration 011's
--      default privileges give app_runtime full CRUD, which is
--      correct here (admin CRUD writes rows directly).
--   2. credit_balances.purchased_credits + CHECKs.
--   3. 'pack_purchase' added to the ledger reason CHECK (same
--      drop/recreate pattern as migration 017; constraint name is
--      canonical: credit_ledger_entries_reason_check).
--   4. apply_credit_change replaced: maintains purchased_credits
--      (increment on pack_purchase, clamp on negative changes) and
--      rejects non-positive pack_purchase amounts.
--   5. run_weekly_credit_resets replaced: reset target is
--      credits_per_week + purchased_credits.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 024_credit_packs.sql
-- Depends on: 001 (set_updated_at), 002 (tenants), 003 (members),
--             005 (credit_balances, credit_ledger_entries),
--             010 (final ledger constraint shape),
--             011 (app_runtime + default privileges),
--             014 (apply_credit_change), 017 (reason CHECK canonical
--             name), 022 (run_weekly_credit_resets).
-- Verify: see commented block at end.

-- ============================================================
-- 1. credit_packs
-- ============================================================

CREATE TABLE credit_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (btrim(name) <> ''),
  credits      integer NOT NULL CHECK (credits > 0),
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Member storefront query: active packs, cheapest first.
CREATE INDEX credit_packs_tenant_active_idx
  ON credit_packs (tenant_id, active, price_cents);

CREATE TRIGGER credit_packs_set_updated_at
  BEFORE UPDATE ON credit_packs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE credit_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packs FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_packs_tenant_isolation ON credit_packs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No explicit grants needed: migration 011's ALTER DEFAULT PRIVILEGES
-- auto-granted SELECT/INSERT/UPDATE/DELETE to app_runtime, and packs
-- (unlike ledger rows) are ordinary admin-managed catalog rows.

COMMENT ON TABLE credit_packs IS
  'One-time purchasable credit bundles ("10-pack"). Soft-delete via '
  'active=false; bookings/ledger snapshot what they need, so rows are '
  'never DELETEd by the app.';

-- ============================================================
-- 2. purchased_credits on credit_balances
-- ============================================================

ALTER TABLE credit_balances
  ADD COLUMN purchased_credits integer NOT NULL DEFAULT 0
    CONSTRAINT credit_balances_purchased_nonnegative
    CHECK (purchased_credits >= 0);

-- Purchased credits are a subset of the total balance, never a
-- separate pool. Named so a future migration can drop it
-- deterministically.
ALTER TABLE credit_balances
  ADD CONSTRAINT credit_balances_purchased_within_balance
  CHECK (purchased_credits <= current_credits);

COMMENT ON COLUMN credit_balances.purchased_credits IS
  'How many of current_credits came from pack purchases and are still '
  'unspent. Maintained exclusively by apply_credit_change: incremented '
  'on pack_purchase, clamped to the new balance on negative changes '
  '(subscription credits spend first, purchased last). The weekly '
  'reset preserves this amount on top of the plan allotment.';

-- ============================================================
-- 3. Ledger reason CHECK gains 'pack_purchase'
-- ============================================================

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_reason_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_reason_check
  CHECK (reason IN ('weekly_reset', 'admin_adjustment', 'signup_bonus',
                    'booking_spend', 'booking_refund', 'plan_change',
                    'manual', 'migration', 'pack_purchase'));

-- ============================================================
-- 4. apply_credit_change — purchased_credits aware
-- ============================================================

-- Same signature as migration 014 (CREATE OR REPLACE keeps the
-- existing EXECUTE grants; they're restated below for clarity).
-- Behavior changes:
--   * reason 'pack_purchase' must have a positive amount.
--   * purchased_credits is maintained alongside current_credits:
--       pack_purchase      → purchased += amount
--       any other reason   → purchased  = LEAST(purchased, new_balance)
--     (a no-op for positive changes, since purchased <= old balance
--     <= new balance; the clamp is the draw-down rule for spends).
CREATE OR REPLACE FUNCTION apply_credit_change(
  p_tenant_id        uuid,
  p_member_id        uuid,
  p_amount           integer,
  p_reason           text,
  p_note             text DEFAULT NULL,
  p_granted_by       uuid DEFAULT NULL,
  p_booking_id       uuid DEFAULT NULL,
  p_class_booking_id uuid DEFAULT NULL
)
RETURNS TABLE (entry_id uuid, balance_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_guc_tenant    uuid;
  v_current       integer;
  v_purchased     integer;
  v_new           integer;
  v_new_purchased integer;
  v_existed       boolean;
  v_entry_id      uuid;
BEGIN
  -- 1. Cross-tenant defense: even SECURITY DEFINER callers must operate
  --    within the GUC tenant (see migration 014).
  v_guc_tenant := current_setting('app.current_tenant_id', true)::uuid;
  IF v_guc_tenant IS NULL OR v_guc_tenant <> p_tenant_id THEN
    RAISE EXCEPTION
      'tenant context mismatch: GUC=%, p_tenant_id=%',
      v_guc_tenant, p_tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. Amount sanity.
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'amount must be non-zero'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason = 'pack_purchase' AND p_amount <= 0 THEN
    RAISE EXCEPTION 'pack_purchase amount must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. Lock the balance row (if any). Serialization point per member.
  SELECT current_credits, purchased_credits
    INTO v_current, v_purchased
  FROM credit_balances
  WHERE tenant_id = p_tenant_id AND member_id = p_member_id
  FOR UPDATE;
  v_existed := FOUND;

  IF NOT v_existed THEN
    v_current := 0;
    v_purchased := 0;
  END IF;

  v_new := v_current + p_amount;

  -- 4. Reject if would go negative.
  IF v_new < 0 THEN
    RAISE EXCEPTION 'insufficient credits: have %, change %',
      v_current, p_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5. Purchased-credit bookkeeping (draw-down order lives here).
  IF p_reason = 'pack_purchase' THEN
    v_new_purchased := v_purchased + p_amount;
  ELSE
    v_new_purchased := LEAST(v_purchased, v_new);
  END IF;

  -- 6. Apply the balance change. last_reset_at only moves on
  --    weekly_reset reasons.
  IF v_existed THEN
    UPDATE credit_balances
       SET current_credits = v_new,
           purchased_credits = v_new_purchased,
           last_reset_at = CASE
             WHEN p_reason = 'weekly_reset' THEN now()
             ELSE last_reset_at
           END
     WHERE tenant_id = p_tenant_id AND member_id = p_member_id;
  ELSE
    INSERT INTO credit_balances (
      tenant_id, member_id, current_credits, purchased_credits, last_reset_at
    ) VALUES (
      p_tenant_id, p_member_id, v_new, v_new_purchased,
      CASE WHEN p_reason = 'weekly_reset' THEN now() ELSE NULL END
    );
  END IF;

  -- 7. Append the ledger row (table CHECKs validate the rest).
  INSERT INTO credit_ledger_entries (
    tenant_id, member_id, amount, balance_after, reason,
    note, granted_by, booking_id, class_booking_id
  ) VALUES (
    p_tenant_id, p_member_id, p_amount, v_new, p_reason,
    p_note, p_granted_by, p_booking_id, p_class_booking_id
  ) RETURNING id INTO v_entry_id;

  entry_id := v_entry_id;
  balance_after := v_new;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION apply_credit_change(
  uuid, uuid, integer, text, text, uuid, uuid, uuid
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION apply_credit_change(
  uuid, uuid, integer, text, text, uuid, uuid, uuid
) TO app_runtime;

-- ============================================================
-- 5. run_weekly_credit_resets — preserve purchased credits
-- ============================================================

-- Same shape as migration 022; the only change is the reset target:
-- credits_per_week + purchased_credits (instead of credits_per_week).
CREATE OR REPLACE FUNCTION run_weekly_credit_resets()
RETURNS TABLE (reset_tenant_id uuid, members_reset integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t            record;
  m            record;
  v_week_start timestamptz;
  v_current    integer;
  v_purchased  integer;
  v_delta      integer;
  v_count      integer;
BEGIN
  FOR t IN
    SELECT id, timezone, last_weekly_reset_at
      FROM tenants
     ORDER BY id
       FOR UPDATE SKIP LOCKED
  LOOP
    -- Per-tenant subtransaction: one tenant's failure must not block
    -- resets for everyone else.
    BEGIN
      v_week_start :=
        date_trunc('week', now() AT TIME ZONE t.timezone)
          AT TIME ZONE t.timezone;

      IF t.last_weekly_reset_at >= v_week_start THEN
        CONTINUE; -- this tenant-week is already done — idempotency
      END IF;

      PERFORM set_config('app.current_tenant_id', t.id::text, true);

      v_count := 0;
      FOR m IN
        SELECT s.member_id, p.credits_per_week
          FROM subscriptions s
          JOIN subscription_plan_periods spp
            ON spp.tenant_id = s.tenant_id
           AND spp.subscription_id = s.id
           AND spp.ended_at IS NULL
          JOIN plans p
            ON p.tenant_id = spp.tenant_id
           AND p.id = spp.plan_id
         WHERE s.tenant_id = t.id
           AND s.status = 'active'
      LOOP
        -- Lock the balance row BEFORE computing the delta so a
        -- concurrent booking spend can't slip in between.
        SELECT cb.current_credits, cb.purchased_credits
          INTO v_current, v_purchased
          FROM credit_balances cb
         WHERE cb.tenant_id = t.id AND cb.member_id = m.member_id
           FOR UPDATE;
        IF NOT FOUND THEN
          v_current := 0;
          v_purchased := 0;
        END IF;

        -- SET semantics on the SUBSCRIPTION bucket only: the balance
        -- lands on credits_per_week + still-unspent purchased
        -- credits. Purchased credits roll over until spent.
        v_delta := (m.credits_per_week + v_purchased) - v_current;
        IF v_delta <> 0 THEN
          PERFORM apply_credit_change(
            t.id, m.member_id, v_delta, 'weekly_reset',
            NULL, NULL, NULL, NULL
          );
        END IF;
        v_count := v_count + 1;
      END LOOP;

      UPDATE tenants
         SET last_weekly_reset_at = now()
       WHERE id = t.id;

      reset_tenant_id := t.id;
      members_reset := v_count;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_weekly_credit_resets: tenant % failed: %',
        t.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION run_weekly_credit_resets() IS
  'Weekly credit reset: for each tenant whose local clock crossed '
  'Monday 00:00 since last_weekly_reset_at, SET every active '
  'subscriber''s balance to credits_per_week + unspent purchased '
  'credits (reason weekly_reset, via apply_credit_change). Idempotent; '
  'safe to run hourly from pg_cron and/or the Node fallback scheduler.';

REVOKE ALL ON FUNCTION run_weekly_credit_resets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_weekly_credit_resets() TO app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. RLS enabled + forced on credit_packs:
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'credit_packs';
--      -- expected: 1 row, t / t
--
-- 2. Runtime CRUD on credit_packs (default privileges):
--      SELECT has_table_privilege('app_runtime', 'credit_packs', 'INSERT'); -- t
--      SELECT has_table_privilege('app_runtime', 'credit_packs', 'UPDATE'); -- t
--
-- 3. Reason CHECK includes pack_purchase:
--      SELECT pg_get_constraintdef(oid) FROM pg_constraint
--       WHERE conname = 'credit_ledger_entries_reason_check';
--      -- expect: ... 'migration', 'pack_purchase' ...
--
-- 4. Purchase → spend draw-down → reset preserves purchased:
--      BEGIN;
--      DO $verify$
--      DECLARE
--        v_t uuid; v_m uuid; v_p uuid; v_s uuid; r record;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-024', 'Verify 024', 'America/New_York')
--          RETURNING id INTO v_t;
--        PERFORM set_config('app.current_tenant_id', v_t::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_t, 'm@example.com', 'M', 'M') RETURNING id INTO v_m;
--        INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
--          VALUES (v_t, 'P', 5000, 10) RETURNING id INTO v_p;
--        INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
--          VALUES (v_t, v_m, 'active', now()) RETURNING id INTO v_s;
--        INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id)
--          VALUES (v_t, v_s, v_p);
--        -- 10 subscription + 5 purchased = 15
--        PERFORM apply_credit_change(v_t, v_m, 10, 'weekly_reset');
--        PERFORM apply_credit_change(v_t, v_m, 5, 'pack_purchase');
--        -- spend 12: subscription bucket drains first, purchased clamps to 3
--        PERFORM apply_credit_change(v_t, v_m, -12, 'admin_adjustment');
--        SELECT current_credits, purchased_credits INTO r
--          FROM credit_balances WHERE tenant_id = v_t AND member_id = v_m;
--        IF r.current_credits <> 3 OR r.purchased_credits <> 3 THEN
--          RAISE EXCEPTION 'FAIL: expected 3/3, got %/%',
--            r.current_credits, r.purchased_credits;
--        END IF;
--        -- reset lands on 10 + 3 = 13
--        UPDATE tenants SET last_weekly_reset_at = now() - interval '8 days'
--          WHERE id = v_t;
--        PERFORM run_weekly_credit_resets();
--        SELECT current_credits, purchased_credits INTO r
--          FROM credit_balances WHERE tenant_id = v_t AND member_id = v_m;
--        IF r.current_credits <> 13 OR r.purchased_credits <> 3 THEN
--          RAISE EXCEPTION 'FAIL: expected 13/3 after reset, got %/%',
--            r.current_credits, r.purchased_credits;
--        END IF;
--        RAISE NOTICE 'PASS: purchased credits survive the weekly reset';
--      END;
--      $verify$;
--      ROLLBACK;
--
-- 5. Negative pack_purchase rejected:
--      -- PERFORM apply_credit_change(t, m, -1, 'pack_purchase');
--      -- expected: check_violation 'pack_purchase amount must be positive'
