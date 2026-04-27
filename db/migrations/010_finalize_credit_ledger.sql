-- Migration 010 — finalize credit_ledger_entries
--
-- Adds the class_booking_id column + FK and replaces the original
-- single-booking-id CHECK with one that handles both booking_id and
-- class_booking_id, plus a no-double-booking-ref CHECK.
--
-- Why split across migrations: at 005 we couldn't add either FK
-- (bookings + class_bookings didn't exist). At 007 we added the
-- booking_id FK once bookings existed. Now at 010, with class_bookings
-- in place from 008, we add the analogous class_booking_id FK and
-- swap the booking-reference CHECK.
--
-- The original CHECK was named explicitly in 005
-- (`credit_ledger_entries_booking_ref_check`) so this drop is by
-- deterministic name, not a discovery query against pg_constraint.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 010_finalize_credit_ledger.sql
-- Depends on: 005 (credit_ledger_entries), 008 (class_bookings).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 8: CLEANUP — credit_ledger_entries class_booking_id
-- ============================================================

-- Now that class_bookings exists, add the analogous FK to ledger
-- entries for class booking spend/refund tracking.
ALTER TABLE credit_ledger_entries ADD COLUMN class_booking_id uuid;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_class_booking_id_fkey
  FOREIGN KEY (tenant_id, class_booking_id, member_id)
  REFERENCES class_bookings(tenant_id, id, member_id)
  ON DELETE RESTRICT;

-- Replace the named single-booking CHECK with one that requires
-- exactly one of booking_id or class_booking_id for booking_*
-- reasons. Drop is deterministic because the original was named
-- in 005.
ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_booking_ref_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_booking_ref_check
  CHECK (
    (reason IN ('booking_spend', 'booking_refund'))
    = ((booking_id IS NOT NULL) OR (class_booking_id IS NOT NULL))
  );

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_no_double_booking_ref
  CHECK (NOT (booking_id IS NOT NULL AND class_booking_id IS NOT NULL));

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. class_booking_id column now present (expected: 1 row):
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema = 'public'
--         AND table_name = 'credit_ledger_entries'
--         AND column_name = 'class_booking_id';
--
-- 2. Both FK constraints present on credit_ledger_entries
--    (expected: 2 rows):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'credit_ledger_entries'::regclass
--         AND contype = 'f'
--         AND conname IN ('credit_ledger_entries_booking_id_fkey',
--                         'credit_ledger_entries_class_booking_id_fkey')
--       ORDER BY conname;
--
-- 3. Both named CHECK constraints in their final form
--    (expected: 2 rows; booking_ref_check is the new replacement):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'credit_ledger_entries'::regclass
--         AND contype = 'c'
--         AND conname IN ('credit_ledger_entries_booking_ref_check',
--                         'credit_ledger_entries_no_double_booking_ref')
--       ORDER BY conname;
--
-- 4. no-double-booking-ref CHECK rejects rows with both booking_id
--    AND class_booking_id set:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid; v_member_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-010', 'Verify 010', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_tenant_id, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_member_id;
--        BEGIN
--          INSERT INTO credit_ledger_entries
--            (tenant_id, member_id, amount, balance_after, reason,
--             booking_id, class_booking_id)
--            VALUES (v_tenant_id, v_member_id, -1, 0, 'booking_spend',
--                    gen_random_uuid(), gen_random_uuid());
--          RAISE EXCEPTION 'FAIL: row with both booking refs accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: row with both booking refs rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. New booking_ref_check accepts class_booking_id alone for
--    booking_* reasons (the previous CHECK would have rejected this
--    because booking_id is NULL). The class_booking_id FK still
--    needs a real referenced row, so this test inserts a real
--    class_booking and links to it.
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_member_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--        v_instance_id uuid;
--        v_cb_id       uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-010b', 'Verify 010b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_tenant_id, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_member_id;
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Room 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, capacity, allow_member_booking)
--          VALUES (v_tenant_id, 'Class', 'classes', 60, 1, 0, 8, true)
--          RETURNING id INTO v_offering_id;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id);
--        INSERT INTO class_instances
--          (tenant_id, offering_id, resource_id, start_time, end_time, capacity)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                  now() + interval '7 days',
--                  now() + interval '7 days 1 hour', 8)
--          RETURNING id INTO v_instance_id;
--        INSERT INTO class_bookings
--          (tenant_id, class_instance_id, member_id, amount_due_cents,
--           credit_cost_charged, payment_status)
--          VALUES (v_tenant_id, v_instance_id, v_member_id, 0, 1, 'not_required')
--          RETURNING id INTO v_cb_id;
--        INSERT INTO credit_ledger_entries
--          (tenant_id, member_id, amount, balance_after, reason, class_booking_id)
--          VALUES (v_tenant_id, v_member_id, -1, 0, 'booking_spend', v_cb_id);
--        RAISE NOTICE 'PASS: booking_spend with class_booking_id alone accepted';
--      END;
--      $$;
--      ROLLBACK;
