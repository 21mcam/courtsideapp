-- Migration 009 — stripe_connections
--
-- One row per tenant tracking that tenant's Stripe Connect (Standard)
-- account. A connection exists once a tenant clicks "Connect Stripe"
-- but they may not have completed onboarding — the three booleans
-- (details_submitted, charges_enabled, payouts_enabled) mirror
-- Stripe's own readiness state. App code uses charges_enabled to
-- gate "can this tenant accept payments yet."
--
-- platform_fee_basis_points is the application_fee Connect skims on
-- behalf of the platform. Stored in basis points (10000 = 100%) to
-- avoid decimal money math. Default 0 means the platform doesn't
-- take a cut; tenants pay only the flat SaaS fee.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 009_stripe_connections.sql
-- Depends on: 002 (tenants).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 7: STRIPE CONNECT — stripe_connections
-- ============================================================

CREATE TABLE stripe_connections (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id           text NOT NULL UNIQUE,
  details_submitted           boolean NOT NULL DEFAULT false,
  charges_enabled             boolean NOT NULL DEFAULT false,
  payouts_enabled             boolean NOT NULL DEFAULT false,
  platform_fee_basis_points   integer NOT NULL DEFAULT 0
                              CHECK (platform_fee_basis_points BETWEEN 0 AND 10000),
  connected_at                timestamptz NOT NULL DEFAULT now(),
  fully_onboarded_at          timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER stripe_connections_set_updated_at
  BEFORE UPDATE ON stripe_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE stripe_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_connections_tenant_isolation ON stripe_connections
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Table present, RLS forced (expected: 1 row, t/t):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'stripe_connections';
--
-- 2. Isolation policy present (expected: 1 row):
--      SELECT policyname FROM pg_policies
--       WHERE tablename = 'stripe_connections';
--
-- 3. set_updated_at trigger present (expected: 1 row):
--      SELECT trigger_name FROM information_schema.triggers
--       WHERE trigger_name = 'stripe_connections_set_updated_at';
--
-- 4. Basis-points CHECK rejects out-of-range values:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-009', 'Verify 009', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        BEGIN
--          INSERT INTO stripe_connections
--            (tenant_id, stripe_account_id, platform_fee_basis_points)
--            VALUES (v_tenant_id, 'acct_x', 10001);  -- > 10000
--          RAISE EXCEPTION 'FAIL: out-of-range basis points accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: out-of-range basis points rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. PRIMARY KEY (tenant_id) means one connection per tenant. Second
--    INSERT for the same tenant must fail.
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-009b', 'Verify 009b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO stripe_connections (tenant_id, stripe_account_id)
--          VALUES (v_tenant_id, 'acct_first');
--        BEGIN
--          INSERT INTO stripe_connections (tenant_id, stripe_account_id)
--            VALUES (v_tenant_id, 'acct_second');
--          RAISE EXCEPTION 'FAIL: second connection per tenant accepted';
--        EXCEPTION WHEN unique_violation THEN
--          RAISE NOTICE 'PASS: second connection per tenant rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
