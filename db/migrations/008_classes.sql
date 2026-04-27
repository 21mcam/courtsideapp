-- Migration 008 — class_schedules, class_instances, class_bookings
--                   plus six triggers that hold the class layer together
--
-- Classes are offerings with capacity > 1 plus a roster (class_bookings).
-- A class_schedule defines a recurring series; each occurrence is a
-- class_instance; each spot in an instance is a class_booking.
--
-- The six triggers in this migration:
--   1. enforce_class_schedule_validity        — schedules can't target
--                                               an inactive offering,
--                                               a rental (capacity = 1),
--                                               or an inactive resource/
--                                               offering_resources link.
--   2. enforce_class_instance_validity        — same gates at instance
--                                               creation; capacity > 1
--                                               check; transitioning out
--                                               of cancelled re-validates.
--   3. enforce_no_class_overlap_on_booking    — cross-table: a booking
--                                               can't occupy a resource
--                                               that has a non-cancelled
--                                               class_instance overlap.
--   4. enforce_no_booking_overlap_on_class_instance — mirror.
--   5. enforce_class_capacity                 — belt-and-suspenders for
--                                               app-level FOR UPDATE; row
--                                               count never exceeds
--                                               instance capacity.
--   6. enforce_class_booking_validity         — instance not cancelled,
--                                               offering active, audience
--                                               matches member-vs-customer,
--                                               resource/link active,
--                                               pending_payment hold can't
--                                               outlast instance start.
--   7. prevent_class_instance_id_change       — class_bookings.class_instance_id
--                                               is immutable after insert;
--                                               "move to a different class"
--                                               is cancel-and-rebook only.
--
-- Composite FK on class_instances (tenant_id, class_schedule_id,
-- offering_id) → class_schedules(tenant_id, id, offering_id) prevents
-- offering drift between a schedule and its instances. Resource can be
-- overridden per instance; offering cannot.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 008_classes.sql
-- Depends on: 004 (offerings, resources, offering_resources),
-- 007 (bookings — needed for cross-table overlap triggers).
-- Verify: see commented block at end.

-- ============================================================
-- LAYER 6: CLASSES — class_schedules
-- ============================================================

-- A class_schedule defines a recurring class. Simple weekly model:
-- "this offering, in this resource, every {day_of_week} at
-- {start_time}, from {start_date} until {end_date}."
--
-- Eager generation: when the schedule is created, the generator
-- creates class_instance rows for every matching date up to a
-- horizon (26 weeks for open-ended schedules; full range for
-- bounded schedules). A periodic job (Phase 4 deliverable) extends
-- the horizon for open-ended schedules as instances are consumed.
--
-- start_date IS the first class date — the day_of_week constraint
-- below enforces that. The wizard should default start_date to the
-- next matching day_of_week so the constraint is invisible to admins.
--
-- For one-off classes (no recurrence), admins create a class_instance
-- directly with class_schedule_id = NULL.
CREATE TABLE class_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id         uuid NOT NULL,
  resource_id         uuid NOT NULL,
  -- recurrence
  day_of_week         smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time          time NOT NULL,
  start_date          date NOT NULL,
  end_date            date,                                 -- NULL = open-ended
  -- generator state
  generated_through   date,                                 -- last date generator has reached
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,

  -- start_date must fall on the configured day_of_week.
  -- Postgres EXTRACT(DOW) returns 0 = Sunday, matching our convention.
  CHECK (extract(dow from start_date)::smallint = day_of_week),
  CHECK (end_date IS NULL OR end_date >= start_date),

  -- needed for class_instances composite FK that ensures an instance
  -- inherits its schedule's offering (resource can be overridden;
  -- offering can't drift).
  UNIQUE (tenant_id, id, offering_id)
);

CREATE TRIGGER class_schedules_set_updated_at
  BEFORE UPDATE ON class_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY class_schedules_tenant_isolation ON class_schedules
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- enforce_class_schedule_validity
-- ============================================================

