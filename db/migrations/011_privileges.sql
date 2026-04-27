-- Migration 011 — privileges (Phase 0 deliverable)
--
-- Creates the runtime DB role (`app_runtime`) the Express backend
-- connects as, and configures grants so:
--
--   * SELECT on `tenant_lookup` is granted (subdomain resolution).
--   * ALL access to `tenants` is REVOKED — runtime never sees the
--     billing columns. Cross-tenant ops use a privileged role
--     (postgres / supabase admin) via SECURITY DEFINER functions or
--     out-of-band SQL.
--   * Standard CRUD on every other table is granted.
--   * USAGE on all sequences is granted (required for INSERT into
--     bigserial columns like credit_ledger_entries.entry_number —
--     without it INSERTs fail with "permission denied for sequence").
--   * Default privileges are set so future tables/sequences created
--     in `public` by the migration role auto-grant to app_runtime.
--     A future migration that adds another privileged-only table
--     (similar to tenants) must explicitly REVOKE.
--
-- Phase 2 will also REVOKE INSERT/UPDATE/DELETE on credit_balances
-- and credit_ledger_entries from app_runtime, leaving only the
-- SECURITY DEFINER apply_credit_change() function able to write to
-- the ledger.
--
-- Operational notes:
--   * The role is created with LOGIN but no password. A real password
--     must be set via `ALTER ROLE app_runtime PASSWORD '...';` before
--     the backend can connect. In Supabase, do this once via the SQL
--     editor; in CI, set it before running the smoke test.
--   * `app_runtime` is NOT a superuser, NOT BYPASSRLS, and NOT a
--     table owner. With FORCE ROW LEVEL SECURITY on every tenant-
--     scoped table, RLS applies regardless.
--
-- Apply (as a privileged role — postgres in Supabase, or the CI
-- service container's admin user):
--   psql -v ON_ERROR_STOP=1 -f 011_privileges.sql
--
-- Depends on: 001–010 (all schema migrations applied).
-- Verify: see commented block at end. The two smoke tests are the
-- load-bearing ones — Checkpoint F lifts smoke test #1 into a
-- runs-on-every-PR CI check.

-- ============================================================
-- Create the runtime role (idempotent)
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
END
$$;

-- ============================================================
-- Schema-level grant
-- ============================================================

GRANT USAGE ON SCHEMA public TO app_runtime;

-- ============================================================
-- Table grants
-- ============================================================

-- Blanket CRUD on every table in `public`. The next REVOKE walks
-- back access to `tenants` so the runtime role can't read billing
-- columns.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO app_runtime;

-- Privileged-only: tenants. Runtime path uses tenant_lookup view.
REVOKE ALL ON tenants FROM app_runtime;

-- Explicit grant on the view (some Postgres versions don't include
-- views in `ALL TABLES IN SCHEMA`; this also documents intent).
GRANT SELECT ON tenant_lookup TO app_runtime;

-- ============================================================
-- Sequence grants
-- ============================================================

-- Required for INSERT into bigserial / serial columns. Currently
-- only credit_ledger_entries.entry_number, but the blanket grant
-- is forward-compatible.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- ============================================================
-- Default privileges for future objects
-- ============================================================

-- Anything created in `public` by the role running this migration
-- will automatically grant the standard CRUD + sequence USAGE to
-- app_runtime. A future migration that adds a privileged-only table
-- (like tenants) must explicitly REVOKE in the same migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- Run as a privileged role first to introspect:
--
-- 1. Role exists with the expected attributes
--    (rolsuper=f, rolbypassrls=f, rolcanlogin=t):
--      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
--        FROM pg_roles WHERE rolname = 'app_runtime';
--
-- 2. tenants is REVOKED, tenant_lookup is GRANTED. Easiest check:
--      SELECT has_table_privilege('app_runtime', 'tenants', 'SELECT');
--      -- expected: f
--      SELECT has_table_privilege('app_runtime', 'tenant_lookup', 'SELECT');
--      -- expected: t
--
-- 3. Sequence grant for credit_ledger_entries.entry_number (the only
--    sequence as of 011, but the grant is on ALL):
--      SELECT has_sequence_privilege('app_runtime',
--             'credit_ledger_entries_entry_number_seq', 'USAGE');
--      -- expected: t
--
-- ----------------------------------------------------------
-- SMOKE TEST #1 (load-bearing) — runtime cannot read tenants.
-- The SET ROLE / RESET ROLE pattern works in both psql and the
-- Supabase SQL editor.
--
--      SET ROLE app_runtime;
--      -- This MUST raise: permission denied for table tenants.
--      -- If it succeeds, the privilege setup is broken.
--      SELECT platform_stripe_customer_id FROM tenants LIMIT 1;
--      RESET ROLE;
--
-- SMOKE TEST #2 — runtime CAN read tenant_lookup.
--
--      SET ROLE app_runtime;
--      SELECT id, subdomain, name, timezone, is_billing_ok
--        FROM tenant_lookup LIMIT 1;
--      -- expected: succeeds (0 rows is fine if tenants is empty).
--      RESET ROLE;
--
-- SMOKE TEST #3 — runtime has USAGE on the credit-ledger sequence.
-- nextval() needs USAGE on the underlying sequence; if the
-- `GRANT USAGE, SELECT ON ALL SEQUENCES` step above didn't land,
-- this errors with "permission denied for sequence …". Side effect:
-- the sequence advances by one. Harmless — entry_number sequences
-- are allowed to have gaps, and the invariant the ledger cares
-- about is monotonicity, which still holds.
--
--      SET ROLE app_runtime;
--      SELECT nextval('credit_ledger_entries_entry_number_seq');
--      -- expected: returns an integer; no permission-denied error.
--      RESET ROLE;
--
-- Note on the CI check: Checkpoint F builds a Node test that opens
-- a connection AS app_runtime and runs the equivalent of smoke test
-- #1 — fails the build if the SELECT against tenants succeeds.
-- That test runs on every PR via the Postgres service container in
-- Checkpoint H's CI workflow.
