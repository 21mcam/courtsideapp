-- Migration 037 — front-desk bookings
--
-- A month of Momentum's Setmore data: ~63% of bookings are entered by
-- staff (phone / text / walk-up), not by customers. Three things the
-- front desk needs that the schema blocked:
--
-- 1. Walk-in customers WITHOUT an email. A phone booking often has a
--    name and a number and nothing else. The member-XOR-customer CHECK
--    (007, unnamed → bookings_check) required customer_email. It now
--    requires email OR phone. The public walk-in path still demands
--    all three in app code; this only lets staff book phone-only.
--
-- 2. Recording in-person payment. Front-desk walk-ins are created
--    'confirmed' + payment_status 'pending' (cash on arrival) and
--    nothing could ever mark them paid, so they never reached revenue.
--    New columns record who marked it paid, when, and how:
--      payment_method  'cash' | 'card' | 'other' — in-person only;
--                      NULL for Stripe-paid / unpaid rows
--      paid_at         when the money was recorded (revenue month)
--      paid_marked_by  the staff user
--
-- 3. Staff-only offerings. enforce_booking_validity (007) refuses a
--    customer booking on an offering with allow_public_booking = false
--    (and a member booking with allow_member_booking = false). Those
--    flags gate the SELF-SERVE surfaces; the front desk must be able to
--    book a walk-in into a staff-only offering (Momentum's 3/4/5-hour
--    cage blocks). Staff routes set the transaction-local GUC
--    app.booking_source = 'staff', which skips just those two checks.
--    Every other check (active offering/resource/link, capacity) stays.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 037_front_desk.sql
-- Depends on: 007 (bookings, enforce_booking_validity).

-- ============================================================
-- 1. customer contact: email OR phone
-- ============================================================

-- The 007 CHECK was unnamed; find it by definition rather than trusting
-- the generated name.
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'bookings'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%member_id IS NOT NULL%customer_email IS NULL%customer_email IS NOT NULL%';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'member-xor-customer CHECK on bookings not found';
  END IF;
  EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', v_name);
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_member_xor_customer
  CHECK (
    (member_id IS NOT NULL
     AND customer_first_name IS NULL AND customer_last_name IS NULL
     AND customer_email IS NULL AND customer_phone IS NULL)
    OR
    (member_id IS NULL
     AND customer_first_name IS NOT NULL
     AND customer_last_name IS NOT NULL
     AND (customer_email IS NOT NULL
          OR NULLIF(btrim(customer_phone), '') IS NOT NULL))
  );

-- ============================================================
-- 2. in-person payment record
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN payment_method text
    CONSTRAINT bookings_payment_method_allowed
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'card', 'other')),
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN paid_marked_by uuid;

-- An in-person payment is a walk-in, not Stripe, and fully paid.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_in_person_payment_consistent
  CHECK (
    payment_method IS NULL
    OR (member_id IS NULL
        AND stripe_payment_intent_id IS NULL
        AND payment_status = 'paid'
        AND paid_at IS NOT NULL
        AND paid_marked_by IS NOT NULL)
  );

COMMENT ON COLUMN bookings.payment_method IS
  'How a front-desk walk-in paid in person (cash/card/other), set by '
  'staff via mark-paid. NULL for Stripe-paid, member, and unpaid rows.';
COMMENT ON COLUMN bookings.paid_at IS
  'When staff recorded an in-person payment. Revenue reports attribute '
  'the money to this month (created_at for Stripe-paid rows).';

-- ============================================================
-- 3. staff bookings bypass the self-serve visibility flags
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_booking_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_offering_member_ok  boolean;
  v_offering_public_ok  boolean;
  v_resource_active     boolean;
  v_link_active         boolean;
  v_is_member_booking   boolean;
  v_staff               boolean;
BEGIN
  -- Skip when nothing the trigger validates changed (time-only edits,
  -- payment updates), except un-cancelling, which re-validates.
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.member_id   IS NOT DISTINCT FROM OLD.member_id
     AND NOT (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_is_member_booking := (NEW.member_id IS NOT NULL);
  -- Front-desk routes set this per transaction (migration 037).
  v_staff := coalesce(current_setting('app.booking_source', true), '') = 'staff';

  SELECT active, capacity, allow_member_booking, allow_public_booking
    INTO v_offering_active, v_offering_capacity,
         v_offering_member_ok, v_offering_public_ok
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot book inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity <> 1 THEN
    RAISE EXCEPTION 'Offering % is a class (capacity %), use class_bookings',
      NEW.offering_id, v_offering_capacity
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_staff AND v_is_member_booking AND NOT v_offering_member_ok THEN
    RAISE EXCEPTION 'Offering % does not allow member bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_staff AND NOT v_is_member_booking AND NOT v_offering_public_ok THEN
    RAISE EXCEPTION 'Offering % does not allow public bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found in tenant %',
      NEW.resource_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Cannot book inactive resource %', NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = NEW.offering_id
    AND resource_id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Verify (commented for live apply):
--
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'bookings'::regclass
--      AND conname IN ('bookings_member_xor_customer',
--                      'bookings_in_person_payment_consistent');
--   -- expect: 2 rows
--
--   SELECT count(*) FROM pg_constraint
--    WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_check';
--   -- expect: 0
