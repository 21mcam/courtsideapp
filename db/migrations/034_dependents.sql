-- Migration 034 — family accounts: dependents (customer-side slice 5)
--
-- Design: docs/design/FAMILY_ACCOUNTS.md (approved 2026-10-08).
--
-- A `dependent` is a person an account holder (member) books FOR — a
-- kid. Dependents own nothing: no login, no email, no subscription, no
-- credits. One subscription per household; every booking keeps
-- member_id = who pays (credits, ledger, plan restrictions all
-- untouched) and gains dependent_id = who attends (NULL = the member).
--
-- This migration carries the WHOLE family schema so it's one by-hand
-- apply; the app adopts it over three PRs (family management → booking
-- for a kid → per-kid waivers). Everything here is additive or
-- behaviour-preserving for code that doesn't know about dependents:
--   * new nullable dependent_id columns default NULL;
--   * the class-roster unique index swap is equivalent while every
--     dependent_id is NULL.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 034_dependents.sql
-- Depends on: 003 (members), 007 (bookings), 008 (class_bookings),
--             011 (app_runtime default privileges), 023 (waivers).

-- ============================================================
-- 1. dependents
-- ============================================================

CREATE TABLE dependents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL,
  first_name  text NOT NULL
              CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name   text NOT NULL
              CHECK (btrim(last_name) <> '' AND last_name = btrim(last_name)),
  -- Optional; enables age-gated classes ("12U clinic") later.
  birth_year  integer CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  -- "Remove" = deactivate. Rows are never deleted while bookings
  -- reference them (FKs below are RESTRICT), so history keeps names.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Target for the (tenant_id, dependent_id, member_id) FKs: a booking
  -- can only name a dependent that belongs to the booking's member.
  UNIQUE (tenant_id, id, member_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX dependents_member_idx ON dependents (tenant_id, member_id) WHERE active;

CREATE TRIGGER dependents_set_updated_at
  BEFORE UPDATE ON dependents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE dependents FORCE ROW LEVEL SECURITY;
CREATE POLICY dependents_tenant_isolation ON dependents
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Explicit (011's default privileges cover it when applied as the
-- same role; this makes the grant independent of who applies it).
GRANT SELECT, INSERT, UPDATE, DELETE ON dependents TO app_runtime;

COMMENT ON TABLE dependents IS
  'Family members an account holder (member) books for. No login, '
  'email, subscription or credits — the member pays. See '
  'docs/design/FAMILY_ACCOUNTS.md.';

-- ============================================================
-- 2. bookings / class_bookings — who attends
-- ============================================================

ALTER TABLE bookings ADD COLUMN dependent_id uuid;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_dependent_fk
  FOREIGN KEY (tenant_id, dependent_id, member_id)
  REFERENCES dependents (tenant_id, id, member_id) ON DELETE RESTRICT;
-- A walk-in (no member) can't name a dependent. (The composite FK
-- alone wouldn't catch it — a NULL member_id makes it not enforce.)
ALTER TABLE bookings
  ADD CONSTRAINT bookings_dependent_needs_member
  CHECK (dependent_id IS NULL OR member_id IS NOT NULL);

ALTER TABLE class_bookings ADD COLUMN dependent_id uuid;
ALTER TABLE class_bookings
  ADD CONSTRAINT class_bookings_dependent_fk
  FOREIGN KEY (tenant_id, dependent_id, member_id)
  REFERENCES dependents (tenant_id, id, member_id) ON DELETE RESTRICT;
ALTER TABLE class_bookings
  ADD CONSTRAINT class_bookings_dependent_needs_member
  CHECK (dependent_id IS NULL OR member_id IS NOT NULL);

CREATE INDEX bookings_dependent_idx
  ON bookings (tenant_id, dependent_id) WHERE dependent_id IS NOT NULL;
CREATE INDEX class_bookings_dependent_idx
  ON class_bookings (tenant_id, dependent_id) WHERE dependent_id IS NOT NULL;

-- Siblings in the same class: one spot per PARTICIPANT (member or each
-- dependent), not per member. Identical to the old index while every
-- dependent_id is NULL.
DROP INDEX class_bookings_member_per_instance_unique;
CREATE UNIQUE INDEX class_bookings_participant_per_instance_unique
  ON class_bookings (tenant_id, class_instance_id, member_id,
                     COALESCE(dependent_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE member_id IS NOT NULL AND status <> 'cancelled';

-- ============================================================
-- 3. waiver_signatures — per-kid signatures (only used when the
--    facility requires waivers)
-- ============================================================

ALTER TABLE waiver_signatures ADD COLUMN dependent_id uuid;
ALTER TABLE waiver_signatures
  ADD CONSTRAINT waiver_signatures_dependent_fk
  FOREIGN KEY (tenant_id, dependent_id, member_id)
  REFERENCES dependents (tenant_id, id, member_id) ON DELETE RESTRICT;
ALTER TABLE waiver_signatures
  ADD CONSTRAINT waiver_signatures_dependent_needs_member
  CHECK (dependent_id IS NULL OR member_id IS NOT NULL);

CREATE INDEX waiver_signatures_dependent_idx
  ON waiver_signatures (tenant_id, dependent_id, waiver_version)
  WHERE dependent_id IS NOT NULL;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
--   SELECT count(*) FROM dependents;                       -- 0, no error
--   SELECT indexname FROM pg_indexes
--    WHERE indexname IN ('class_bookings_member_per_instance_unique',
--                        'class_bookings_participant_per_instance_unique');
--   -- expect: only the participant index
--
--   SET ROLE app_runtime;
--   SELECT * FROM dependents LIMIT 1;  -- no rows, no permission error
--   RESET ROLE;
