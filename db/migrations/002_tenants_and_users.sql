-- Migration 002 — tenants, tenant_lookup view, users
--
-- Foundation layer. Establishes the multi-tenant root and the auth
-- identity table.
--
-- Special cases worth flagging:
--   * `tenants` is the only table without a tenant_id and does NOT
--     enable RLS — it's queried during subdomain resolution before
--     tenant context exists. Privilege isolation is via the
--     `tenant_lookup` view + role grants in migration 011 — runtime
--     never sees tenants.* directly.
--   * `tenant_lookup` view exposes only routing-safe columns
--     (id, subdomain, name, timezone) plus a derived `is_billing_ok`
--     boolean. Platform Stripe IDs and status enums never leak.
--   * `users` has UNIQUE (tenant_id, id, email). The triple-uniqueness
--     is required by migration 003's `members` composite FK on
--     (tenant_id, user_id, email) — it forces a linked member's email
--     to match the user's email so login identity and member identity
--     can't drift apart.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 002_tenants_and_users.sql
-- Depends on: 001
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 1: FOUNDATION — tenants
-- ============================================================

-- The tenants table is special: it's the root, has no tenant_id, and
-- is queried during subdomain resolution BEFORE any tenant context
-- exists. To prevent accidental exposure of platform billing fields
-- to the runtime path, application code must use a narrow
-- `tenant_lookup` view (Phase 0 deliverable) that exposes only
-- routing-safe columns (id, subdomain, name, timezone). The runtime
-- DB role gets SELECT on the view; the underlying table is reachable
-- only via the migration/super-admin role.
CREATE TABLE tenants (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subdomain                       text UNIQUE NOT NULL
                                  CHECK (
                                    subdomain = lower(subdomain)
                                    AND subdomain ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'
                                    AND subdomain NOT IN (
                                      'www', 'api', 'admin', 'app', 'support', 'login',
                                      'help', 'mail', 'auth', 'status', 'cdn', 'static',
                                      'assets'
                                    )
                                  ),
  name                            text NOT NULL
                                  CHECK (btrim(name) <> '' AND name = btrim(name)),
  timezone                        text NOT NULL
                                  CHECK (btrim(timezone) <> '' AND timezone = btrim(timezone)),
  -- platform-side billing (what the tenant pays us). Privileged-only
  -- — never exposed via tenant_lookup view.
  platform_stripe_customer_id     text,
  platform_stripe_subscription_id text,
  platform_subscription_status    text NOT NULL DEFAULT 'trial'
                                  CHECK (platform_subscription_status IN
                                         ('trial', 'active', 'past_due', 'cancelled', 'suspended')),
  trial_ends_at                   timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_platform_stripe_customer_unique
  ON tenants (platform_stripe_customer_id)
  WHERE platform_stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX tenants_platform_stripe_subscription_unique
  ON tenants (platform_stripe_subscription_id)
  WHERE platform_stripe_subscription_id IS NOT NULL;

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenants is the root: no tenant_id column, so the standard
-- `tenant_id = current_setting(...)` policy doesn't apply. We still
-- enable RLS with NO POLICY, which becomes a blanket deny for any
-- role without BYPASSRLS — defense in depth against Supabase's
-- default `anon`/`authenticated` grants and any future role we
-- forget about.
--
-- FORCE ROW LEVEL SECURITY is intentionally NOT set on tenants:
-- migrations and cross-tenant ops (Stripe webhook resolving from
-- customer ID, super-admin) need to read/write tenants as the
-- postgres / DDL role. With ENABLE-only, the table owner still
-- bypasses the (missing) policy; non-owner non-BYPASSRLS roles see
-- nothing.
--
-- The runtime path (Express backend, role app_runtime) never queries
-- tenants directly — it goes through the `tenant_lookup` view below.
-- Migration 011 also REVOKE ALL ON tenants FROM app_runtime, so the
-- runtime is denied at the GRANT layer too.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- tenant_lookup view (runtime-safe)
-- ============================================================

-- Narrow lookup view for subdomain resolution. Runtime DB role gets
-- SELECT on this view, NOT on the underlying tenants table — that
-- keeps platform billing fields out of the routing path. Only the
-- migration / super-admin role can query tenants directly.
--
-- is_billing_ok is a derived boolean exposing only "is this tenant
-- in good standing" — never the underlying status enum or any
-- Stripe IDs.
CREATE VIEW tenant_lookup AS
SELECT
  id,
  subdomain,
  name,
  timezone,
  (
    platform_subscription_status = 'active'
    OR (
      platform_subscription_status = 'trial'
      AND (trial_ends_at IS NULL OR trial_ends_at > now())
    )
  ) AS is_billing_ok
FROM tenants;

COMMENT ON VIEW tenant_lookup IS
  'Safe subdomain-resolution view. Exposes routing-safe columns only; '
  'never billing fields. Runtime role gets SELECT here, not on tenants.';

-- ============================================================
-- LAYER 1: FOUNDATION — users
-- ============================================================

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           text NOT NULL
                  CHECK (
                    email = lower(btrim(email))
                    AND btrim(email) <> ''
                    AND email !~ '\s'
                  ),
  password_hash   text NOT NULL,
  first_name      text NOT NULL
                  CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name       text NOT NULL
                  CHECK (btrim(last_name) <> '' AND last_name = btrim(last_name)),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id),  -- needed for composite FKs from role tables
  -- Required by the members composite FK in migration 003: ensures a
  -- linked member's email always matches the user's email, so login
  -- identity and member identity can't drift apart.
  UNIQUE (tenant_id, id, email)
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Tables exist (expected: 2 rows — tenants, users):
--      SELECT tablename FROM pg_tables
--       WHERE schemaname = 'public' AND tablename IN ('tenants', 'users')
--       ORDER BY tablename;
--
-- 2. View exists (expected: 1 row — tenant_lookup):
--      SELECT viewname FROM pg_views
--       WHERE schemaname = 'public' AND viewname = 'tenant_lookup';
--
-- 3. RLS enabled + forced on users (expected: t/t):
--      SELECT rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'users';
--
-- 4. RLS enabled on tenants but NOT forced (expected: t/f).
--    No policy = blanket deny for non-BYPASSRLS roles (defense in
--    depth against Supabase default grants on anon/authenticated).
--    FORCE intentionally OFF so the table owner can still administer
--    via migrations and cross-tenant ops.
--      SELECT rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'tenants';
--
-- 5. Tenant isolation policy on users (expected: 1 row):
--      SELECT policyname FROM pg_policies
--       WHERE tablename = 'users' AND policyname = 'users_tenant_isolation';
--
-- 6. Set-updated-at triggers present (expected: 2 rows):
--      SELECT event_object_table, trigger_name
--        FROM information_schema.triggers
--       WHERE trigger_name IN ('tenants_set_updated_at', 'users_set_updated_at')
--       ORDER BY trigger_name;
--
-- 7. Subdomain reserved-name CHECK rejects bad input (the INSERT must
--    error; ROLLBACK cleans up if for some reason it didn't):
--      BEGIN;
--      INSERT INTO tenants (subdomain, name, timezone)
--        VALUES ('admin', 'Reserved test', 'America/New_York');
--      ROLLBACK;
--
-- 8. tenant_lookup hides billing columns (expected: only id, subdomain,
--    name, timezone, is_billing_ok — no platform_stripe_*):
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'tenant_lookup'
--       ORDER BY ordinal_position;
