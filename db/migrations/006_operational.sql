-- Migration 006 — operational rules: operating_hours, blackouts,
--                   booking_policies
--
-- The "when can this thing be booked" layer.
--   * operating_hours: per-resource per-day-of-week recurring open
--     hours, in local time (DST-stable). Multiple rows per resource+day
--     for split shifts; exclusion constraint prevents overlaps.
--   * blackouts: time ranges when something is NOT bookable. Targets
--     a resource, an offering, or the whole facility (both null).
--   * booking_policies: singleton per tenant — cancellation, no-show,
--     advance-booking-window rules.
--
-- DST gotcha (CLAUDE.md #6): operating_hours uses `time` (local,
-- DST-stable); blackouts uses `timestamptz` (absolute moments).
-- Both are intentional, neither is wrong.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 006_operational.sql
-- Depends on: 004 (resources, offerings).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 4: OPERATIONAL — operating_hours
-- ============================================================

-- One resource, one day-of-week, one time range = one row.
-- Multiple rows allowed per resource+day for split shifts (e.g.
-- 9am-12pm and 2pm-9pm with a lunch break), but they cannot overlap
-- (enforced by exclusion constraint).
-- A resource with NO operating_hours rows for a given day is closed
-- that day (no booking allowed).
-- day_of_week: 0=Sun, 1=Mon, ... 6=Sat (matches JS Date.getDay()
-- and Postgres EXTRACT(DOW)).
-- open_time/close_time use `time` not timestamptz: operating hours
-- are local times that don't shift with DST.
-- hours_seconds is a generated int4range (in seconds-since-midnight)
-- used by the exclusion constraint to prevent overlapping ranges.
CREATE TABLE operating_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id     uuid NOT NULL,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time       time NOT NULL,
  close_time      time NOT NULL,
  hours_seconds   int4range GENERATED ALWAYS AS (
                    int4range(
                      extract(epoch FROM open_time)::int4,
                      extract(epoch FROM close_time)::int4,
                      '[)'
                    )
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
  CHECK (close_time > open_time),
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    day_of_week WITH =,
    hours_seconds WITH &&
  )
);

CREATE INDEX operating_hours_resource_day_idx
  ON operating_hours (tenant_id, resource_id, day_of_week);

CREATE TRIGGER operating_hours_set_updated_at
  BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE operating_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY operating_hours_tenant_isolation ON operating_hours
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- blackouts
-- ============================================================

