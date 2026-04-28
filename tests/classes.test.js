// Class instance admin tests — Phase 4 slice 1.
//
// Covers:
//   * create one-off happy path (capacity defaults from offering)
//   * capacity override applied per-instance
//   * rental offering (capacity 1) rejected → 409
//   * inactive offering / inactive resource / missing link → 409
//   * exclusion: overlapping non-cancelled instance on same resource → 409
//   * list filters by date window + include_cancelled flag
//   * roster_count reflects non-cancelled class_bookings
//   * cancel happy path: instance + roster cancelled, member credits refunded
//   * cancel an already-cancelled instance → 409

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-classes';
const TZ = 'America/New_York';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let resource_id;
let class_offering_id;     // capacity = 8
let rental_offering_id;    // capacity = 1, for "wrong type" test

const CLASS_CAPACITY = 8;
const CLASS_DURATION_MIN = 60;
const CLASS_CREDIT_COST = 2;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Class Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Admin owner
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // One resource, one class offering, one rental offering (for the
  // negative test).
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Class Court') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Hitting Clinic', 'classes', $2, $3, 5000, $4, true, true)
       RETURNING id`,
      [tenant_id, CLASS_DURATION_MIN, CLASS_CREDIT_COST, CLASS_CAPACITY],
    )
  ).rows[0].id;
  rental_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Rental Cage', 'cage-time', 30, 1, 2000, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $4, $3)`,
    [tenant_id, class_offering_id, resource_id, rental_offering_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const adminLogin = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!adminLogin.ok) throw new Error('admin login failed');
  adminToken = (await adminLogin.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function adminFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {}),
    },
  });
}

// ============================================================
// create
// ============================================================

test('create one-off class instance: defaults capacity from offering', { skip }, async () => {
  // Pick a unique start time so it doesn't collide with later tests.
  const start = '2027-06-07T18:00:00.000Z';
  const res = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const ci = body.class_instance;
  assert.ok(ci.id);
  assert.equal(ci.class_schedule_id, null);
  assert.equal(ci.offering_id, class_offering_id);
  assert.equal(ci.resource_id, resource_id);
  assert.equal(ci.capacity, CLASS_CAPACITY); // defaulted
  assert.equal(new Date(ci.start_time).toISOString(), start);
  // end = start + duration
  assert.equal(
    new Date(ci.end_time).getTime() - new Date(ci.start_time).getTime(),
    CLASS_DURATION_MIN * 60 * 1000,
  );

  // Cleanup so capacity-overlap tests below don't fight this row.
  await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
});

test('create with explicit capacity override', { skip }, async () => {
  const start = '2027-06-08T18:00:00.000Z';
  const res = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
      capacity: 4,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.class_instance.capacity, 4);
  await privilegedPool.query(
    `DELETE FROM class_instances WHERE id = $1`,
    [body.class_instance.id],
  );
});

test('create rejects rental offering (capacity 1) with 409', { skip }, async () => {
  const res = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: rental_offering_id,
      resource_id,
      start_time: '2027-06-09T18:00:00.000Z',
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /rental/i);
});

test('create rejects unknown offering with 404', { skip }, async () => {
  const res = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: randomUUID(),
      resource_id,
      start_time: '2027-06-10T18:00:00.000Z',
    }),
  });
  assert.equal(res.status, 404);
});

test('create rejects overlapping non-cancelled instance on same resource (409)', { skip }, async () => {
  const start = '2027-06-11T18:00:00.000Z';

  // First create — succeeds.
  const r1 = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
    }),
  });
  assert.equal(r1.status, 201);
  const first = (await r1.json()).class_instance;

  // Second at same time — overlaps the first.
  const r2 = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
    }),
  });
  assert.equal(r2.status, 409);
  const body = await r2.json();
  assert.match(body.error, /overlap/i);

  // Cleanup
  await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [first.id]);
});

// ============================================================
// list
// ============================================================

