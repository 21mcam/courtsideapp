-- Migration 022 — weekly credit reset
--
-- The product's core credit semantic: every Monday 00:00 in the
-- TENANT's timezone, each member with an active subscription has
-- their balance SET to their plan's credits_per_week. Non-rollover:
-- unused credits are lost, and balances above the allotment (admin
-- grants) are reset down too. There is no subscription-vs-purchased
-- credit distinction in the schema yet; purchased-credit protection
-- arrives with credit packs (future reason 'pack_purchase').
--
-- Before this migration credits were granted ADDITIVELY on each
-- monthly Stripe invoice renewal (mislabeled 'weekly_reset'); the
-- webhook change that stops that ships alongside this migration.
-- Initial subscription activation still grants the first week of
-- credits (checkout.session.completed handler); this job owns all
-- replenishment after that.
--
-- Pieces:
--   1. tenants.last_weekly_reset_at — when the resetter last
--      completed for the tenant. NOT NULL DEFAULT now(): existing
--      tenants (and new signups) start their cycle at column
--      creation, so the first reset fires the FOLLOWING Monday
--      00:00 local — no surprise mid-week clawback on deploy.
--   2. run_weekly_credit_resets() — SECURITY DEFINER (owned by the
--      migration role), loops tenants whose local clock has crossed
--      Monday 00:00 since their last reset, sets the tenant GUC
--      inside the loop (same escape-hatch pattern as the Stripe
--      webhook), applies balance resets through apply_credit_change
--      (reason 'weekly_reset') so the ledger invariant holds, then
--      stamps last_weekly_reset_at. Idempotent: repeated calls
--      within the same tenant-week are no-ops. FOR UPDATE SKIP
--      LOCKED on the tenant loop means two concurrent runners
--      (pg_cron + the Node fallback, or two Node instances) can't
--      double-apply.
--   3. pg_cron hourly schedule — GUARDED: only registered when the
--      pg_cron extension is installed. CI's postgres:15 and the
--      local test DB don't have it; Supabase needs it enabled in
--      Dashboard → Database → Extensions, then the schedule
--      statement re-run (see MIGRATION_ORDER.md). Until then the
--      Node fallback in src/server.js (hourly setInterval, guarded
--      by SCHEDULER_ENABLED !== 'false') keeps the feature real.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 022_weekly_credit_reset.sql
-- Depends on: 002 (tenants), 005 (plans, subscriptions,
--             subscription_plan_periods, credit_balances),
--             011 (app_runtime role), 014 (apply_credit_change).
-- Verify: see commented block at end.

-- ============================================================
-- 1. Bookkeeping column
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN last_weekly_reset_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN tenants.last_weekly_reset_at IS
  'When run_weekly_credit_resets() last completed for this tenant. '
  'Default now() starts the cycle at tenant creation: first reset the '
  'following Monday 00:00 tenant-local.';

-- ============================================================
-- 2. The reset function
-- ============================================================

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
  v_delta      integer;
  v_count      integer;
