-- Migration 005 — plans, subscriptions, plan periods, credit balances,
--                   credit ledger entries
--
-- Subscription/credit layer. The plan defines monthly price + weekly
-- credit allotment + optional category whitelist. A subscription is
-- one Stripe subscription's lifecycle. subscription_plan_periods
-- tracks plan changes within that subscription via a non-overlapping
-- tstzrange. credit_balances is the current count; credit_ledger_entries
-- is the append-only history that proves it.
--
-- Three things deferred to later migrations and worth flagging:
--   * `credit_ledger_entries` here gets a `booking_id` column WITHOUT
--     the FK to `bookings` — bookings doesn't exist yet. The FK is
--     added at the end of migration 007.
--   * `class_booking_id` column is NOT added here at all; it lands in
--     migration 010 after class_bookings exists.
--   * The booking-reference CHECK is named explicitly
--     (`credit_ledger_entries_booking_ref_check`) so migration 010
--     can drop it deterministically by name and replace it with one
--     that handles both booking_id and class_booking_id.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 005_subscriptions_and_credits.sql
-- Depends on: 003 (members), 004 (category_key already exists from 001).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 3: SUBSCRIPTION / CREDIT — plans
-- ============================================================

CREATE TABLE plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL
                        CHECK (btrim(name) <> '' AND name = btrim(name)),
  description           text,
  monthly_price_cents   integer NOT NULL CHECK (monthly_price_cents >= 0),
  credits_per_week      integer NOT NULL CHECK (credits_per_week >= 0),
  -- NULL means "all categories allowed"; non-empty array is a whitelist.
  -- category_key domain rejects NULL elements so the array is clean.
  allowed_categories    category_key[]
                        CHECK (allowed_categories IS NULL
                               OR cardinality(allowed_categories) > 0),
  -- Stripe Price ID lives in the tenant's Connect account. Nullable
  -- because plans can be created in the wizard before Stripe Connect
  -- is finished. Sync logic enforces "active plans must have a Stripe
  -- price" at the application layer. Globally unique in practice;
  -- the partial unique index below is sufficient.
  stripe_price_id       text,
  active                boolean NOT NULL DEFAULT true,
  display_order         integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Active plan names unique per tenant, case-insensitive. Inactive
-- plans don't block creating a new active plan with the same name.
CREATE UNIQUE INDEX plans_active_name_unique
  ON plans (tenant_id, lower(name))
  WHERE active = true;

CREATE UNIQUE INDEX plans_stripe_price_unique
  ON plans (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE TRIGGER plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_tenant_isolation ON plans
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- subscriptions
-- ============================================================

-- One row per Stripe subscription. This represents the
-- subscription's lifecycle, NOT the plan history. When a member
-- upgrades their plan, Stripe updates this same subscription's items
-- — so we keep this row, and add a new row in
-- subscription_plan_periods. Cancel-and-resubscribe creates a new
-- subscription row.
--
-- Statuses are internal (Stripe-mapped, not Stripe-mirrored) — we
-- translate Stripe's "canceled" to our "cancelled" at the webhook
-- boundary. Stripe's "incomplete_expired" maps to our "cancelled".
--
-- Phase 5 deliverable: a janitor job that sweeps `incomplete`
-- subscriptions older than 24h and marks them cancelled. Stripe
-- normally fires `incomplete_expired` automatically, but the janitor
-- is the safety net for missed webhooks. Without it, a stale
-- incomplete subscription can block a member from retrying checkout
-- (subscriptions_one_active_per_member would conflict).
--
-- Note: stripe_customer_id is more "member identity" than
-- "subscription lifecycle". For v1 it lives here; consider a
-- stripe_customers table later when adding multi-customer support
-- or platform-wide deduplication.
CREATE TABLE subscriptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id                   uuid NOT NULL,
  stripe_subscription_id      text,
  stripe_customer_id          text,
  status                      text NOT NULL
                              CHECK (status IN ('pending', 'active', 'past_due',
                                                 'cancelled', 'incomplete')),
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  cancel_at_period_end        boolean NOT NULL DEFAULT false,
  scheduled_deactivation_at   timestamptz,
  -- Set when status first becomes 'active'. NULL for subscriptions
  -- that never activated (e.g. payment never cleared).
  activated_at                timestamptz,
  -- Set when status moves to a terminal state.
  ended_at                    timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE,
  -- Period bounds must make sense if both are set. Skipping the
  -- analogous activated_at/ended_at check intentionally — Stripe
  -- webhook ordering edge cases make a strict DB constraint there
  -- create more reconciliation pain than value. App-level validation
  -- handles that one.
  CHECK (
    current_period_start IS NULL
    OR current_period_end IS NULL
    OR current_period_end > current_period_start
  )
);