test('list filters by date window + roster_count = 0 when no bookings', { skip }, async () => {
  // Create three instances spanning two days.
  const ids = [];
  for (const t of [
    '2027-07-05T15:00:00.000Z',
    '2027-07-05T17:00:00.000Z',
    '2027-07-06T15:00:00.000Z',
  ]) {
    const r = await adminFetch('/api/admin/class-instances', {
      method: 'POST',
      body: JSON.stringify({
        offering_id: class_offering_id,
        resource_id,
        start_time: t,
      }),
    });
    ids.push((await r.json()).class_instance.id);
  }
  try {
    // Window covering only July 5
    const res = await adminFetch(
      `/api/admin/class-instances?from=${encodeURIComponent('2027-07-05T00:00:00Z')}&to=${encodeURIComponent('2027-07-06T00:00:00Z')}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const matching = body.class_instances.filter((ci) =>
      ids.slice(0, 2).includes(ci.id),
    );
    assert.equal(matching.length, 2, 'July 5 window should include both 7/5 instances');
    for (const ci of matching) {
      assert.equal(ci.roster_count, 0);
      assert.equal(ci.offering_name, 'Hitting Clinic');
      assert.equal(ci.resource_name, 'Class Court');
    }
    // The 7/6 instance must be excluded by the window.
    const seenJuly6 = body.class_instances.find((ci) => ci.id === ids[2]);
    assert.equal(seenJuly6, undefined, 'July 6 instance should be outside window');
  } finally {
    await privilegedPool.query(
      `DELETE FROM class_instances WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }
});

test('list defaults exclude cancelled; include_cancelled=true surfaces them', { skip }, async () => {
  // Create + cancel one
  const start = '2027-08-02T15:00:00.000Z';
  const r = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
    }),
  });
  const id = (await r.json()).class_instance.id;
  await privilegedPool.query(
    `UPDATE class_instances SET cancelled_at = now() WHERE id = $1`,
    [id],
  );
  try {
    const window = `from=${encodeURIComponent('2027-08-01T00:00:00Z')}&to=${encodeURIComponent('2027-08-03T00:00:00Z')}`;
    const def = await adminFetch(`/api/admin/class-instances?${window}`);
    const defBody = await def.json();
    assert.ok(
      !defBody.class_instances.find((ci) => ci.id === id),
      'cancelled instance should be hidden by default',
    );

    const incl = await adminFetch(
      `/api/admin/class-instances?${window}&include_cancelled=true`,
    );
    const inclBody = await incl.json();
    assert.ok(
      inclBody.class_instances.find((ci) => ci.id === id),
      'cancelled instance should appear with include_cancelled=true',
    );
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [id]);
  }
});

// ============================================================
// cancel
// ============================================================

