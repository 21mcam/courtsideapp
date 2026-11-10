-- Migration 036 — booking slot interval (start-time grid)
--
-- /api/availability used to space slot start times by the service's
-- own length: an empty cage opening at 10:00 offered a 1-hour service
-- at 10:00, 11:00, 12:00 and a 1.5-hour one at 10:00, 11:30, 13:00.
-- Setmore (what Momentum runs on today) offers every service on a
-- fixed 30-minute grid, and a month of Momentum's real bookings had
-- 163 multi-slot sessions starting off their own duration grid (a
-- 1-hour session at 12:30, etc.) — times Courtside couldn't offer.
--
-- booking_policies.slot_interval_minutes sets how often start times
-- appear, for every rental offering, anchored to the resource's
-- opening time:
--
--   * 30 (default) — starts every 30 min, any service length
--   * 5..60        — any of the listed cadences
--   * NULL         — "match each service's length": the old
--                    back-to-back behavior, for tenants that sell
--                    fixed blocks (e.g. hourly ice time)
--
-- Existing rows get 30 — that's the behavior change this migration is
-- for. The grid only shapes what availability ADVERTISES; the create
-- endpoints don't enforce it (admin bookings snap to 15 min).
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 036_slot_interval.sql
-- Depends on: 006 (booking_policies).

ALTER TABLE booking_policies
  ADD COLUMN slot_interval_minutes integer DEFAULT 30
    CONSTRAINT booking_policies_slot_interval_allowed
    CHECK (slot_interval_minutes IS NULL
           OR slot_interval_minutes IN (5, 10, 15, 20, 30, 60));

COMMENT ON COLUMN booking_policies.slot_interval_minutes IS
  'How often bookable start times appear (minutes), anchored to the '
  'resource opening time. NULL = match each offering''s duration '
  '(back-to-back blocks).';

-- Verify (commented for live apply):
--
--   SELECT slot_interval_minutes FROM booking_policies LIMIT 1;
--   -- expect: 30