-- Validity trigger for class_schedules. Same checks as
-- enforce_class_instance_validity (offering active, capacity > 1,
-- resource active, link active) — fired when the schedule is
-- created or its offering/resource changes. Catches invalid
-- schedules before they generate bad instances.
CREATE OR REPLACE FUNCTION enforce_class_schedule_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_resource_active     boolean;
  v_link_active         boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id THEN
    RETURN NEW;
  END IF;

  SELECT active, capacity INTO v_offering_active, v_offering_capacity
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot create schedule for inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity = 1 THEN
    RAISE EXCEPTION 'Offering % is a rental (capacity 1), cannot have a class schedule',
      NEW.offering_id
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
    RAISE EXCEPTION 'Cannot create schedule on inactive resource %', NEW.resource_id
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

CREATE TRIGGER class_schedules_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id ON class_schedules
  FOR EACH ROW EXECUTE FUNCTION enforce_class_schedule_validity();

-- ============================================================
-- class_instances
-- ============================================================

-- A class_instance is a single occurrence of a class. Generated
-- from a class_schedule (recurring), or created directly by admin
-- (one-off, class_schedule_id = NULL).
--
-- capacity is snapshotted from the offering at generation/creation
-- time. Changing the offering's capacity later doesn't affect
-- existing instances — same snapshot pattern as booking pricing.
--
-- resource_id is also snapshotted (initially from the schedule, but
-- editable per-instance). If Cage 4 is broken on July 12, admin can
-- change that one instance to Cage 5 without affecting the rest of
-- the series.
--
-- Cancellation of an entire instance: set cancelled_at + reason.
-- App code cascades to all class_bookings for the instance. The
-- exclusion constraint excludes cancelled instances so the slot
-- can be reused.
CREATE TABLE class_instances (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_schedule_id       uuid,                             -- NULL = one-off
  offering_id             uuid NOT NULL,
  resource_id             uuid NOT NULL,
  start_time              timestamptz NOT NULL,
  end_time                timestamptz NOT NULL,
  time_range              tstzrange GENERATED ALWAYS AS (
                            tstzrange(start_time, end_time, '[)')
                          ) STORED,
  capacity                integer NOT NULL CHECK (capacity >= 1),
  -- cancellation
  cancelled_at            timestamptz,
  cancellation_reason     text,
  cancelled_by_user_id    uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),

  FOREIGN KEY (tenant_id, class_schedule_id)
    REFERENCES class_schedules(tenant_id, id)
    ON DELETE RESTRICT,
  -- Prevents offering drift between schedule and instance. When
  -- class_schedule_id is set, the instance's offering must match the
  -- schedule's offering (composite FKs only fire when all columns
  -- are non-null, so one-offs with class_schedule_id = NULL skip
  -- this check correctly). Resource can still be overridden per
  -- instance — that's intentional. Offering can't drift.
  FOREIGN KEY (tenant_id, class_schedule_id, offering_id)
    REFERENCES class_schedules(tenant_id, id, offering_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,

  CHECK (end_time > start_time),

  -- prevent overlapping non-cancelled instances on same resource
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    time_range WITH &&
  ) WHERE (cancelled_at IS NULL)
);

-- Idempotency: generator can safely retry without creating duplicate
-- instances. Partial because one-offs don't have a schedule_id.
CREATE UNIQUE INDEX class_instances_generation_unique
  ON class_instances (tenant_id, class_schedule_id, start_time)
  WHERE class_schedule_id IS NOT NULL;

CREATE INDEX class_instances_tenant_resource_start_idx
  ON class_instances (tenant_id, resource_id, start_time);

CREATE INDEX class_instances_schedule_idx
  ON class_instances (tenant_id, class_schedule_id, start_time)
  WHERE class_schedule_id IS NOT NULL;

CREATE TRIGGER class_instances_set_updated_at
  BEFORE UPDATE ON class_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY class_instances_tenant_isolation ON class_instances
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- enforce_class_instance_validity
-- ============================================================

-- Validity trigger for class_instances. Same pattern as
-- enforce_booking_validity but with capacity > 1 (instead of = 1)
-- and skipping the audience check (classes can be either members or
-- customers depending on which class_bookings show up).
CREATE OR REPLACE FUNCTION enforce_class_instance_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_resource_active     boolean;
  v_link_active         boolean;
