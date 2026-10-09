-- Migration 033 — booking reminder emails (customer-side slice 3)
--
-- A reminder email goes out N hours before each confirmed booking —
-- rentals AND class spots, members AND walk-ins — sent by the Node
-- scheduler's reminder sweep (src/controllers/reminders.js). Each
-- tenant decides (booking_policies):
--
--   * reminders_enabled            on/off (default on)
--   * reminder_hours_before        how far ahead (default 24, 1..168)
--   * reminder_include_manage_link whether walk-in rental reminders carry
--                                  the no-login manage/reschedule link
--
-- The manage link problem: only the sha256 of the confirmation-email
-- token is stored (026), so a reminder can't re-send the same link. It
-- mints its OWN token instead — bookings.reminder_manage_token_hash —
-- and the manage endpoints accept either hash. Same validity bounds as
-- the original (booking state + reschedule cutoff); both die together.
--
-- reminder_sent_at makes the sweep idempotent (never two reminders) and
-- is cleared on reschedule so the new time gets its own reminder.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 033_booking_reminders.sql
-- Depends on: 006 (booking_policies), 007 (bookings), 008
--             (class_bookings), 026 (manage_token_hash).

-- ============================================================
-- 1. booking_policies — per-tenant reminder settings
-- ============================================================

ALTER TABLE booking_policies
  ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN reminder_hours_before integer NOT NULL DEFAULT 24
    CONSTRAINT booking_policies_reminder_hours_range
    CHECK (reminder_hours_before BETWEEN 1 AND 168),
  ADD COLUMN reminder_include_manage_link boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN booking_policies.reminder_include_manage_link IS
  'Walk-in rental reminders carry a no-login manage link (its own '
  'token: bookings.reminder_manage_token_hash). Off = reminder says '
  '"reply to this email" instead.';

-- ============================================================
-- 2. bookings — reminder bookkeeping + second manage token
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN reminder_sent_at timestamptz,
  ADD COLUMN reminder_manage_token_hash text
    CONSTRAINT bookings_reminder_manage_token_hash_shape
    CHECK (reminder_manage_token_hash IS NULL
           OR reminder_manage_token_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX bookings_reminder_manage_token_hash_unique
  ON bookings (reminder_manage_token_hash)
  WHERE reminder_manage_token_hash IS NOT NULL;

-- The sweep's scan: confirmed, not yet reminded, by start time.
CREATE INDEX bookings_reminder_due_idx
  ON bookings (tenant_id, start_time)
  WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

-- ============================================================
-- 3. class_bookings — reminder bookkeeping
-- ============================================================

ALTER TABLE class_bookings
  ADD COLUMN reminder_sent_at timestamptz;

CREATE INDEX class_bookings_reminder_due_idx
  ON class_bookings (tenant_id, class_instance_id)
  WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

-- Verify (commented for live apply):
--
--   SELECT reminders_enabled, reminder_hours_before, reminder_include_manage_link
--     FROM booking_policies LIMIT 1;
--   -- expect: t | 24 | t
--
--   SELECT column_name FROM information_schema.columns
--    WHERE (table_name = 'bookings' AND column_name IN
--             ('reminder_sent_at', 'reminder_manage_token_hash'))
--       OR (table_name = 'class_bookings' AND column_name = 'reminder_sent_at');
--   -- expect: 3 rows