-- A blackout is a time range when something is NOT bookable.
-- Targeting:
--   - resource_id set, offering_id null → blackout that resource
--   - offering_id set, resource_id null → blackout that offering
--   - both null → facility-wide blackout (e.g. "Christmas Day")
-- Both set is forbidden (CHECK).
--
-- Common UX patterns map to blackout rows:
--   - Admin clicks "Pause this offering until [date]" on the offering
--     admin form → INSERT blackouts with offering_id, starts_at = now(),
--     ends_at = picked date.
--   - Admin clicks "Cage 3 out of service until [date]" → same idea
--     with resource_id.
--   - Admin clicks "Closed for the holiday on [date range]" → both null.
CREATE TABLE blackouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id     uuid,
  offering_id     uuid,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  created_by      uuid,         -- user_id of admin. No FK; soft reference.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (NOT (resource_id IS NOT NULL AND offering_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX blackouts_tenant_time_idx
  ON blackouts (tenant_id, starts_at, ends_at);

CREATE INDEX blackouts_resource_time_idx
  ON blackouts (tenant_id, resource_id, starts_at)
  WHERE resource_id IS NOT NULL;

CREATE INDEX blackouts_offering_time_idx
  ON blackouts (tenant_id, offering_id, starts_at)
  WHERE offering_id IS NOT NULL;

CREATE TRIGGER blackouts_set_updated_at
  BEFORE UPDATE ON blackouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE blackouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blackouts FORCE ROW LEVEL SECURITY;
CREATE POLICY blackouts_tenant_isolation ON blackouts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- booking_policies (singleton per tenant)
-- ============================================================

-- One row per tenant. Booking policy is intentionally singleton
-- (no per-offering overrides in v1) — keeps booking validation
-- simple. Per-offering overrides are post-v1.
CREATE TABLE booking_policies (
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- cancellation policy (3-field model, no multi-tier refunds in v1)
  free_cancel_hours_before        integer NOT NULL DEFAULT 24
                                  CHECK (free_cancel_hours_before >= 0),
  partial_refund_hours_before     integer
                                  CHECK (partial_refund_hours_before IS NULL
                                         OR partial_refund_hours_before >= 0),
  partial_refund_percent          integer
                                  CHECK (partial_refund_percent IS NULL
                                         OR (partial_refund_percent BETWEEN 0 AND 100)),
  -- no-show policy
  no_show_action                  text NOT NULL DEFAULT 'none'
                                  CHECK (no_show_action IN ('none', 'forfeit_credits',
                                                             'charge_fee', 'block_member')),
  no_show_fee_cents               integer
                                  CHECK (no_show_fee_cents IS NULL OR no_show_fee_cents >= 0),
  -- advance booking window
  min_advance_booking_minutes     integer NOT NULL DEFAULT 0
                                  CHECK (min_advance_booking_minutes >= 0),
  max_advance_booking_days        integer NOT NULL DEFAULT 30
                                  CHECK (max_advance_booking_days > 0),
  -- self-service modification
  allow_member_self_cancel        boolean NOT NULL DEFAULT true,
  allow_customer_self_cancel      boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  -- partial refund config is internally consistent
  CHECK (
    (partial_refund_hours_before IS NULL AND partial_refund_percent IS NULL)
    OR
    (partial_refund_hours_before IS NOT NULL AND partial_refund_percent IS NOT NULL
     AND partial_refund_hours_before <= free_cancel_hours_before)
  ),
  -- if no_show_action is charge_fee, fee must be set
  CHECK (
    (no_show_action <> 'charge_fee')
    OR (no_show_fee_cents IS NOT NULL AND no_show_fee_cents > 0)
  ),
  -- advance booking window is internally consistent: min advance
  -- can't exceed max advance.
  CHECK (min_advance_booking_minutes <= max_advance_booking_days * 1440)
);

CREATE TRIGGER booking_policies_set_updated_at
  BEFORE UPDATE ON booking_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE booking_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_policies_tenant_isolation ON booking_policies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Three tables, all RLS-forced (expected: 3 rows, t/t each):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public'
--         AND tablename IN ('operating_hours', 'blackouts', 'booking_policies')
--       ORDER BY tablename;
--
-- 2. Operating hours exclusion rejects overlapping shifts on same
--    resource+day. Second INSERT must fail.
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid; v_resource_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-006', 'Verify 006', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Cage 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO operating_hours
--          (tenant_id, resource_id, day_of_week, open_time, close_time)
--          VALUES (v_tenant_id, v_resource_id, 1, '09:00', '12:00');
--        BEGIN
--          INSERT INTO operating_hours
--            (tenant_id, resource_id, day_of_week, open_time, close_time)
--            VALUES (v_tenant_id, v_resource_id, 1, '11:00', '13:00');
--          RAISE EXCEPTION 'FAIL: overlapping operating_hours accepted';
--        EXCEPTION WHEN exclusion_violation THEN
--          RAISE NOTICE 'PASS: overlapping operating_hours rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 3. Blackouts CHECK rejects "both resource_id and offering_id set":
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-006b', 'Verify 006b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Cage 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost, dollar_price)
--          VALUES (v_tenant_id, 'Half hour', 'cage-time', 30, 1, 0)
--          RETURNING id INTO v_offering_id;
--        BEGIN
--          INSERT INTO blackouts
--            (tenant_id, resource_id, offering_id, starts_at, ends_at)
--            VALUES (v_tenant_id, v_resource_id, v_offering_id,
--                    now(), now() + interval '1 day');
--          RAISE EXCEPTION 'FAIL: blackout with both targets accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: blackout with both targets rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 4. booking_policies CHECK rejects partial-refund config without
--    both hours and percent set:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-006c', 'Verify 006c', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        BEGIN
--          INSERT INTO booking_policies (tenant_id, partial_refund_hours_before)
--            VALUES (v_tenant_id, 12);  -- percent missing
--          RAISE EXCEPTION 'FAIL: half-set partial-refund accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: half-set partial-refund rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
