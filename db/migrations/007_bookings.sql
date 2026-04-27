-- Migration 007 — bookings + enforce_booking_validity + ledger
--                   booking_id FK
--
-- The big one. Resource rentals (capacity = 1 offerings) live here;
-- classes get class_bookings in 008. Includes:
--   * bookings table — mutual exclusion (member XOR customer),
--     payment shape invariants, lifecycle audit, partial GiST
--     exclusion preventing overlapping non-cancelled bookings on
--     the same resource.
--   * enforce_booking_validity() trigger — five runtime gates that
--     can't be FKs (offering active, capacity = 1, audience flag,
--     resource active, link active). On UPDATE it short-circuits if
--     no gating field changed; transitioning out of cancelled forces
--     re-validation.
--   * The deferred ledger FK from migration 005:
--     credit_ledger_entries (tenant_id, booking_id, member_id) →
--     bookings (tenant_id, id, member_id). The composite over
--     member_id makes customer bookings physically un-referenceable
--     from the ledger.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 007_bookings.sql
-- Depends on: 003 (members), 004 (offerings, resources,
-- offering_resources), 005 (credit_ledger_entries).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 5: BOOKINGS — bookings table
-- ============================================================

-- One booking per resource-time-slot, for both members (spend credits)
-- and customers (walk-ins, pay cash or card). Mutual exclusion between
-- member_id and customer_* fields is enforced by CHECK.
--
-- Resource assignment is required and constrained by the composite FK
-- to offering_resources, so a booking can only exist for a valid
-- (offering, resource) pair. Bookings persist after offering_resources
-- rows are deactivated (active = false), preserving history.
--
-- Slot exclusivity for resource bookings is enforced by a partial
-- exclusion constraint: two bookings with overlapping time_range on
-- the same resource cannot coexist unless one is cancelled. Only
-- cancelled bookings free up their slot; completed and no_show
-- remain on the calendar as historical records and continue to
-- block future inserts. Phrased negatively (status <> 'cancelled')
-- so any future status defaults to blocking.
--
-- pending_payment requires hold_expires_at — abandoned checkout sessions
-- otherwise hold cages forever. A janitor (Phase 3 deliverable) sweeps
-- expired holds and marks them cancelled.
--
-- Pricing/cost is snapshotted at booking time. amount_due_cents and
-- credit_cost_charged are the at-time-of-booking values; the offering's
-- current price/cost can change without affecting historical bookings.
--
-- Lifecycle audit fields (cancelled_at, cancelled_by_*, etc.) are on
-- the row itself rather than a separate booking_state_changes table —
-- support visibility without a full audit system.
CREATE TABLE bookings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id                 uuid NOT NULL,
  resource_id                 uuid NOT NULL,

  -- identity: exactly one of (member_id) or (customer_*)
  member_id                   uuid,
  customer_first_name         text
                              CHECK (
                                customer_first_name IS NULL
                                OR (btrim(customer_first_name) <> ''
                                    AND customer_first_name = btrim(customer_first_name))
                              ),
  customer_last_name          text
                              CHECK (
                                customer_last_name IS NULL
                                OR (btrim(customer_last_name) <> ''
                                    AND customer_last_name = btrim(customer_last_name))
                              ),
  customer_email              text
                              CHECK (
                                customer_email IS NULL
                                OR (customer_email = lower(btrim(customer_email))
                                    AND btrim(customer_email) <> ''
                                    AND customer_email !~ '\s')
                              ),
  customer_phone              text,

  -- timing
  start_time                  timestamptz NOT NULL,
  end_time                    timestamptz NOT NULL,
  time_range                  tstzrange GENERATED ALWAYS AS (
                                tstzrange(start_time, end_time, '[)')
                              ) STORED,

  -- state
  status                      text NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('pending_payment', 'confirmed',
                                                 'completed', 'no_show', 'cancelled')),
  hold_expires_at             timestamptz,

  -- price/cost snapshot at booking time
  amount_due_cents            integer NOT NULL CHECK (amount_due_cents >= 0),
  credit_cost_charged         integer NOT NULL DEFAULT 0 CHECK (credit_cost_charged >= 0),

  -- payment state
  amount_paid_cents           integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  amount_refunded_cents       integer NOT NULL DEFAULT 0 CHECK (amount_refunded_cents >= 0),
  payment_status              text NOT NULL DEFAULT 'not_required'
                              CHECK (payment_status IN ('not_required', 'pending', 'paid',
                                                         'refunded', 'partial_refund')),
  stripe_payment_intent_id    text,

  -- lifecycle audit
  cancelled_at                timestamptz,
  cancelled_by_type           text
                              CHECK (cancelled_by_type IS NULL
                                     OR cancelled_by_type IN ('member', 'customer', 'admin', 'system')),
  cancelled_by_user_id        uuid,
  cancellation_reason         text,
  no_show_marked_at           timestamptz,
  no_show_marked_by           uuid,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  -- needed for credit_ledger_entries composite FK that ensures a
  -- ledger entry's member_id matches the booking's member_id (no
  -- cross-member ledger entries via a wrong booking_id).
  UNIQUE (tenant_id, id, member_id),

  -- catalog FKs
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  -- the integrity FK: prove resource is valid for this offering
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,
  -- identity FK
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT,

  -- mutual exclusion: member XOR customer
  CHECK (
    (member_id IS NOT NULL
     AND customer_first_name IS NULL AND customer_last_name IS NULL
     AND customer_email IS NULL AND customer_phone IS NULL)
    OR
    (member_id IS NULL
     AND customer_first_name IS NOT NULL
     AND customer_last_name IS NOT NULL
     AND customer_email IS NOT NULL)
  ),

  -- payment shape: members spend credits (no money), customers owe
  -- money (no credits). Free member bookings are allowed
  -- (credit_cost_charged = 0 for "first class free" promos etc.).
  CHECK (
    (member_id IS NOT NULL AND amount_due_cents = 0 AND credit_cost_charged >= 0)
    OR
    (member_id IS NULL AND credit_cost_charged = 0)
  ),

  -- refunds can't exceed payments
  CHECK (amount_refunded_cents <= amount_paid_cents),

  -- pending_payment must have an expiry, and the hold can't outlast
  -- the slot itself (otherwise abandoned holds block real availability
  -- through the actual booked time). App code separately enforces a
  -- shorter hold duration (e.g. 15 min); the DB constraint is the
  -- absolute upper bound.
  CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
  CHECK (status <> 'pending_payment' OR hold_expires_at <= start_time),

  -- pending_payment is customer-only (members debit credits
  -- synchronously; there is no async payment to wait for). A
  -- pending_payment booking must be a customer booking with
  -- payment_status = 'pending'.
  CHECK (
    status <> 'pending_payment'
    OR (member_id IS NULL AND payment_status = 'pending')
  ),

  -- end after start
  CHECK (end_time > start_time),

  -- lifecycle consistency
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'no_show' OR no_show_marked_at IS NOT NULL),
  CHECK (cancelled_by_type <> 'admin' OR cancelled_by_user_id IS NOT NULL),

  -- payment_status must agree with money fields. Caught via CASE so
  -- each state's invariants are explicit. Each state requires
  -- amount_due_cents > 0 (except 'not_required' which requires = 0).
  -- amount_paid >= amount_due (not =) because Stripe sometimes rounds
  -- up by a cent.
  CHECK (
    CASE payment_status
      WHEN 'not_required' THEN
        amount_due_cents = 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'pending' THEN
        amount_due_cents > 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'paid' THEN
        amount_due_cents > 0
        AND amount_paid_cents >= amount_due_cents
        AND amount_refunded_cents = 0
      WHEN 'partial_refund' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents > 0
        AND amount_refunded_cents < amount_paid_cents
      WHEN 'refunded' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents = amount_paid_cents
    END
  ),

  -- payment_status maps to member/customer identity:
  --   member bookings → always 'not_required' (credits, no money)
  --   customer free bookings → 'not_required' with $0 due
  --   customer paid bookings → some non-'not_required' state with $ due
  CHECK (
    (member_id IS NOT NULL AND payment_status = 'not_required')
    OR
    (member_id IS NULL
     AND ((payment_status = 'not_required' AND amount_due_cents = 0)
          OR (payment_status <> 'not_required' AND amount_due_cents > 0)))
  ),

  -- prevent overlapping bookings on same resource. Only 'cancelled'
  -- bookings don't block — completed and no_show are historical
  -- records and must remain immutable on the calendar. Phrased
  -- negatively (<> 'cancelled') so any future status defaults to
  -- blocking, which is the safe direction.
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    time_range WITH &&
  ) WHERE (status <> 'cancelled')
);