CREATE UNIQUE INDEX subscriptions_stripe_unique
  ON subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- A member can have many historical subscriptions but only one
-- non-terminal subscription at a time.
CREATE UNIQUE INDEX subscriptions_one_active_per_member
  ON subscriptions (tenant_id, member_id)
  WHERE status IN ('pending', 'active', 'past_due', 'incomplete');

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- subscription_plan_periods
-- ============================================================

-- Plan history within a subscription. One row per "you were on this
-- plan from started_at until ended_at." Plan changes (upgrade,
-- downgrade) close the previous row and open a new one. The current
-- plan for a subscription is the row where ended_at IS NULL.
--
-- Why separate from subscriptions: Stripe represents plan changes as
-- updates to the same subscription's items. We need history for
-- billing audits, "when did this member upgrade?" support questions,
-- and credit ledger reasons (plan_change credits get tied to a
-- specific period's start).
--
-- period_range is a generated tstzrange over [started_at,
-- coalesce(ended_at, 'infinity')) used by the exclusion constraint
-- to prevent overlapping plan periods within a subscription. This is
-- a critical invariant: bookings and credit logic ask "what plan was
-- active at time X" and need a single answer.
--
-- Provenance columns (started_reason/by, ended_reason/by) are
-- DEFERRED. A single change_reason is ambiguous because a period
-- has two lifecycle moments. When a concrete need arises, add four
-- nullable columns: started_reason, started_by, ended_reason,
-- ended_by. Historical rows stay null.
CREATE TABLE subscription_plan_periods (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id     uuid NOT NULL,
  plan_id             uuid NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,    -- NULL = currently in effect
  period_range        tstzrange GENERATED ALWAYS AS (
                        tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)')
                      ) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_id) REFERENCES plans(tenant_id, id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at),
  EXCLUDE USING gist (
    tenant_id WITH =,
    subscription_id WITH =,
    period_range WITH &&
  )
);

CREATE INDEX subscription_plan_periods_subscription_idx
  ON subscription_plan_periods (tenant_id, subscription_id, started_at);

-- Fast lookup for the common "what plan is this subscription on right
-- now?" query. The GiST exclusion index handles overlap checks, but
-- isn't great for simple equality. This partial btree is small and
-- direct.
CREATE INDEX subscription_plan_periods_current_idx
  ON subscription_plan_periods (tenant_id, subscription_id)
  WHERE ended_at IS NULL;

CREATE TRIGGER subscription_plan_periods_set_updated_at
  BEFORE UPDATE ON subscription_plan_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscription_plan_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plan_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_plan_periods_tenant_isolation ON subscription_plan_periods
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- credit_balances
-- ============================================================

-- Singleton-per-member current balance.
-- Mutations go through apply_credit_change() (TODO Phase 2) which
-- writes both this row AND a credit_ledger_entries row in one
-- transaction. Direct UPDATE on this table is forbidden — privileges
-- will be revoked from the runtime DB role; only SECURITY DEFINER
-- function can write.
CREATE TABLE credit_balances (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL,
  current_credits  integer NOT NULL DEFAULT 0 CHECK (current_credits >= 0),
  last_reset_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER credit_balances_set_updated_at
  BEFORE UPDATE ON credit_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_balances_tenant_isolation ON credit_balances
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- credit_ledger_entries (without booking FK and without class_booking_id)
-- ============================================================

-- Append-only credit ledger. Every balance mutation writes a row.
-- Invariant: credit_balances.current_credits = balance_after of the
-- ledger row with the highest entry_number for that (tenant_id,
-- member_id).
--
-- entry_number (bigserial, globally monotonic) is the source of
-- truth for ordering, not created_at — because now() returns the
-- transaction start time, multiple ledger inserts in one transaction
-- would otherwise share a created_at and make "latest" ambiguous.
--
-- amount is signed: positive = credits added, negative = removed.
-- balance_after is the resulting balance (must be >= 0).
--
-- booking_id is added in a later migration once bookings exists
-- (see migration 007). class_booking_id and the
-- no-double-booking-ref CHECK come in migration 010.
CREATE TABLE credit_ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number    bigserial NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL,
  amount          integer NOT NULL CHECK (amount <> 0),
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  reason          text NOT NULL
                  CHECK (reason IN ('weekly_reset', 'admin_adjustment', 'signup_bonus',
                                    'booking_spend', 'booking_refund', 'plan_change',
                                    'manual')),
  note            text,
  granted_by      uuid,         -- user_id of admin (if any). No FK so historical entries
                                -- survive admin user deletion.
  booking_id      uuid,         -- FK added in migration 007 once bookings exists.
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE,
  -- booking_id presence is tied to reason: booking_spend/booking_refund
  -- entries must reference a booking; other reasons must not.
  -- Named explicitly so migration 010 can drop it by deterministic
  -- name when adding class_booking_id support.
  CONSTRAINT credit_ledger_entries_booking_ref_check
    CHECK ((reason IN ('booking_spend', 'booking_refund')) = (booking_id IS NOT NULL)),
  -- amount direction is fixed for booking-related reasons:
  --   booking_spend: credits leaving the balance (negative)
  --   booking_refund: credits returning to the balance (positive)
  -- Other reasons (admin_adjustment, manual, plan_change) can be
  -- either direction by intent — app validation handles those.
  CONSTRAINT credit_ledger_entries_booking_amount_sign_check
    CHECK (
      CASE reason
        WHEN 'booking_spend' THEN amount < 0
        WHEN 'booking_refund' THEN amount > 0
        ELSE true
      END
    )
);