BEGIN
  -- Skip on UPDATE if the gating fields didn't change and we're not
  -- transitioning out of cancelled.
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NOT (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT active, capacity INTO v_offering_active, v_offering_capacity
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot create class instance for inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity = 1 THEN
    RAISE EXCEPTION 'Offering % is a rental (capacity 1), use bookings table', NEW.offering_id
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
    RAISE EXCEPTION 'Cannot create class instance on inactive resource %', NEW.resource_id
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

CREATE TRIGGER class_instances_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id, cancelled_at ON class_instances
  FOR EACH ROW EXECUTE FUNCTION enforce_class_instance_validity();

-- ============================================================
-- Cross-table resource conflict prevention
-- ============================================================

-- bookings.exclusion prevents rental-vs-rental overlap on a resource.
-- class_instances.exclusion prevents class-vs-class overlap.
-- Neither catches rental-vs-class. These triggers do.
--
-- Pattern: BEFORE INSERT/UPDATE on each table, lock the resource row
-- FOR UPDATE (serializes against concurrent inserts on the OTHER
-- table), then check for an overlapping non-cancelled reservation
-- in the other table on the same resource.
CREATE OR REPLACE FUNCTION enforce_no_class_overlap_on_booking() RETURNS trigger AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- Only check when the booking would block availability
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Skip if the time/resource didn't change on UPDATE
  IF TG_OP = 'UPDATE'
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.start_time  IS NOT DISTINCT FROM OLD.start_time
     AND NEW.end_time    IS NOT DISTINCT FROM OLD.end_time
     AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Lock the resource row to serialize against concurrent class_instances inserts
  PERFORM 1 FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
  FOR UPDATE;

  -- Look for any overlapping non-cancelled class_instances on this resource
  SELECT count(*) INTO v_conflict_count
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id
    AND resource_id = NEW.resource_id
    AND cancelled_at IS NULL
    AND time_range && tstzrange(NEW.start_time, NEW.end_time, '[)');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Booking conflicts with an existing class instance on resource % at this time',
      NEW.resource_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_no_class_overlap
  BEFORE INSERT OR UPDATE OF resource_id, start_time, end_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_no_class_overlap_on_booking();

CREATE OR REPLACE FUNCTION enforce_no_booking_overlap_on_class_instance() RETURNS trigger AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- Only check when the instance would block availability
  IF NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Skip if the time/resource didn't change and was already non-cancelled
  IF TG_OP = 'UPDATE'
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.start_time  IS NOT DISTINCT FROM OLD.start_time
     AND NEW.end_time    IS NOT DISTINCT FROM OLD.end_time
     AND OLD.cancelled_at IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
  FOR UPDATE;

  SELECT count(*) INTO v_conflict_count
  FROM bookings
  WHERE tenant_id = NEW.tenant_id
    AND resource_id = NEW.resource_id
    AND status <> 'cancelled'
    AND time_range && tstzrange(NEW.start_time, NEW.end_time, '[)');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Class instance conflicts with an existing booking on resource % at this time',
      NEW.resource_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_instances_no_booking_overlap
  BEFORE INSERT OR UPDATE OF resource_id, start_time, end_time, cancelled_at ON class_instances
  FOR EACH ROW EXECUTE FUNCTION enforce_no_booking_overlap_on_class_instance();

-- ============================================================
-- class_bookings
-- ============================================================

-- Class roster entries. One row per person who has a spot in a class
-- instance. Same identity (member XOR customer), state machine,
-- payment fields, and audit columns as bookings — but no time or
-- resource (those come from the class_instance) and capacity is
-- enforced by trigger rather than exclusion constraint.
CREATE TABLE class_bookings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_instance_id           uuid NOT NULL,

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
  -- needed for credit_ledger_entries.class_booking_id composite FK
  -- (added in migration 010).
  UNIQUE (tenant_id, id, member_id),

  FOREIGN KEY (tenant_id, class_instance_id) REFERENCES class_instances(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT,

  -- mutual exclusion: member XOR customer (same as bookings)
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

  -- payment shape (same as bookings)
  CHECK (
    (member_id IS NOT NULL AND amount_due_cents = 0 AND credit_cost_charged >= 0)
    OR
    (member_id IS NULL AND credit_cost_charged = 0)
  ),

  CHECK (amount_refunded_cents <= amount_paid_cents),

  -- pending_payment + hold expiry constraints (same as bookings)
  CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
  CHECK (
    status <> 'pending_payment'
    OR (member_id IS NULL AND payment_status = 'pending')
  ),

  -- lifecycle consistency (same as bookings)
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'no_show' OR no_show_marked_at IS NOT NULL),
  CHECK (cancelled_by_type <> 'admin' OR cancelled_by_user_id IS NOT NULL),

  -- payment_status invariants (same CASE as bookings)
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

  -- payment_status / member-customer cross-check (same as bookings)
  CHECK (
    (member_id IS NOT NULL AND payment_status = 'not_required')
    OR
    (member_id IS NULL
     AND ((payment_status = 'not_required' AND amount_due_cents = 0)
          OR (payment_status <> 'not_required' AND amount_due_cents > 0)))
  )
);