CREATE UNIQUE INDEX bookings_stripe_payment_intent_unique
  ON bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX bookings_tenant_member_start_idx
  ON bookings (tenant_id, member_id, start_time DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX bookings_tenant_resource_start_idx
  ON bookings (tenant_id, resource_id, start_time);

CREATE INDEX bookings_tenant_status_start_idx
  ON bookings (tenant_id, status, start_time);

-- janitor index for sweeping expired pending holds
CREATE INDEX bookings_hold_expires_idx
  ON bookings (hold_expires_at)
  WHERE status = 'pending_payment';

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- enforce_booking_validity()
-- ============================================================

-- Booking validity trigger.
--
-- The composite FKs prove the offering and resource exist and are a
-- valid pairing. They don't prove the booking is currently bookable.
-- This trigger validates the full bookability contract:
--   1. offering is active
--   2. offering capacity = 1 (classes go through class_bookings)
--   3. offering allows the booking's audience (member/customer)
--   4. resource is active
--   5. offering_resources link is active
--
-- We can't enforce these via FK because all five flags are runtime
-- gates, not referential constraints — historical bookings must
-- survive deactivation of any of them.
--
-- Trigger fires on INSERT and on UPDATE of the gating columns
-- (offering, resource, member, status). On UPDATE it short-circuits
-- when none of the gating fields changed, so historical bookings
-- can have payment, audit, or hold-expiry fields updated freely.
-- The exception: transitioning out of 'cancelled' (reactivating
-- a booking) forces re-validation against the current bookability
-- contract — even if no other gating field changed. A booking that
-- was cancelled while its offering was active can't be silently
-- reactivated after the offering has been deactivated.
CREATE OR REPLACE FUNCTION enforce_booking_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_offering_member_ok  boolean;
  v_offering_public_ok  boolean;
  v_resource_active     boolean;
  v_link_active         boolean;
  v_is_member_booking   boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.member_id   IS NOT DISTINCT FROM OLD.member_id
     -- Force re-validation when transitioning out of cancelled.
     -- Reactivating a booking must satisfy the current bookability
     -- contract, even if no other gating field changed.
     AND NOT (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_is_member_booking := (NEW.member_id IS NOT NULL);

  -- Offering: exists, active, capacity = 1, audience allowed
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

  IF v_is_member_booking AND NOT v_offering_member_ok THEN
    RAISE EXCEPTION 'Offering % does not allow member bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_is_member_booking AND NOT v_offering_public_ok THEN
    RAISE EXCEPTION 'Offering % does not allow public bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resource: active
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

  -- offering_resources link: active
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

CREATE TRIGGER bookings_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id, member_id, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_validity();

-- ============================================================
-- Deferred FK from migration 005: credit_ledger_entries.booking_id
-- ============================================================

-- Now that bookings exists, add the FK from credit_ledger_entries
-- (was deferred from migration 005 due to circular dependency).
-- A booking referenced by a ledger entry can't be deleted; the ledger
-- is append-only and historical bookings preserve the audit trail.
--
-- The FK is composite over (tenant_id, booking_id, member_id) — not
-- just (tenant_id, booking_id) — so a ledger entry can't accidentally
-- reference a different member's booking.
--
-- This FK is fully enforced for any ledger row with a non-null
-- booking_id: credit_ledger_entries.member_id is NOT NULL, and a
-- customer booking has bookings.member_id = NULL, so a ledger entry
-- pointing at a customer booking would have its tuple
-- (tenant_id, customer_booking_id, ledger_member_id) fail to match
-- bookings(tenant_id, id, member_id). Customer bookings are
-- physically excluded from the ledger by the FK shape itself —
-- no extra trigger needed.
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_booking_id_fkey
  FOREIGN KEY (tenant_id, booking_id, member_id)
  REFERENCES bookings(tenant_id, id, member_id)
  ON DELETE RESTRICT;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. bookings table present, RLS forced (expected: 1 row, t/t):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'bookings';
--
-- 2. enforce_booking_validity trigger present (expected: 1 row):
--      SELECT trigger_name FROM information_schema.triggers
--       WHERE trigger_name = 'bookings_enforce_validity';
--
-- 3. credit_ledger_entries booking_id FK now exists (expected: 1 row):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'credit_ledger_entries'::regclass
--         AND conname = 'credit_ledger_entries_booking_id_fkey';
--
-- 4. Bookings exclusion rejects overlapping non-cancelled bookings
--    on the same resource:
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-007', 'Verify 007', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Cage 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, allow_public_booking)
--          VALUES (v_tenant_id, 'Half hour', 'cage-time', 30, 1, 3000, true)
--          RETURNING id INTO v_offering_id;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id);
--        INSERT INTO bookings
--          (tenant_id, offering_id, resource_id,
--           customer_first_name, customer_last_name, customer_email,
--           start_time, end_time, amount_due_cents, payment_status)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                  'Walk', 'In', 'w@example.com',
--                  now() + interval '1 day', now() + interval '1 day 1 hour',
--                  3000, 'pending');
--        BEGIN
--          INSERT INTO bookings
--            (tenant_id, offering_id, resource_id,
--             customer_first_name, customer_last_name, customer_email,
--             start_time, end_time, amount_due_cents, payment_status)
--            VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                    'Other', 'Walk', 'o@example.com',
--                    now() + interval '1 day 30 minutes',
--                    now() + interval '1 day 90 minutes',
--                    3000, 'pending');
--          RAISE EXCEPTION 'FAIL: overlapping booking accepted';
--        EXCEPTION WHEN exclusion_violation THEN
--          RAISE NOTICE 'PASS: overlapping booking rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. enforce_booking_validity rejects booking on inactive offering:
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-007b', 'Verify 007b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Cage 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, allow_public_booking, active)
--          VALUES (v_tenant_id, 'Inactive', 'cage-time', 30, 1, 3000, true, false)
--          RETURNING id INTO v_offering_id;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id);
--        BEGIN
--          INSERT INTO bookings
--            (tenant_id, offering_id, resource_id,
--             customer_first_name, customer_last_name, customer_email,
--             start_time, end_time, amount_due_cents, payment_status)
--            VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                    'Walk', 'In', 'w@example.com',
--                    now() + interval '1 day', now() + interval '1 day 1 hour',
--                    3000, 'pending');
--          RAISE EXCEPTION 'FAIL: booking on inactive offering accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: booking on inactive offering rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
