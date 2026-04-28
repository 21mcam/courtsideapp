-- Migration 012 — create_tenant_with_owner SECURITY DEFINER function
--
-- Tenant signup is a privileged op: app_runtime has REVOKE on the
-- tenants table (migration 011), so the runtime can't INSERT directly.
-- Rather than give the web process a privileged DB connection (blast
-- radius: read/write everything, bypass RLS), this migration adds a
-- narrow function that performs exactly the inserts a tenant signup
-- needs:
--
--   1. Creates a tenants row
--   2. Creates the owner user in that tenant
--   3. Creates a tenant_admins row with role='owner'
--   4. Creates a default booking_policies singleton
--
-- All atomic — the function call is one statement and Postgres
-- wraps it in an implicit transaction. Any insert failing rolls
-- back the whole thing.
--
-- SECURITY DEFINER + SET search_path = public, pg_temp pins the
-- search path so a poisoned user-schema can't intercept resolution.
-- Only EXECUTE is granted to app_runtime; direct tenants access
-- stays revoked.
--
-- The app must hash the owner password before calling this function
-- (we don't put bcrypt in PL/pgSQL).
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 012_create_tenant_with_owner.sql
-- Depends on: 001–011.
-- Verify: see commented block at end.

CREATE OR REPLACE FUNCTION create_tenant_with_owner(
  p_subdomain           text,
  p_name                text,
  p_timezone            text,
  p_owner_email         text,
  p_owner_password_hash text,
  p_owner_first_name    text,
  p_owner_last_name     text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, admin_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id uuid;
  v_user_id   uuid;
  v_admin_id  uuid;
BEGIN
  INSERT INTO tenants (subdomain, name, timezone)
  VALUES (p_subdomain, p_name, p_timezone)
  RETURNING id INTO v_tenant_id;

  -- Set the GUC so subsequent inserts pass FORCE RLS even if the
  -- function owner doesn't have BYPASSRLS. Belt and suspenders —
  -- in practice the migration role does have BYPASSRLS in Supabase,
  -- but we don't want this function's correctness to depend on that.
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  INSERT INTO users (
    tenant_id, email, password_hash, first_name, last_name
  )
  VALUES (
    v_tenant_id, p_owner_email, p_owner_password_hash,
    p_owner_first_name, p_owner_last_name
  )
  RETURNING id INTO v_user_id;

  INSERT INTO tenant_admins (tenant_id, user_id, role)
  VALUES (v_tenant_id, v_user_id, 'owner')
  RETURNING id INTO v_admin_id;

  -- Default booking_policies singleton. Tenants edit these via the
  -- admin UI (Phase 2+). Defaults from the schema's CHECK clauses
  -- give sensible starting values.
  INSERT INTO booking_policies (tenant_id) VALUES (v_tenant_id);

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_admin_id;
END;
$$;

REVOKE ALL ON FUNCTION create_tenant_with_owner(
  text, text, text, text, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION create_tenant_with_owner(
  text, text, text, text, text, text, text
) TO app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Function exists with SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc
--       WHERE proname = 'create_tenant_with_owner';
--      -- expected: 1 row, prosecdef = t
--
-- 2. app_runtime has EXECUTE; PUBLIC does NOT:
--      SELECT has_function_privilege(
--        'app_runtime',
--        'create_tenant_with_owner(text,text,text,text,text,text,text)',
--        'EXECUTE'
--      );
--      -- expected: t
--      SELECT has_function_privilege(
--        'public',
--        'create_tenant_with_owner(text,text,text,text,text,text,text)',
--        'EXECUTE'
--      );
--      -- expected: f
--
-- 3. Happy path: function creates all four rows.
--      BEGIN;
--      DO $$
--      DECLARE r record;
--      BEGIN
--        SELECT * FROM create_tenant_with_owner(
--          'verify-012',
--          'Verify 012',
--          'America/New_York',
--          'verify-012@example.com',
--          '$2a$10$dummyhashthatisthecorrectlength.dummy',
--          'V', 'V'
--        ) INTO r;
--        RAISE NOTICE 'tenant_id=%, user_id=%, admin_id=%',
--          r.tenant_id, r.user_id, r.admin_id;
--        -- All four rows should exist
--        IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = r.tenant_id) THEN
--          RAISE EXCEPTION 'FAIL: tenant row missing';
--        END IF;
--        IF NOT EXISTS (SELECT 1 FROM users WHERE id = r.user_id) THEN
--          RAISE EXCEPTION 'FAIL: user row missing';
--        END IF;
--        IF NOT EXISTS (SELECT 1 FROM tenant_admins WHERE id = r.admin_id) THEN
--          RAISE EXCEPTION 'FAIL: tenant_admins row missing';
--        END IF;
--        IF NOT EXISTS (SELECT 1 FROM booking_policies WHERE tenant_id = r.tenant_id) THEN
--          RAISE EXCEPTION 'FAIL: booking_policies row missing';
--        END IF;
--        RAISE NOTICE 'PASS: all four rows created';
--      END;
--      $$;
--      ROLLBACK;
--
-- 4. Reserved subdomain rejected (CHECK on tenants.subdomain):
--      BEGIN;
--      DO $$
--      BEGIN
--        BEGIN
--          PERFORM create_tenant_with_owner(
--            'admin', 'Reserved', 'America/New_York',
--            'r@example.com', '$2a$10$dummy.dummy.dummy.dummy.dummy.dummy.dummy',
--            'R', 'R'
--          );
--          RAISE EXCEPTION 'FAIL: reserved subdomain accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: reserved subdomain rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. Duplicate subdomain rejected (UNIQUE on tenants.subdomain):
--      BEGIN;
--      DO $$
--      DECLARE r record;
--      BEGIN
--        SELECT * FROM create_tenant_with_owner(
--          'verify-012-dup', 'A', 'America/New_York',
--          'a@example.com', '$2a$10$dummyhashthatisthecorrectlength.dummy',
--          'A', 'A'
--        ) INTO r;
--        BEGIN
--          PERFORM create_tenant_with_owner(
--            'verify-012-dup', 'B', 'America/New_York',
--            'b@example.com', '$2a$10$dummyhashthatisthecorrectlength.dummy',
--            'B', 'B'
--          );
--          RAISE EXCEPTION 'FAIL: duplicate subdomain accepted';
--        EXCEPTION WHEN unique_violation THEN
--          RAISE NOTICE 'PASS: duplicate subdomain rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
