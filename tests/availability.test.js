// Availability engine tests — Phase 3 slice 1.
//
// Each test sets up its own resource + offering (with active
// offering_resources link) so cross-test state never leaks. Tenant
// stays the same across tests for setup speed.
//
// Tenant timezone is America/New_York. Most tests use 2027-01-04
// (Monday, EST, no DST in winter). The DST test pins to 2026-03-08
// (Sunday — US spring-forward) so the assertion can verify the
// "lost hour" doesn't produce a phantom slot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-availability';
const TZ = 'America/New_York';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Availability Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  const t = await privilegedPool.query(
    `SELECT id FROM tenants WHERE subdomain = $1`,
    [TENANT],
  );
  tenant_id = t.rows[0].id;

  // The tests below were written for back-to-back slicing (slot starts
  // every <duration>). Since migration 036 that's the explicit NULL
  // "match each service's length" setting; the start-time grid tests
  // at the bottom switch it on per test via withSlotInterval().
  await privilegedPool.query(
    `INSERT INTO booking_policies (tenant_id, slot_interval_minutes)
     VALUES ($1, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET slot_interval_minutes = NULL`,
    [tenant_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
// ============================================================

async function makeResource(name = `Cage ${randomUUID().slice(0, 6)}`) {
  const r = await privilegedPool.query(
    `INSERT INTO resources (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenant_id, name],
  );
  return r.rows[0].id;
}

async function makeOffering({
  duration_minutes = 60,
  capacity = 1,
  allow_public_booking = true,
} = {}) {
  const o = await privilegedPool.query(
    `INSERT INTO offerings
       (tenant_id, name, category, duration_minutes, credit_cost,
        dollar_price, capacity, allow_member_booking, allow_public_booking)
     VALUES ($1, $2, 'cage-time', $3, 1, 0, $4, true, $5)
     RETURNING id`,
    [
      tenant_id,
      `Offering ${randomUUID().slice(0, 6)}`,
      duration_minutes,
      capacity,
      allow_public_booking,
    ],
  );
  return o.rows[0].id;
}

async function linkOfferingResource(offering_id, resource_id) {
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offering_id, resource_id],
  );
}

async function makeOperatingHours(resource_id, dow, openTime, closeTime) {
  await privilegedPool.query(
    `INSERT INTO operating_hours
       (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenant_id, resource_id, dow, openTime, closeTime],
  );
}

async function makeBlackout({
  resource_id = null,
  offering_id = null,
  starts_at,
  ends_at,
}) {
  await privilegedPool.query(
    `INSERT INTO blackouts
       (tenant_id, resource_id, offering_id, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenant_id, resource_id, offering_id, starts_at, ends_at],
  );
}

async function makeBooking(offering_id, resource_id, start_iso, end_iso) {
  // Customer booking, payment_status='not_required', amount_due_cents=0
  // — the simplest valid shape that the enforce_booking_validity
  // trigger accepts.
  await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id,
       customer_first_name, customer_last_name, customer_email,
       start_time, end_time,
       amount_due_cents, payment_status, status
     )
     VALUES (
       $1, $2, $3,
       'Walk', 'In', $4,
       $5, $6,
       0, 'not_required', 'confirmed'
     )`,
    [
      tenant_id,
      offering_id,
      resource_id,
      `walk-${randomUUID()}@example.com`,
      start_iso,
      end_iso,
    ],
  );
}

function fetchAvailability({ resource_id, offering_id, date }) {
  const url =
    `${baseUrl}/api/availability?` +
    `resource_id=${resource_id}&offering_id=${offering_id}&date=${date}` +
    `&tenant=${TENANT}`;
  return fetch(url);
}

// ============================================================
// Tests
// ============================================================

const MONDAY_EST = '2027-01-04'; // Monday, EST winter, far future
const DOW_MONDAY = 1;

test('no operating_hours → empty slots', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.slots, []);
});

test('open 9-17, no occupied → 8 hourly slots', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();
  assert.equal(body.slots.length, 8, 'expected 8 hourly slots in 9-17 window');

  // First slot should start at 9am EST = 14:00 UTC.
  assert.equal(body.slots[0].start, '2027-01-04T14:00:00.000Z');
  assert.equal(body.slots[0].end, '2027-01-04T15:00:00.000Z');
  assert.equal(body.slots[7].end, '2027-01-04T22:00:00.000Z');
});

test('booking carved out of middle → split into two ranges', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  // Insert a confirmed booking 11:00-12:00 EST on the same resource.
  // 11:00 EST = 16:00 UTC. (Use the same offering for the existing
  // booking so the validity trigger passes.)
  await makeBooking(
    offering_id,
    resource_id,
    '2027-01-04T16:00:00Z',
    '2027-01-04T17:00:00Z',
  );

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();

  // Available: 9-11 (2 slots) and 12-17 (5 slots) = 7 slots.
  assert.equal(body.slots.length, 7);
  // None should be the 11:00 EST = 16:00 UTC slot
  const blocked = body.slots.find((s) => s.start === '2027-01-04T16:00:00.000Z');
  assert.equal(blocked, undefined, 'blocked slot must not appear');
});