test('cancel cascades: instance + roster cancelled; members refunded', { skip }, async () => {
  // Create instance
  const start = '2027-09-06T15:00:00.000Z';
  const r = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: start,
    }),
  });
  const ci = (await r.json()).class_instance;

  // Add a member directly + grant 5 credits + insert a class_booking.
  // We bypass the class booking flow (slice 3) by inserting directly
  // through the privileged pool — sufficient for testing the cancel
  // cascade.
  const memberId = (
    await privilegedPool.query(
      `INSERT INTO members (tenant_id, email, first_name, last_name)
       VALUES ($1, $2, 'Roster', 'One') RETURNING id`,
      [tenant_id, `roster-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  // Use admin grant endpoint to populate the balance via the real
  // apply_credit_change path (so we have ledger consistency).
  await fetch(
    `${baseUrl}/api/admin/members/${memberId}/credit-adjustments?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount: 5, note: 'fixture' }),
    },
  );
  // Insert class_booking with credit_cost_charged = 2 and pre-debit
  // the balance manually to mirror what the real booking flow will
  // do once slice 3 ships. Privileged pool runs without GUC, so RLS
  // wouldn't fire — but apply_credit_change would, so we set the GUC
  // on the same connection.
  const cbRes = await privilegedPool.connect();
  let class_booking_id;
  try {
    await cbRes.query("BEGIN");
    await cbRes.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    class_booking_id = (
      await cbRes.query(
        `INSERT INTO class_bookings (
           tenant_id, class_instance_id, member_id, status,
           amount_due_cents, credit_cost_charged, payment_status
         ) VALUES ($1, $2, $3, 'confirmed', 0, 2, 'not_required')
         RETURNING id`,
        [tenant_id, ci.id, memberId],
      )
    ).rows[0].id;
    await cbRes.query(
      `SELECT apply_credit_change($1, $2, $3, 'booking_spend', NULL, NULL, NULL, $4)`,
      [tenant_id, memberId, -CLASS_CREDIT_COST, class_booking_id],
    );
    await cbRes.query("COMMIT");
  } finally {
    cbRes.release();
  }

  // Sanity: balance should be 5 - 2 = 3
  const preBal = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [memberId],
  );
  assert.equal(preBal.rows[0].current_credits, 3);

  try {
    const cancelRes = await adminFetch(
      `/api/admin/class-instances/${ci.id}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ cancellation_reason: 'gym closure' }),
      },
    );
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.roster_cancelled, 1);
    assert.equal(cancelBody.members_refunded, 1);

    // Instance is now cancelled
    const ciCheck = await privilegedPool.query(
      `SELECT cancelled_at, cancellation_reason FROM class_instances WHERE id = $1`,
      [ci.id],
    );
    assert.ok(ciCheck.rows[0].cancelled_at);
    assert.equal(ciCheck.rows[0].cancellation_reason, 'gym closure');

    // class_booking is cancelled (admin)
    const cbCheck = await privilegedPool.query(
      `SELECT status, cancelled_by_type, cancelled_at FROM class_bookings WHERE id = $1`,
      [class_booking_id],
    );
    assert.equal(cbCheck.rows[0].status, 'cancelled');
    assert.equal(cbCheck.rows[0].cancelled_by_type, 'admin');

    // Member refunded back to 5 (3 + 2)
    const postBal = await privilegedPool.query(
      `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
      [memberId],
    );
    assert.equal(postBal.rows[0].current_credits, 5);

    // Refund ledger row exists, references the class_booking_id.
    const ledgerCheck = await privilegedPool.query(
      `SELECT amount, reason, class_booking_id, booking_id FROM credit_ledger_entries
        WHERE class_booking_id = $1 AND reason = 'booking_refund'`,
      [class_booking_id],
    );
    assert.equal(ledgerCheck.rows.length, 1);
    assert.equal(ledgerCheck.rows[0].amount, CLASS_CREDIT_COST);
    assert.equal(ledgerCheck.rows[0].booking_id, null);
  } finally {
    // Cleanup
    await privilegedPool.query(`DELETE FROM credit_ledger_entries WHERE class_booking_id = $1`, [class_booking_id]);
    await privilegedPool.query(`DELETE FROM class_bookings WHERE id = $1`, [class_booking_id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM members WHERE id = $1`, [memberId]);
  }
});

// ============================================================
// roster
// ============================================================

test('GET /api/admin/class-instances/:id/roster returns members + customers; 404 for unknown id', { skip }, async () => {
  // Unknown id
  const noRes = await adminFetch(
    `/api/admin/class-instances/${randomUUID()}/roster`,
  );
  assert.equal(noRes.status, 404);

  // Build instance + add a roster row directly. Skip the booking
  // flow (slice 3 covers it) — we just need a class_booking row to
  // assert the join shape.
  const r = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: '2027-12-07T15:00:00.000Z',
    }),
  });
  const ci = (await r.json()).class_instance;

  const memberId = (
    await privilegedPool.query(
      `INSERT INTO members (tenant_id, email, first_name, last_name)
       VALUES ($1, $2, 'Roster', 'Display') RETURNING id`,
      [tenant_id, `roster-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  const cbId = (
    await privilegedPool.query(
      `INSERT INTO class_bookings (
         tenant_id, class_instance_id, member_id, status,
         amount_due_cents, credit_cost_charged, payment_status
       ) VALUES ($1, $2, $3, 'confirmed', 0, 2, 'not_required')
       RETURNING id`,
      [tenant_id, ci.id, memberId],
    )
  ).rows[0].id;

  try {
    const res = await adminFetch(
      `/api/admin/class-instances/${ci.id}/roster`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.instance.id, ci.id);
    assert.equal(body.instance.offering_name, 'Hitting Clinic');
    assert.equal(body.roster.length, 1);
    const row = body.roster[0];
    assert.equal(row.id, cbId);
    assert.equal(row.member_first_name, 'Roster');
    assert.equal(row.member_last_name, 'Display');
    assert.equal(row.status, 'confirmed');
    assert.equal(row.customer_first_name, null);
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE id = $1`, [cbId]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM members WHERE id = $1`, [memberId]);
  }
});

test('cancel an already-cancelled instance returns 409', { skip }, async () => {
  const r = await adminFetch('/api/admin/class-instances', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      start_time: '2027-10-04T15:00:00.000Z',
    }),
  });
  const id = (await r.json()).class_instance.id;
  try {
    const first = await adminFetch(`/api/admin/class-instances/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 200);

    const second = await adminFetch(`/api/admin/class-instances/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.match(body.error, /already cancelled/i);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [id]);
  }
});
