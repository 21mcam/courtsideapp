-- Migration 031 — booking import provenance (external_source/external_id)
--
-- The Momentum → Courtside data migration (Phase 6) imports years of
-- Setmore appointments and Diamond member bookings. Before this
-- migration, rerunning the loader deduplicated only by accident: the
-- GiST overlap exclusion rejected a second INSERT with an identical
-- time range on the same resource, and the loader treated that
-- rejection as "already there". Two problems with leaning on that:
--
--   1. The exclusion is PARTIAL — WHERE (status <> 'cancelled') — so
--      cancelled bookings never participate. A rerun silently
--      duplicated every cancelled historical booking, and nothing
--      counted the duplicates.
--   2. "Same resource + same time range" is not identity. Two source
--      systems (Setmore walk-ins, Diamond member bookings) can
--      legitimately disagree about one slot; conflating "this exact
--      source row is already loaded" with "some row occupies this
--      slot" hides real double-booking conflicts the operator must
--      adjudicate.
--
-- The fix is an explicit provenance pair on bookings:
--
--   external_source — which system the row was imported from
--                     ('setmore' | 'diamond'). Deliberately narrow;
--                     widen the CHECK when a third source actually
--                     exists, not speculatively.
--   external_id     — the row's id in that system (Setmore
--                     appointment id, Diamond booking uuid).
--
-- Both NULL for bookings born in Courtside — provenance is strictly
-- an import concept, so the pair comes together or not at all
-- (both-or-neither CHECK). The partial unique index on
-- (tenant_id, external_source, external_id) is the loader's
-- idempotency key: 03_load INSERTs with ON CONFLICT on it, so a
-- rerun cleanly reports "already present" per row — including
-- cancelled rows — while genuine slot overlaps still surface as
-- exclusion violations to be reviewed, not swallowed.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 031_booking_import_provenance.sql
-- Depends on: 007 (bookings).
-- Verify: see commented block at end.

ALTER TABLE bookings
  ADD COLUMN external_source text
    CONSTRAINT bookings_external_source_known
    CHECK (external_source IS NULL OR external_source IN ('setmore', 'diamond')),
  ADD COLUMN external_id text
    CONSTRAINT bookings_external_id_not_blank
    CHECK (external_id IS NULL OR btrim(external_id) <> '');

-- Provenance is a pair: an imported booking carries both, a
-- Courtside-born booking carries neither. Half-set provenance would
-- make the idempotency key silently inapplicable.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_external_both_or_neither
  CHECK ((external_source IS NULL) = (external_id IS NULL));

-- The loader's idempotency key. Partial: Courtside-born rows
-- (external_id NULL) never contend, and NULLs wouldn't conflict in a
-- plain unique index anyway.
CREATE UNIQUE INDEX bookings_external_import_unique
  ON bookings (tenant_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

COMMENT ON COLUMN bookings.external_source IS
  'Import provenance: which external system this booking came from '
  '(''setmore'' walk-ins, ''diamond'' member bookings). NULL for '
  'bookings born in Courtside. With external_id, forms the migration '
  'loader''s idempotency key (bookings_external_import_unique) — '
  'before it, loader reruns deduped only via the GiST overlap '
  'exclusion, which never covered cancelled bookings.';

COMMENT ON COLUMN bookings.external_id IS
  'Import provenance: the booking''s id in external_source (Setmore '
  'appointment id / Diamond booking id). NULL for bookings born in '
  'Courtside. See external_source for why this pair exists.';

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Columns present, both nullable (expected: 2 rows, YES/YES):
--      SELECT column_name, is_nullable FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'bookings'
--         AND column_name IN ('external_source', 'external_id')
--       ORDER BY column_name;
--
-- 2. Named CHECKs present (expected: 3 rows):
--      SELECT conname FROM pg_constraint
--       WHERE conrelid = 'bookings'::regclass
--         AND conname IN ('bookings_external_source_known',
--                         'bookings_external_id_not_blank',
--                         'bookings_external_both_or_neither')
--       ORDER BY conname;
--
-- 3. Partial unique index present (expected: 1 row):
--      SELECT indexname FROM pg_indexes
--       WHERE schemaname = 'public' AND tablename = 'bookings'
--         AND indexname = 'bookings_external_import_unique';
--
-- 4. Both-or-neither + dedup behavior:
--      BEGIN;
--      DO $$
--      DECLARE
--        v_tenant_id   uuid;
--        v_resource_id uuid;
--        v_offering_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-031', 'Verify 031', 'America/New_York')
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
--        -- half-set provenance rejected
--        BEGIN
--          INSERT INTO bookings
--            (tenant_id, offering_id, resource_id,
--             customer_first_name, customer_last_name, customer_email,
--             start_time, end_time, amount_due_cents,
--             external_source, external_id)
--            VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                    'Walk', 'In', 'w@example.com',
--                    now() + interval '1 day', now() + interval '1 day 30 minutes',
--                    0, 'setmore', NULL);
--          RAISE EXCEPTION 'FAIL: half-set provenance accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: half-set provenance rejected';
--        END;
--        -- a cancelled import dedupes on the unique index (the GiST
--        -- exclusion would NOT have caught this — that is the bug
--        -- this migration fixes)
--        INSERT INTO bookings
--          (tenant_id, offering_id, resource_id,
--           customer_first_name, customer_last_name, customer_email,
--           start_time, end_time, amount_due_cents,
--           status, cancelled_at, external_source, external_id)
--          VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                  'Walk', 'In', 'w@example.com',
--                  now() + interval '1 day', now() + interval '1 day 30 minutes',
--                  0, 'cancelled', now(), 'setmore', 'appt-1');
--        BEGIN
--          INSERT INTO bookings
--            (tenant_id, offering_id, resource_id,
--             customer_first_name, customer_last_name, customer_email,
--             start_time, end_time, amount_due_cents,
--             status, cancelled_at, external_source, external_id)
--            VALUES (v_tenant_id, v_offering_id, v_resource_id,
--                    'Walk', 'In', 'w@example.com',
--                    now() + interval '1 day', now() + interval '1 day 30 minutes',
--                    0, 'cancelled', now(), 'setmore', 'appt-1');
--          RAISE EXCEPTION 'FAIL: duplicate cancelled import accepted';
--        EXCEPTION WHEN unique_violation THEN
--          RAISE NOTICE 'PASS: duplicate cancelled import rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