BEGIN
  -- SKIP LOCKED: a concurrent runner that already holds a tenant row
  -- simply skips it; the loser re-evaluates due-ness on its own next
  -- hourly tick. ORDER BY id keeps lock acquisition deterministic.
  FOR t IN
    SELECT id, timezone, last_weekly_reset_at
      FROM tenants
     ORDER BY id
       FOR UPDATE SKIP LOCKED
  LOOP
    -- Per-tenant subtransaction: one tenant's failure (e.g. a bad
    -- timezone string) must not block resets for everyone else.
    BEGIN
      -- Most recent Monday 00:00 on the tenant's local clock, as an
      -- absolute instant. date_trunc('week', ...) on the naive local
      -- timestamp truncates to ISO week start (Monday 00:00); the
      -- second AT TIME ZONE converts local wall time back to
      -- timestamptz. DST transitions are handled by Postgres.
      v_week_start :=
        date_trunc('week', now() AT TIME ZONE t.timezone)
          AT TIME ZONE t.timezone;

      IF t.last_weekly_reset_at >= v_week_start THEN
        CONTINUE; -- this tenant-week is already done — idempotency
      END IF;

      -- Tenant context: RLS on the tables below and
      -- apply_credit_change's cross-tenant guard both key off the
      -- GUC. Transaction-local; overwritten each iteration.
      PERFORM set_config('app.current_tenant_id', t.id::text, true);

      v_count := 0;
      -- Active subscriptions only. past_due members are skipped —
      -- replenishment historically only followed successful payment
      -- (invoice.payment_succeeded flips past_due back to active),
      -- and the same rule holds here: recover first, reset next
      -- Monday.
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
        -- concurrent booking spend can't slip between our read and
        -- apply_credit_change's write (which re-locks the same row —
        -- same transaction, so no self-deadlock). Missing row = 0.
        SELECT cb.current_credits INTO v_current
          FROM credit_balances cb
         WHERE cb.tenant_id = t.id AND cb.member_id = m.member_id
           FOR UPDATE;
        IF NOT FOUND THEN
          v_current := 0;
        END IF;

        -- SET semantics: the delta lands the balance exactly on the
        -- plan allotment, up or down.
        v_delta := m.credits_per_week - v_current;
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
  'subscriber''s balance to their plan''s credits_per_week (reason '
  'weekly_reset, via apply_credit_change). Idempotent; safe to run '
  'hourly from pg_cron and/or the Node fallback scheduler.';

REVOKE ALL ON FUNCTION run_weekly_credit_resets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_weekly_credit_resets() TO app_runtime;

-- ============================================================
-- 3. pg_cron schedule (guarded — see header)
-- ============================================================
--
-- Supabase: enable pg_cron under Database → Extensions, then re-run
-- just this DO block (or the cron.schedule call inside it). Until
-- then the Node fallback covers scheduling.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'weekly-credit-resets',
      '7 * * * *', -- hourly at :07; the function no-ops when not due
      'SELECT run_weekly_credit_resets()'
    );
  ELSE
    RAISE NOTICE
      'pg_cron not installed; cron.schedule skipped. Enable pg_cron, '
      'then run: SELECT cron.schedule(''weekly-credit-resets'', '
      '''7 * * * *'', ''SELECT run_weekly_credit_resets()'');';
  END IF;
END;
$$;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Column exists with default:
--      SELECT column_name, column_default, is_nullable
--        FROM information_schema.columns
--       WHERE table_name = 'tenants'
--         AND column_name = 'last_weekly_reset_at';
--      -- expected: 1 row, default now(), is_nullable = NO
--
-- 2. Function exists with SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc
--       WHERE proname = 'run_weekly_credit_resets';
--      -- expected: 1 row, prosecdef = t
--
-- 3. EXECUTE granted to app_runtime, not public:
--      SELECT has_function_privilege(
--        'app_runtime', 'run_weekly_credit_resets()', 'EXECUTE');
--      -- expected: t
--
-- 4. Reset SETS (not adds) and is idempotent:
--      BEGIN;
--      DO $verify$
--      DECLARE
--        v_t uuid; v_m uuid; v_p uuid; v_s uuid; v_bal integer;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-022', 'Verify 022', 'America/New_York')
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
--        PERFORM apply_credit_change(v_t, v_m, 25, 'admin_adjustment');
--        UPDATE tenants SET last_weekly_reset_at = now() - interval '8 days'
--          WHERE id = v_t;
--        PERFORM run_weekly_credit_resets();
--        SELECT current_credits INTO v_bal FROM credit_balances
--          WHERE tenant_id = v_t AND member_id = v_m;
--        IF v_bal <> 10 THEN
--          RAISE EXCEPTION 'FAIL: expected balance 10, got %', v_bal;
--        END IF;
--        PERFORM run_weekly_credit_resets(); -- second run: no-op
--        IF (SELECT count(*) FROM credit_ledger_entries
--             WHERE tenant_id = v_t AND member_id = v_m
--               AND reason = 'weekly_reset') <> 1 THEN
--          RAISE EXCEPTION 'FAIL: second run was not a no-op';
--        END IF;
--        RAISE NOTICE 'PASS: reset sets to 10, idempotent';
--      END;
--      $verify$;
--      ROLLBACK;
