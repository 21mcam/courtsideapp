-- Migration 026 — walk-in checkout v2 (notes, manage tokens, reschedule)
--
-- Rebuild of the public walk-in booking checkout, driven by GA4 funnel
-- data from the Setmore flow it replaces. Backend pieces:
--
--   1. bookings.customer_note — the optional "Anything we should
--      know?" field on the guest details form. Customer-only, like
--      the other customer_* columns.
--   2. bookings.manage_token_hash — sha256 (hex) of a random
--      capability token minted by the Stripe webhook when payment
--      confirms. The raw token exists only in the confirmation email
--      link; possession of the link IS the auth for the no-login
--      self-serve reschedule flow. Hash-at-rest: a DB read yields
--      nothing usable. Abandoned pending_payment rows never get one.
--   3. Reschedule audit trail — previous_start_time / rescheduled_at /
--      reschedule_count. The GiST exclusion constraint from 007
--      already gives reschedules their concurrency backstop for free:
--      time_range is GENERATED, so any UPDATE of start/end/resource
--      re-checks overlap against every other non-cancelled row.
--   4. booking_policies.customer_reschedule_hours_before — the
--      self-serve reschedule cutoff ("reschedule free up to N hours
--      before"), default 24.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 026_walkin_checkout_v2.sql
-- Depends on: 006 (booking_policies), 007 (bookings).

-- ============================================================
-- 1. bookings — customer note
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN customer_note text
    CONSTRAINT bookings_customer_note_not_blank
    CHECK (customer_note IS NULL OR btrim(customer_note) <> '');

-- Notes belong to walk-in customers; member bookings have no form
-- that collects one.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_customer_note_customer_only
  CHECK (member_id IS NULL OR customer_note IS NULL);

COMMENT ON COLUMN bookings.customer_note IS
  'Optional free-text note from the walk-in checkout form ("Anything '
  'we should know?"). Customer bookings only.';

-- ============================================================
-- 2. bookings — manage token (no-login reschedule capability)
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN manage_token_hash text
    CONSTRAINT bookings_manage_token_hash_shape
    CHECK (manage_token_hash IS NULL OR manage_token_hash ~ '^[0-9a-f]{64}$');

-- Globally unique by construction (sha256 of 256 random bits); the
-- partial unique index doubles as the lookup index for the manage
-- endpoints.
CREATE UNIQUE INDEX bookings_manage_token_hash_unique
  ON bookings (manage_token_hash)
  WHERE manage_token_hash IS NOT NULL;

COMMENT ON COLUMN bookings.manage_token_hash IS
  'sha256 hex of the customer''s manage-link token. Set by the Stripe '
  'webhook when a walk-in payment confirms; the raw token is only ever '
  'embedded in the confirmation/reschedule emails. NULL for member '
  'bookings and never-paid holds. Validity is bounded by booking state '
  '(confirmed + paid) and the reschedule cutoff — no expiry column.';

-- ============================================================
-- 3. bookings — reschedule audit trail
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN rescheduled_at timestamptz,
  ADD COLUMN previous_start_time timestamptz,
  ADD COLUMN reschedule_count integer NOT NULL DEFAULT 0
    CONSTRAINT bookings_reschedule_count_nonnegative
    CHECK (reschedule_count >= 0);

-- A rescheduled booking always carries its trail; an untouched one
-- never does.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_reschedule_audit_consistent
  CHECK ((reschedule_count = 0) = (rescheduled_at IS NULL AND previous_start_time IS NULL));

COMMENT ON COLUMN bookings.previous_start_time IS
  'start_time before the most recent reschedule. Only the latest hop '
  'is kept — full history is not a v1 requirement.';

-- ============================================================
-- 4. booking_policies — customer reschedule cutoff
-- ============================================================

ALTER TABLE booking_policies
  ADD COLUMN customer_reschedule_hours_before integer NOT NULL DEFAULT 24
    CONSTRAINT booking_policies_reschedule_hours_nonnegative
    CHECK (customer_reschedule_hours_before >= 0);

COMMENT ON COLUMN booking_policies.customer_reschedule_hours_before IS
  'Walk-in customers can self-serve reschedule (via the emailed manage '
  'link) until this many hours before the booking starts. Shown at '
  'checkout as the flexibility promise. 0 = up to the start time.';

-- Verify (commented for live apply):
--
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'bookings'::regclass
--      AND conname LIKE 'bookings_%'
--      AND conname IN ('bookings_customer_note_customer_only',
--                      'bookings_reschedule_audit_consistent');
--   -- expect: 2 rows
--
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'bookings'
--      AND indexname = 'bookings_manage_token_hash_unique';
--   -- expect: 1 row
--
--   SELECT customer_reschedule_hours_before FROM booking_policies LIMIT 1;
--   -- expect: 24
