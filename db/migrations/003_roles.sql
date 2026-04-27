-- Migration 003 — role tables: tenant_admins, members
--
-- Same user can be both a tenant_admin and a member (e.g. a facility
-- owner who tests flows as a member). The user table is the only
-- place login credentials live; these two tables attach roles to a
-- user.
--
-- Worth flagging:
--   * tenant_admins has no updated_at column — role rows are created
--     once and either deleted or left alone, so there's no update
--     surface to track.
--   * members.user_id is nullable: admins can create member rows
--     manually (invite flow, data import) before the person sets up
--     a login.
--   * members composite FK on (tenant_id, user_id, email) references
--     users(tenant_id, id, email) with ON UPDATE CASCADE — a user's
--     email change propagates to the linked member, and the FK is
--     "inactive" when user_id IS NULL (composite FKs with any null
--     column don't enforce).
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 003_roles.sql
-- Depends on: 002
-- Verify: see commented block at end.

-- ============================================================
-- tenant_admins
-- ============================================================

-- A user can have either or both of these role rows. One user, many
-- roles: a facility owner can be both an admin AND a member of their
-- own facility (testing flows, training as a member). Distinct roles,
-- single login.
CREATE TABLE tenant_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL DEFAULT 'admin'
              CHECK (role IN ('admin', 'owner')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE tenant_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_admins_tenant_isolation ON tenant_admins
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- members
-- ============================================================

-- Members are people who hold (or could hold) a paid subscription.
-- user_id is nullable so admins can manually create member records
-- before the person sets up a login (invite flow, data import).
-- ON DELETE RESTRICT for the user FK because deleting a user with
-- linked member history should be intentional, not cascading.
CREATE TABLE members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid,
  email           text NOT NULL
                  CHECK (
                    email = lower(btrim(email))
                    AND btrim(email) <> ''
                    AND email !~ '\s'
                  ),
  first_name      text NOT NULL
                  CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name       text NOT NULL
                  CHECK (btrim(last_name) <> '' AND last_name = btrim(last_name)),
  phone           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id),
  -- Composite FK including email: when a member is linked to a user
  -- (user_id IS NOT NULL), the emails MUST match. This prevents a
  -- buggy invite/link flow from silently attaching the wrong login
  -- identity to a member's credits and bookings. ON UPDATE CASCADE
  -- so a user email change auto-propagates to the linked member.
  -- When user_id IS NULL (manual/imported members), the FK is
  -- inactive — composite FKs with any null column don't enforce.
  FOREIGN KEY (tenant_id, user_id, email)
    REFERENCES users(tenant_id, id, email)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX members_tenant_user_unique
  ON members (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TRIGGER members_set_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_tenant_isolation ON members
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Tables exist (expected: 2 rows — members, tenant_admins):
--      SELECT tablename FROM pg_tables
--       WHERE schemaname = 'public' AND tablename IN ('tenant_admins', 'members')
--       ORDER BY tablename;
--
-- 2. RLS enabled + forced on both (expected: t/t for each):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename IN ('tenant_admins', 'members')
--       ORDER BY tablename;
--
-- 3. Isolation policies present (expected: 2 rows):
--      SELECT tablename, policyname FROM pg_policies
--       WHERE tablename IN ('tenant_admins', 'members')
--       ORDER BY tablename;
--
-- 4. members has set_updated_at trigger; tenant_admins does NOT
--    (it has no updated_at column). Expected: 1 row (members only).
--      SELECT event_object_table, trigger_name
--        FROM information_schema.triggers
--       WHERE trigger_name IN
--             ('tenant_admins_set_updated_at', 'members_set_updated_at')
--       ORDER BY trigger_name;
--
-- 5. members composite FK rejects email mismatch. The inner BEGIN/
--    EXCEPTION inside the DO block traps the expected FK violation;
--    the outer BEGIN/ROLLBACK undoes everything else.
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id uuid;
--        v_user_id   uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-003', 'Verify 003', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
--          VALUES (v_tenant_id, 'a@example.com', 'x', 'A', 'A')
--          RETURNING id INTO v_user_id;
--        BEGIN
--          INSERT INTO members (tenant_id, user_id, email, first_name, last_name)
--            VALUES (v_tenant_id, v_user_id, 'mismatch@example.com', 'A', 'A');
--          RAISE EXCEPTION 'FAIL: composite FK did not reject mismatched email';
--        EXCEPTION
--          WHEN foreign_key_violation THEN
--            RAISE NOTICE 'PASS: composite FK rejected mismatched email';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 6. members.user_id NULL bypasses composite FK (insert succeeds):
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id uuid;
--        v_member_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-003b', 'Verify 003b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_tenant_id, 'walkin@example.com', 'Walk', 'In')
--          RETURNING id INTO v_member_id;
--        RAISE NOTICE 'PASS: member created with NULL user_id (id=%)', v_member_id;
--      END;
--      $$;
--      ROLLBACK;