-- One member can't hold two non-cancelled spots in the same class instance
CREATE UNIQUE INDEX class_bookings_member_per_instance_unique
  ON class_bookings (tenant_id, class_instance_id, member_id)
  WHERE member_id IS NOT NULL AND status <> 'cancelled';

CREATE UNIQUE INDEX class_bookings_stripe_payment_intent_unique
  ON class_bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX class_bookings_tenant_member_idx
  ON class_bookings (tenant_id, member_id, created_at DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX class_bookings_instance_status_idx
  ON class_bookings (tenant_id, class_instance_id, status);

CREATE INDEX class_bookings_hold_expires_idx
  ON class_bookings (hold_expires_at)
  WHERE status = 'pending_payment';

CREATE TRIGGER class_bookings_set_updated_at
  BEFORE UPDATE ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY class_bookings_tenant_isolation ON class_bookings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- enforce_class_capacity
-- ============================================================

-- Class booking capacity enforcement.
--
-- Belt and suspenders: app code does SELECT ... FOR UPDATE on the
-- class_instance row inside the booking transaction to serialize
-- the count check. This trigger is the safety net.
--
-- Capacity counts non-cancelled bookings only. Completed and no_show
-- bookings still occupied a seat (historical integrity, same lesson
-- as the bookings exclusion constraint).
CREATE OR REPLACE FUNCTION enforce_class_capacity() RETURNS trigger AS $$
DECLARE
  v_capacity integer;
  v_current  integer;
BEGIN
  -- Only check when this row is in a counting state
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Skip if old row was already counting (status moves between
  -- counting states, e.g. pending_payment → confirmed, don't change
  -- the count)
  IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Lock the instance row to serialize concurrent inserts
  SELECT capacity INTO v_capacity
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.class_instance_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class instance % not found', NEW.class_instance_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_current
  FROM class_bookings
  WHERE tenant_id = NEW.tenant_id
    AND class_instance_id = NEW.class_instance_id
    AND status <> 'cancelled'
    -- Don't double-count the row being updated
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_current >= v_capacity THEN
    RAISE EXCEPTION 'Class instance % is at capacity (%)',
      NEW.class_instance_id, v_capacity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_enforce_capacity
  BEFORE INSERT OR UPDATE OF status ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_class_capacity();

-- ============================================================
-- enforce_class_booking_validity
-- ============================================================

-- Class booking validity trigger.
--
-- The composite FKs prove the instance and member exist; this
-- trigger validates the full bookability contract at booking time.
-- Specifically:
--   1. instance is not cancelled
--   2. offering still active (could have been deactivated since
--      instance generation)
--   3. offering allows the booking's audience
--   4. resource still active
--   5. offering_resources link still active
--   6. for pending_payment: hold_expires_at <= instance.start_time
--      (mirrors the analogous check on bookings)
--
-- Same skip-on-no-change pattern as enforce_booking_validity, with
-- forced re-validation when transitioning out of cancelled.
CREATE OR REPLACE FUNCTION enforce_class_booking_validity() RETURNS trigger AS $$
DECLARE
  v_instance_cancelled  timestamptz;
  v_instance_offering   uuid;
  v_instance_resource   uuid;
  v_instance_start      timestamptz;
  v_offering_active     boolean;
  v_offering_member_ok  boolean;
  v_offering_public_ok  boolean;
  v_resource_active     boolean;
  v_link_active         boolean;
  v_is_member_booking   boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.class_instance_id IS NOT DISTINCT FROM OLD.class_instance_id
     AND NEW.member_id         IS NOT DISTINCT FROM OLD.member_id
     AND NEW.hold_expires_at   IS NOT DISTINCT FROM OLD.hold_expires_at
     AND NOT (OLD.status = 'cancelled' AND NEW.status <> 'cancelled')
     -- Force re-validation when transitioning INTO pending_payment.
     -- Otherwise a row can flip back into pending_payment with a stale
     -- hold_expires_at that now outlasts the (possibly moved-earlier)
     -- instance start, and the cross-table hold-bound check below
     -- gets skipped.
     AND NOT (OLD.status <> 'pending_payment' AND NEW.status = 'pending_payment') THEN
    RETURN NEW;
  END IF;

  v_is_member_booking := (NEW.member_id IS NOT NULL);

  -- Instance: exists, not cancelled
  SELECT cancelled_at, offering_id, resource_id, start_time
    INTO v_instance_cancelled, v_instance_offering, v_instance_resource, v_instance_start
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.class_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class instance % not found in tenant %',
      NEW.class_instance_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_instance_cancelled IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot book cancelled class instance %', NEW.class_instance_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Offering: still active, audience allowed
  SELECT active, allow_member_booking, allow_public_booking
    INTO v_offering_active, v_offering_member_ok, v_offering_public_ok
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = v_instance_offering;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found', v_instance_offering
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Offering % has been deactivated', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_member_booking AND NOT v_offering_member_ok THEN
    RAISE EXCEPTION 'Offering % does not allow member bookings', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_is_member_booking AND NOT v_offering_public_ok THEN
    RAISE EXCEPTION 'Offering % does not allow public bookings', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resource: still active
  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = v_instance_resource;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found', v_instance_resource
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Resource % has been deactivated', v_instance_resource
      USING ERRCODE = 'check_violation';
  END IF;

  -- offering_resources link: still active
  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = v_instance_offering
    AND resource_id = v_instance_resource;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      v_instance_offering, v_instance_resource
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      v_instance_offering, v_instance_resource
      USING ERRCODE = 'check_violation';
  END IF;

  -- pending_payment hold can't outlast the instance start
  IF NEW.status = 'pending_payment' AND NEW.hold_expires_at > v_instance_start THEN
    RAISE EXCEPTION 'Hold expires after class instance start time'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_enforce_validity
  BEFORE INSERT OR UPDATE OF class_instance_id, member_id, status, hold_expires_at ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_class_booking_validity();

-- ============================================================
-- prevent_class_instance_id_change (immutability)
-- ============================================================

-- Prevent class_instance_id from changing after insert. Moving a
-- booking between class instances breaks too many invariants
-- (capacity, payment audit, refund tracking). If a tenant ever needs
-- "move this person to a different class," app code does
-- cancel-and-rebook — explicit, auditable.
CREATE OR REPLACE FUNCTION prevent_class_instance_id_change() RETURNS trigger AS $$
BEGIN
  IF NEW.class_instance_id IS DISTINCT FROM OLD.class_instance_id THEN
    RAISE EXCEPTION 'class_instance_id is immutable; cancel and rebook instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_immutable_instance
  BEFORE UPDATE OF class_instance_id ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION prevent_class_instance_id_change();

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Three tables, all RLS-forced (expected: 3 rows, t/t each):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public'
--         AND tablename IN ('class_schedules', 'class_instances', 'class_bookings')
--       ORDER BY tablename;
--
-- 2. All seven class-layer triggers present (expected: 7 rows):
--      SELECT trigger_name, event_object_table FROM information_schema.triggers
--       WHERE trigger_name IN (
--         'class_schedules_enforce_validity',
--         'class_instances_enforce_validity',
--         'bookings_no_class_overlap',
--         'class_instances_no_booking_overlap',
--         'class_bookings_enforce_capacity',
--         'class_bookings_enforce_validity',
--         'class_bookings_immutable_instance')
--       ORDER BY trigger_name;
--
-- 3. enforce_class_schedule_validity rejects schedules on rentals
--    (capacity = 1):
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-008', 'Verify 008', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Cage 1')
--          RETURNING id INTO v_resource_id;
--        -- capacity = 1 (rental, default)
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, allow_public_booking)
--          VALUES (v_tenant_id, 'Half hour', 'cage-time', 30, 1, 3000, true)
--          RETURNING id INTO v_offering_id;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id);
--        BEGIN
--          INSERT INTO class_schedules
--            (tenant_id, offering_id, resource_id, day_of_week,
--             start_time, start_date)
--            VALUES (v_tenant_id, v_offering_id, v_resource_id, 1,
--                    '18:00', (date_trunc('week', now()) + interval '7 days')::date);
--          RAISE EXCEPTION 'FAIL: schedule on rental offering accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: schedule on rental rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 4. class_instances composite FK prevents offering drift from its
--    schedule:
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_off_a       uuid;
--        v_off_b       uuid;
--        v_schedule_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-008b', 'Verify 008b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Room 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, capacity, allow_member_booking, allow_public_booking)
--          VALUES (v_tenant_id, 'Class A', 'classes', 60, 1, 2000, 8, true, true)
--          RETURNING id INTO v_off_a;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, capacity, allow_member_booking, allow_public_booking)
--          VALUES (v_tenant_id, 'Class B', 'classes', 60, 1, 2000, 8, true, true)
--          RETURNING id INTO v_off_b;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_off_a, v_resource_id);
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_off_b, v_resource_id);
--        INSERT INTO class_schedules
--          (tenant_id, offering_id, resource_id, day_of_week, start_time, start_date)
--          VALUES (v_tenant_id, v_off_a, v_resource_id, 1,
--                  '18:00', (date_trunc('week', now()) + interval '7 days')::date)
--          RETURNING id INTO v_schedule_id;
--        BEGIN
--          INSERT INTO class_instances
--            (tenant_id, class_schedule_id, offering_id, resource_id,
--             start_time, end_time, capacity)
--            VALUES (v_tenant_id, v_schedule_id, v_off_b, v_resource_id,
--                    now() + interval '7 days',
--                    now() + interval '7 days 1 hour', 8);
--          RAISE EXCEPTION 'FAIL: instance with drifted offering accepted';
--        EXCEPTION WHEN foreign_key_violation THEN
--          RAISE NOTICE 'PASS: composite FK rejected offering drift';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. class_bookings.class_instance_id is immutable. Inserting then
--    updating to a different instance must error.
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id     uuid;
--        v_resource_id   uuid;
--        v_offering_id   uuid;
--        v_instance_a    uuid;
--        v_instance_b    uuid;
--        v_booking_id    uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-008c', 'Verify 008c', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO resources (tenant_id, name) VALUES (v_tenant_id, 'Room 1')
--          RETURNING id INTO v_resource_id;
--        INSERT INTO offerings
--          (tenant_id, name, category, duration_minutes, credit_cost,
--           dollar_price, capacity, allow_member_booking, allow_public_booking)
--          VALUES (v_tenant_id, 'C', 'classes', 60, 1, 2000, 8, true, true)
--          RETURNING id INTO v_offering_id;
--        INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id);
--        INSERT INTO class_instances
--          (tenant_id, offering_id, resource_id, start_time, end_time, capacity)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                  now() + interval '7 days',
--                  now() + interval '7 days 1 hour', 8)
--          RETURNING id INTO v_instance_a;
--        INSERT INTO class_instances
--          (tenant_id, offering_id, resource_id, start_time, end_time, capacity)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                  now() + interval '8 days',
--                  now() + interval '8 days 1 hour', 8)
--          RETURNING id INTO v_instance_b;
--        -- free customer booking: amount_due=0, payment_status=not_required
--        INSERT INTO class_bookings
--          (tenant_id, class_instance_id,
--           customer_first_name, customer_last_name, customer_email,
--           amount_due_cents, payment_status)
--          VALUES (v_tenant_id, v_instance_a,
--                  'Walk', 'In', 'w@example.com', 0, 'not_required')
--          RETURNING id INTO v_booking_id;
--        BEGIN
--          UPDATE class_bookings SET class_instance_id = v_instance_b
--           WHERE id = v_booking_id;
--          RAISE EXCEPTION 'FAIL: class_instance_id update accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: class_instance_id update rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
