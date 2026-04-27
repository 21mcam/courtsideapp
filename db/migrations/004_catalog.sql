-- Migration 004 — catalog: resources, offerings, offering_resources
--
-- The bookable surface of a tenant. An offering is the admin's
-- template ("30-min cage, 3 credits, $30") and resources are the
-- physical things ("Cage 1"). offering_resources is the many-to-many
-- between them, with an `active` flag for soft-removal that keeps
-- historical bookings valid.
--
-- One field, one meaning: capacity = 1 means rental, capacity > 1
-- means class. No separate `kind` column — see CLAUDE.md.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 004_catalog.sql
-- Depends on: 001 (set_updated_at, category_key), 002 (tenants).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 2: CATALOG — resources
-- ============================================================

CREATE TABLE resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL
                  CHECK (btrim(name) <> '' AND name = btrim(name)),
  display_order   integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER resources_set_updated_at
  BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_tenant_isolation ON resources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- offerings
-- ============================================================

CREATE TABLE offerings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL
                        CHECK (btrim(name) <> '' AND name = btrim(name)),
  category              category_key NOT NULL,
  duration_minutes      integer NOT NULL CHECK (duration_minutes > 0),
  credit_cost           integer NOT NULL CHECK (credit_cost >= 0),
  dollar_price          integer NOT NULL CHECK (dollar_price >= 0),  -- cents
  capacity              integer NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  -- capacity = 1 means rental (resource-exclusive booking)
  -- capacity > 1 means class (multi-roster booking)
  allow_member_booking  boolean NOT NULL DEFAULT true,
  allow_public_booking  boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  display_order         integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- An active offering must be bookable by at least one audience.
  -- Use active = false for "draft" offerings.
  CHECK (NOT active OR allow_member_booking OR allow_public_booking)
);

CREATE TRIGGER offerings_set_updated_at
  BEFORE UPDATE ON offerings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offerings FORCE ROW LEVEL SECURITY;
CREATE POLICY offerings_tenant_isolation ON offerings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- offering_resources
-- ============================================================

-- One offering can be valid for multiple resources, and one resource
-- can host multiple offerings. Tenant-leading PK for query ergonomics
-- and RLS.
--
-- The `active` flag exists because bookings reference this row via
-- composite FK (offering_id + resource_id must be a valid pairing).
-- That means we can't delete a row once any booking exists. Admins
-- "remove" a resource from an offering by setting active = false;
-- new bookings check the flag, historical bookings keep referencing
-- the row.
CREATE TABLE offering_resources (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id  uuid NOT NULL,
  resource_id  uuid NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offering_id, resource_id),
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER offering_resources_set_updated_at
  BEFORE UPDATE ON offering_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX offering_resources_tenant_resource_idx
  ON offering_resources (tenant_id, resource_id);

ALTER TABLE offering_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY offering_resources_tenant_isolation ON offering_resources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. All three tables present, all RLS-forced (expected: 3 rows, t/t each):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public'
--         AND tablename IN ('resources', 'offerings', 'offering_resources')
--       ORDER BY tablename;
--
-- 2. Isolation policies present (expected: 3 rows):
--      SELECT tablename, policyname FROM pg_policies
--       WHERE tablename IN ('resources', 'offerings', 'offering_resources')
--       ORDER BY tablename;
--
-- 3. set_updated_at triggers present (expected: 3 rows):
--      SELECT event_object_table, trigger_name
--        FROM information_schema.triggers
--       WHERE trigger_name IN
--             ('resources_set_updated_at', 'offerings_set_updated_at',
--              'offering_resources_set_updated_at')
--       ORDER BY trigger_name;
--
-- 4. category_key domain rejects bad input on offerings.category
--    (the inner INSERT must error; outer ROLLBACK cleans up):
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-004', 'Verify 004', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        BEGIN
--          INSERT INTO offerings
--            (tenant_id, name, category, duration_minutes, credit_cost, dollar_price)
--            VALUES (v_tenant_id, 'Bad', 'BAD CATEGORY', 30, 1, 0);
--          RAISE EXCEPTION 'FAIL: domain accepted bad category';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: domain rejected bad category';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. Active offering with no booking audience is rejected (CHECK):
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-004b', 'Verify 004b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        BEGIN
--          INSERT INTO offerings
--            (tenant_id, name, category, duration_minutes, credit_cost,
--             dollar_price, allow_member_booking, allow_public_booking, active)
--            VALUES (v_tenant_id, 'No audience', 'cage-time', 30, 1, 0,
--                    false, false, true);
--          RAISE EXCEPTION 'FAIL: active+no-audience offering accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: active+no-audience offering rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