CREATE INDEX credit_ledger_entries_member_entry_idx
  ON credit_ledger_entries (tenant_id, member_id, entry_number DESC);

ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_entries_tenant_isolation ON credit_ledger_entries
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. All five tables present, all RLS-forced (expected: 5 rows, t/t each):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public'
--         AND tablename IN ('plans', 'subscriptions',
--                           'subscription_plan_periods',
--                           'credit_balances', 'credit_ledger_entries')
--       ORDER BY tablename;
--
-- 2. Named CHECKs on credit_ledger_entries are present (expected: 2 rows):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'credit_ledger_entries'::regclass
--         AND conname IN ('credit_ledger_entries_booking_ref_check',
--                         'credit_ledger_entries_booking_amount_sign_check')
--       ORDER BY conname;
--
-- 3. credit_ledger_entries.booking_id has NO foreign key yet
--    (expected: 0 rows — FK is added in migration 007):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'credit_ledger_entries'::regclass
--         AND contype = 'f'
--         AND conname = 'credit_ledger_entries_booking_id_fkey';
--
-- 4. credit_ledger_entries does NOT have class_booking_id column yet
--    (expected: 0 rows — column added in migration 010):
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema = 'public'
--         AND table_name = 'credit_ledger_entries'
--         AND column_name = 'class_booking_id';
--
-- 5. subscription_plan_periods exclusion constraint rejects overlap.
--    Inserts the same plan twice for one subscription with
--    overlapping periods — second INSERT must fail.
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id uuid;
--        v_member_id uuid;
--        v_plan_id   uuid;
--        v_sub_id    uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-005', 'Verify 005', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_tenant_id, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_member_id;
--        INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
--          VALUES (v_tenant_id, 'Pro', 26900, 20)
--          RETURNING id INTO v_plan_id;
--        INSERT INTO subscriptions (tenant_id, member_id, status)
--          VALUES (v_tenant_id, v_member_id, 'active')
--          RETURNING id INTO v_sub_id;
--        INSERT INTO subscription_plan_periods
--          (tenant_id, subscription_id, plan_id, started_at, ended_at)
--          VALUES (v_tenant_id, v_sub_id, v_plan_id,
--                  now() - interval '10 days', now() + interval '10 days');
--        BEGIN
--          INSERT INTO subscription_plan_periods
--            (tenant_id, subscription_id, plan_id, started_at, ended_at)
--            VALUES (v_tenant_id, v_sub_id, v_plan_id,
--                    now() - interval '5 days', now() + interval '5 days');
--          RAISE EXCEPTION 'FAIL: overlapping plan period accepted';
--        EXCEPTION WHEN exclusion_violation THEN
--          RAISE NOTICE 'PASS: overlapping plan period rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 6. credit_ledger_entries booking-ref CHECK rejects mismatched
--    reason+booking_id combinations (booking_spend without booking_id):
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid; v_member_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-005b', 'Verify 005b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_tenant_id, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_member_id;
--        BEGIN
--          INSERT INTO credit_ledger_entries
--            (tenant_id, member_id, amount, balance_after, reason)
--            VALUES (v_tenant_id, v_member_id, -1, 0, 'booking_spend');
--          RAISE EXCEPTION 'FAIL: booking_spend without booking_id accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: booking_spend without booking_id rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