test('facility-wide blackout covering whole day → 0 slots', { skip }, async () => {
  // Use a DIFFERENT Monday than other tests — facility-wide blackouts
  // persist across tests in the shared tenant, and we don't want
  // this one to bleed into the unrelated-blackout / split-shifts /
  // offering-blackout tests that all key off MONDAY_EST.
  const ISOLATED_MONDAY = '2027-01-11';
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  await makeBlackout({
    resource_id: null,
    offering_id: null,
    starts_at: '2027-01-11T00:00:00Z',
    ends_at: '2027-01-12T00:00:00Z',
  });

  const res = await fetchAvailability({
    resource_id,
    offering_id,
    date: ISOLATED_MONDAY,
  });
  const body = await res.json();
  assert.equal(body.slots.length, 0);
});

test('resource-targeted blackout on different resource → does NOT affect this one', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  // Blackout on a DIFFERENT resource — must not subtract from this
  // resource's availability.
  const other_resource_id = await makeResource('Other Cage');
  await makeBlackout({
    resource_id: other_resource_id,
    starts_at: '2027-01-04T14:00:00Z',
    ends_at: '2027-01-04T16:00:00Z',
  });

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();
  assert.equal(body.slots.length, 8, 'unrelated resource blackout should not affect this resource');
});

test('offering-targeted blackout reduces availability for that offering', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  // Pause this specific offering 10:00-12:00 EST = 15:00-17:00 UTC.
  await makeBlackout({
    offering_id,
    starts_at: '2027-01-04T15:00:00Z',
    ends_at: '2027-01-04T17:00:00Z',
  });

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();
  // 8 hours - 2 hours = 6 slots
  assert.equal(body.slots.length, 6);
});

test('split shifts: 9-12 and 14-17 → two contiguous slot blocks', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '12:00');
  await makeOperatingHours(resource_id, DOW_MONDAY, '14:00', '17:00');

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();
  // 3 hours + 3 hours = 6 slots; the 12-14 lunch break is a gap
  assert.equal(body.slots.length, 6);
  // Find the 11:00 EST = 16:00 UTC slot — last of morning shift
  assert.ok(body.slots.some((s) => s.start === '2027-01-04T16:00:00.000Z'));
  // Find the 14:00 EST = 19:00 UTC slot — first of afternoon shift
  assert.ok(body.slots.some((s) => s.start === '2027-01-04T19:00:00.000Z'));
  // 12:00 EST and 13:00 EST must NOT be slot starts
  assert.ok(!body.slots.some((s) => s.start === '2027-01-04T17:00:00.000Z'));
  assert.ok(!body.slots.some((s) => s.start === '2027-01-04T18:00:00.000Z'));
});

test('DST spring-forward day: 1am-5am yields 3 slots, not 4 (the lost hour)', { skip }, async () => {
  // 2027-03-14 is the US DST start. 02:00-03:00 local time does not
  // exist on this day; it jumps from 01:59:59 EST to 03:00:00 EDT.
  // Operating hours 1am-5am defines a 4-hour wall-clock window but
  // a 3-hour real-time window. We must produce 3 slots (not 4) for
  // a 60-min duration.
  //
  // Pinned to a FUTURE spring-forward date: availability now trims
  // slots that already started (min-advance filter), so a historical
  // DST date would return zero slots regardless of interval math.
  const DST_DATE = '2027-03-14';
  const DOW_SUNDAY = 0;
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_SUNDAY, '01:00', '05:00');

  const res = await fetchAvailability({ resource_id, offering_id, date: DST_DATE });
  const body = await res.json();
  assert.equal(
    body.slots.length,
    3,
    'spring-forward must collapse a 4-wall-hour window to 3 real-hour slots',
  );

  // First slot: 01:00 EST = 06:00 UTC
  assert.equal(body.slots[0].start, '2027-03-14T06:00:00.000Z');
  assert.equal(body.slots[0].end, '2027-03-14T07:00:00.000Z');

  // Second slot: post-DST. UTC 07:00 = 03:00 EDT (since DST started
  // at the moment 01:59:59 EST → 03:00:00 EDT, both at UTC 07:00).
  assert.equal(body.slots[1].start, '2027-03-14T07:00:00.000Z');
  assert.equal(body.slots[1].end, '2027-03-14T08:00:00.000Z');

  // Third slot: UTC 08:00 = 04:00 EDT
  assert.equal(body.slots[2].start, '2027-03-14T08:00:00.000Z');
  assert.equal(body.slots[2].end, '2027-03-14T09:00:00.000Z');
});

