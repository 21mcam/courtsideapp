-- Migration 017 — add 'migration' to credit_ledger_entries.reason
--
-- Phase 6 (Momentum migration) seeds members with their existing
-- credit balances by writing a single ledger row per member. We
-- want this row to be visibly distinguishable from operational
-- changes — a future audit looking at a member's history should
-- know "this credit didn't come from a weekly reset or admin
-- adjustment; it came from the data import".
--
-- 'manual' could carry this load, but conflating import bulk-writes
-- with one-off corrections muddies later reporting. A separate
-- enum value is one line and pays for itself the first time someone
-- runs `SELECT count(*) WHERE reason = 'migration'` to verify the
-- import landed correctly.
--
-- Reason values are constrained by a CHECK, not a real enum type,
-- so updating means dropping + recreating the constraint. Keeping
-- the constraint name stable in case future migrations need to
-- modify it again.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 017_migration_ledger_reason.sql
-- Depends on: 005 (credit_ledger_entries created), 010 (final
--             constraint shape after class_booking_id added).
-- Verify: see commented block at end.

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_reason_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_reason_check
  CHECK (reason IN ('weekly_reset', 'admin_adjustment', 'signup_bonus',
                    'booking_spend', 'booking_refund', 'plan_change',
                    'manual', 'migration'));

-- Verify (commented for live apply):
--
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname = 'credit_ledger_entries_reason_check';
--   -- expect: CHECK ((reason = ANY (ARRAY['weekly_reset', ...,
--   --                                     'manual', 'migration'])))
--
-- Note: the CHECK constraint above gets a generated name when the
-- table is first created (Postgres auto-names CHECKs as
-- <table>_<col>_check). That's stable across reruns of the same
-- column, so the DROP works even though the original migration
-- (005) didn't name the constraint explicitly. Future migrations
-- that touch this CHECK can rely on the canonical name above.
