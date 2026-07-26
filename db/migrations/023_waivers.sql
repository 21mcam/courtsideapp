-- Migration 023 — liability waivers v1
--
-- Every commercial competitor has digital waivers, and a baseball
-- facility (minors swinging bats) treats them as mandatory. Two
-- pieces:
--
--   1. Waiver config on booking_policies (singleton per tenant — the
--      natural home for booking-gating rules):
--        * waiver_required — gate is off by default.
--        * waiver_text     — the tenant-authored waiver body.
--        * waiver_version  — bumped APP-SIDE whenever the admin
--          changes waiver_text (policies update controller).
--          Enforcement requires a signature matching the CURRENT
--          version, so a text change re-prompts everyone.
--
--   2. waiver_signatures — append-only record of who signed which
--      version. Either a member (member_id) or a walk-in
--      (customer_email), never neither. Guardian fields support
--      signing on behalf of a minor. Signatures are legal records:
--      the runtime role gets INSERT + SELECT but NOT UPDATE/DELETE
--      (revoked below — migration 011's default privileges would
--      otherwise grant full CRUD).
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 023_waivers.sql
-- Depends on: 003 (members), 006 (booking_policies), 011 (app_runtime).
-- Verify: see commented block at end.

-- ============================================================
-- 1. Waiver config on booking_policies
-- ============================================================

ALTER TABLE booking_policies
  ADD COLUMN waiver_required boolean NOT NULL DEFAULT false,
  ADD COLUMN waiver_text     text,
  ADD COLUMN waiver_version  integer NOT NULL DEFAULT 1
             CONSTRAINT booking_policies_waiver_version_positive
             CHECK (waiver_version > 0);

COMMENT ON COLUMN booking_policies.waiver_version IS
  'Bumped by the app whenever waiver_text changes. Enforcement '
  'requires a waiver_signatures row at THIS version, so editing the '
  'text re-prompts every member and walk-in.';

-- ============================================================
-- 2. waiver_signatures (append-only)
-- ============================================================

-- One row per act of signing. Members may accumulate one row per
-- version (re-signing after a text change); duplicate rows for the
-- same (person, version) are harmless — enforcement only asks
-- "does at least one current-version row exist".
--
-- member_id FK is ON DELETE RESTRICT (matches bookings): a signature
-- is a legal record and must not silently vanish with a member row.
-- Tenant deletion still cascades via the tenant_id FK.
CREATE TABLE waiver_signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- who signed: a member, a walk-in customer (by email), or a member
  -- record that also has an email captured. At least one required.
  member_id       uuid,
  customer_email  text CHECK (customer_email IS NULL
                              OR (btrim(customer_email) <> ''
                                  AND customer_email = lower(customer_email))),
  -- the typed full legal name (the "signature")
  signer_name     text NOT NULL CHECK (btrim(signer_name) <> ''),
  -- signing on behalf of a minor: guardian_name is the adult who
  -- signed; signer_name remains the participant's name.
  guardian_name   text CHECK (guardian_name IS NULL OR btrim(guardian_name) <> ''),
  is_minor        boolean NOT NULL DEFAULT false,
  waiver_version  integer NOT NULL CHECK (waiver_version > 0),
  signed_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id)
    REFERENCES members(tenant_id, id) ON DELETE RESTRICT,
  CHECK (member_id IS NOT NULL OR customer_email IS NOT NULL),
  -- a minor's waiver must carry the guardian who signed it
  CHECK ((NOT is_minor) OR guardian_name IS NOT NULL)
);

-- Enforcement lookups: "does person X have a version-N signature".
CREATE INDEX waiver_signatures_member_idx
  ON waiver_signatures (tenant_id, member_id, waiver_version)
  WHERE member_id IS NOT NULL;

CREATE INDEX waiver_signatures_customer_idx
  ON waiver_signatures (tenant_id, customer_email, waiver_version)
  WHERE customer_email IS NOT NULL;

-- Admin list view: newest first.
CREATE INDEX waiver_signatures_signed_at_idx
  ON waiver_signatures (tenant_id, signed_at DESC);

-- No updated_at / set_updated_at trigger: rows are immutable records
-- (same convention as credit_ledger_entries).

ALTER TABLE waiver_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiver_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY waiver_signatures_tenant_isolation ON waiver_signatures
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- 3. Privileges — signatures are append-only for the runtime role
-- ============================================================

-- Migration 011's ALTER DEFAULT PRIVILEGES auto-granted full CRUD to
-- app_runtime when the table above was created. Walk that back:
-- signature rows are written once and read forever.
REVOKE UPDATE, DELETE ON waiver_signatures FROM app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. RLS enabled + forced:
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'waiver_signatures';
--      -- expected: 1 row, t / t
--
-- 2. Runtime can INSERT + SELECT but not UPDATE/DELETE:
--      SELECT has_table_privilege('app_runtime', 'waiver_signatures', 'INSERT'); -- t
--      SELECT has_table_privilege('app_runtime', 'waiver_signatures', 'SELECT'); -- t
--      SELECT has_table_privilege('app_runtime', 'waiver_signatures', 'UPDATE'); -- f
--      SELECT has_table_privilege('app_runtime', 'waiver_signatures', 'DELETE'); -- f
--
-- 3. CHECKs hold — neither identity, and minor-without-guardian, both
--    rejected:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-023', 'Verify 023', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        BEGIN
--          INSERT INTO waiver_signatures
--            (tenant_id, signer_name, waiver_version)
--            VALUES (v_tenant_id, 'No Identity', 1);
--          RAISE EXCEPTION 'FAIL: signature without member/email accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: identityless signature rejected';
--        END;
--        BEGIN
--          INSERT INTO waiver_signatures
--            (tenant_id, customer_email, signer_name, is_minor, waiver_version)
--            VALUES (v_tenant_id, 'kid@example.com', 'Junior', true, 1);
--          RAISE EXCEPTION 'FAIL: minor without guardian accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: minor without guardian rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