test('min_advance_booking_minutes trims near-term slots and rides the response', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, 1, '09:00', '17:00'); // Mondays

  // Baseline: no policy row → min advance 0, slots present.
  const before_ = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const beforeBody = await before_.json();
  assert.ok(beforeBody.slots.length > 0);
  assert.equal(beforeBody.min_advance_booking_minutes, 0);

  // Push the floor past the fixture date entirely (~208 days out —
  // MONDAY_EST is fixed, "now" moves, so an exact-boundary assertion
  // would rot; beyond-the-date is stable until 2027).
  await privilegedPool.query(
    `INSERT INTO booking_policies
       (tenant_id, min_advance_booking_minutes, max_advance_booking_days)
     VALUES ($1, 300000, 400)
     ON CONFLICT (tenant_id) DO UPDATE SET
       min_advance_booking_minutes = EXCLUDED.min_advance_booking_minutes,
       max_advance_booking_days = EXCLUDED.max_advance_booking_days`,
    [tenant_id],
  );
  try {
    const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
    const body = await res.json();
    assert.deepEqual(body.slots, []);
    assert.equal(body.min_advance_booking_minutes, 300000);
    assert.equal(body.max_advance_booking_days, 400);
  } finally {
    // Back to defaults, keeping the file-wide back-to-back setting.
    await privilegedPool.query(
      `UPDATE booking_policies
          SET min_advance_booking_minutes = 0, max_advance_booking_days = 30
        WHERE tenant_id = $1`,
      [tenant_id],
    );
  }
});

test('class offering → returns empty + reason (slot model is rentals only)', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60, capacity: 8 });
  await linkOfferingResource(offering_id, resource_id);

  const res = await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST });
  const body = await res.json();
  assert.deepEqual(body.slots, []);
  assert.match(body.reason, /class/i);
});

// ============================================================
// Start-time grid (migration 036: booking_policies.slot_interval_minutes)
// ============================================================

async function withSlotInterval(minutes, fn) {
  await privilegedPool.query(
    `UPDATE booking_policies SET slot_interval_minutes = $2 WHERE tenant_id = $1`,
    [tenant_id, minutes],
  );
  try {
    return await fn();
  } finally {
    await privilegedPool.query(
      `UPDATE booking_policies SET slot_interval_minutes = NULL WHERE tenant_id = $1`,
      [tenant_id],
    );
  }
}

const starts = (body) => body.slots.map((s) => s.start);

test('30-min grid: 60-min service on an empty 9-17 cage starts every half hour', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  await withSlotInterval(30, async () => {
    const body = await (await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST })).json();
    // 9:00, 9:30, … 16:00 = 15 starts; each slot is still 60 min.
    assert.equal(body.slots.length, 15);
    assert.equal(body.slot_interval_minutes, 30);
    assert.equal(body.slots[1].start, '2027-01-04T14:30:00.000Z'); // 9:30 EST
    assert.equal(body.slots[1].end, '2027-01-04T15:30:00.000Z');
    assert.equal(body.slots[14].start, '2027-01-04T21:00:00.000Z'); // 16:00 EST
    assert.equal(body.slots[14].end, '2027-01-04T22:00:00.000Z');
  });
});

test('30-min grid: 90-min service is offered at 10:30, not just 9:00/10:30/12:00', { skip }, async () => {
  // The Momentum case: Setmore offers 1.5-hour sessions on the
  // half-hour grid; back-to-back slicing only gave 9:00, 10:30, 12:00…
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 90 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');

  await withSlotInterval(30, async () => {
    const body = await (await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST })).json();
    const s = starts(body);
    assert.ok(s.includes('2027-01-04T15:00:00.000Z'), '10:00 EST start offered');
    assert.ok(s.includes('2027-01-04T19:30:00.000Z'), '14:30 EST start offered');
    // Last start 15:30 EST (ends at 17:00 close).
    assert.equal(s[s.length - 1], '2027-01-04T20:30:00.000Z');
    assert.equal(s.length, 14); // 9:00 … 15:30
  });
});

test('30-min grid: an off-grid booking end snaps the next start to the grid', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:00', '17:00');
  // Existing booking 9:00–10:45 EST (e.g. imported, or front desk
  // snapped to 15 min).
  await makeBooking(offering_id, resource_id, '2027-01-04T14:00:00Z', '2027-01-04T15:45:00Z');

  await withSlotInterval(30, async () => {
    const body = await (await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST })).json();
    const s = starts(body);
    assert.equal(s[0], '2027-01-04T16:00:00.000Z', 'first start is 11:00 EST, not 10:45');
    assert.ok(s.every((iso) => [0, 30].includes(new Date(iso).getUTCMinutes())));
  });
});

test('30-min grid anchors to opening time, per shift', { skip }, async () => {
  const resource_id = await makeResource();
  const offering_id = await makeOffering({ duration_minutes: 60 });
  await linkOfferingResource(offering_id, resource_id);
  await makeOperatingHours(resource_id, DOW_MONDAY, '09:15', '11:15');
  await makeOperatingHours(resource_id, DOW_MONDAY, '13:00', '14:00');

  await withSlotInterval(30, async () => {
    const body = await (await fetchAvailability({ resource_id, offering_id, date: MONDAY_EST })).json();
    assert.deepEqual(starts(body), [
      '2027-01-04T14:15:00.000Z', // 9:15
      '2027-01-04T14:45:00.000Z', // 9:45
      '2027-01-04T15:15:00.000Z', // 10:15
      '2027-01-04T18:00:00.000Z', // 13:00
    ]);
  });
});
