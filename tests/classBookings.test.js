// Member class-booking flow tests — Phase 4 slice 3.
//
// Mirrors tests/bookings.test.js but exercises class_bookings.
// Self-contained tenant + class offering + class instance fixtures.
//
// Each test that creates a booking on the shared instance must
// either cancel it inline or use a fresh instance — the partial
// unique index on (tenant, class_instance, member) is per-member,
// so different members can share an instance.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-class-bookings';
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
let class_offering_id;
const CLASS_CAPACITY = 8;
const CLASS_CREDIT_COST = 2;
const CLASS_DURATION_MIN = 60;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Class Booking Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Admin owner — used to grant credits + run no-show tests.
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
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, class_offering_id, resource_id],
  );

  // Permissive policy. Specific tests below tighten then restore.
  await privilegedPool.query(
    `INSERT INTO booking_policies (
       tenant_id, free_cancel_hours_before,
       partial_refund_hours_before, partial_refund_percent,
       allow_member_self_cancel,
       min_advance_booking_minutes, max_advance_booking_days
     ) VALUES ($1, 24, 6, 50, true, 0, 730)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant_id],
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

// ============================================================
// helpers
// ============================================================

async function newMember() {
  const email = `member-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        first_name: 'Class',
        last_name: 'Booker',
      }),
    },
  );
  if (!reg.ok) throw new Error(`register-member failed: HTTP ${reg.status}`);
  return reg.json();
}

async function grantCredits(member_id, amount) {
  const res = await fetch(
    `${baseUrl}/api/admin/members/${member_id}/credit-adjustments?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount, note: 'fixture' }),
    },
  );
  if (!res.ok) throw new Error(`grantCredits failed: HTTP ${res.status}`);
  return res.json();
}

function memberFetch(token, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

// Create a class instance via privileged pool. Tests pick a unique
// start_time per instance — the GiST exclusion on resource means
// concurrent confirmed instances on the same resource conflict.
async function newInstance({ start_time, capacity = CLASS_CAPACITY }) {
  const start = new Date(start_time);
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, $6)
     RETURNING id, start_time, end_time, capacity`,
    [tenant_id, class_offering_id, resource_id, start, end, capacity],
  );
  return r.rows[0];
}

// Also create a class_booking row directly (used by cancel tests
// that need to put bookings near `now`).
async function syntheticClassBooking({ class_instance_id, member_id, credits = CLASS_CREDIT_COST }) {
  const r = await privilegedPool.query(
    `INSERT INTO class_bookings
       (tenant_id, class_instance_id, member_id, status,
        amount_due_cents, credit_cost_charged, payment_status)
     VALUES ($1, $2, $3, 'confirmed', 0, $4, 'not_required')
     RETURNING id, credit_cost_charged`,
    [tenant_id, class_instance_id, member_id, credits],
  );
  return r.rows[0];
}

// ============================================================
// GET /api/class-instances
// ============================================================

test('GET /api/class-instances returns future, non-cancelled, member-bookable instances with spots_remaining', { skip }, async () => {
  // 5 days out
  const ci = await newInstance({ start_time: '2027-11-08T15:00:00.000Z' });
  try {
    const m = await newMember();
    const res = await memberFetch(m.token, '/api/class-instances');
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.class_instances.find((c) => c.id === ci.id);
    assert.ok(row, 'fixture instance should appear in member list');
    assert.equal(row.offering_name, 'Hitting Clinic');
    assert.equal(row.resource_name, 'Class Court');
    assert.equal(row.spots_remaining, CLASS_CAPACITY);
    assert.equal(row.credit_cost, CLASS_CREDIT_COST);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('GET /api/class-instances hides cancelled instances', { skip }, async () => {
  const ci = await newInstance({ start_time: '2027-11-09T15:00:00.000Z' });
  await privilegedPool.query(
    `UPDATE class_instances SET cancelled_at = now() WHERE id = $1`,
    [ci.id],
  );
  try {
    const m = await newMember();
    const res = await memberFetch(m.token, '/api/class-instances');
    const body = await res.json();
    assert.ok(
      !body.class_instances.find((c) => c.id === ci.id),
      'cancelled instance should be hidden',
    );
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

// ============================================================
// POST /api/class-bookings — book
// ============================================================

test('book a class: 201, balance debited, spot taken', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-01-04T15:00:00.000Z' });
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);

    const res = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.class_booking?.id);
    assert.equal(body.class_booking.member_id, m.member_id);
    assert.equal(body.class_booking.status, 'confirmed');
    assert.equal(body.class_booking.credit_cost_charged, CLASS_CREDIT_COST);
    assert.equal(body.balance_after, 5 - CLASS_CREDIT_COST);
    assert.ok(body.ledger_entry_id);

    // /me list reflects
    const meRes = await memberFetch(m.token, '/api/class-bookings/me');
    const meBody = await meRes.json();
    assert.equal(meBody.class_bookings.length, 1);
    assert.equal(meBody.class_bookings[0].id, body.class_booking.id);
    assert.equal(meBody.class_bookings[0].offering_name, 'Hitting Clinic');

    // Spots remaining decremented in /api/class-instances
    const listRes = await memberFetch(m.token, '/api/class-instances');
    const listBody = await listRes.json();
    const row = listBody.class_instances.find((c) => c.id === ci.id);
    assert.equal(row.spots_remaining, CLASS_CAPACITY - 1);
  } finally {
    // Clean up class_bookings before instance
    await privilegedPool.query(
      `DELETE FROM credit_ledger_entries WHERE class_booking_id IN
       (SELECT id FROM class_bookings WHERE class_instance_id = $1)`,
      [ci.id],
    );
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('book a cancelled instance → 409', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-01-05T15:00:00.000Z' });
  await privilegedPool.query(
    `UPDATE class_instances SET cancelled_at = now() WHERE id = $1`,
    [ci.id],
  );
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);
    const res = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /cancelled/i);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('double-book same class → 409 (partial unique index)', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-01-06T15:00:00.000Z' });
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);
    const r1 = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(r1.status, 201);
    const r2 = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(r2.status, 409);
    const body = await r2.json();
    assert.match(body.error, /already have a spot/i);
  } finally {
    await privilegedPool.query(
      `DELETE FROM credit_ledger_entries WHERE class_booking_id IN
       (SELECT id FROM class_bookings WHERE class_instance_id = $1)`,
      [ci.id],
    );
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('book when class is full → 409 (capacity trigger)', { skip }, async () => {
  // capacity=2 instance to keep test fast
  const ci = await newInstance({
    start_time: '2028-01-07T15:00:00.000Z',
    capacity: 2,
  });
  try {
    const m1 = await newMember();
    const m2 = await newMember();
    const m3 = await newMember();
    for (const m of [m1, m2, m3]) await grantCredits(m.member_id, 5);

    const r1 = await memberFetch(m1.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    const r2 = await memberFetch(m2.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const r3 = await memberFetch(m3.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(r3.status, 409);
    const body = await r3.json();
    assert.match(body.error, /full/i);

    // m3's balance unchanged (5)
    const bal = await privilegedPool.query(
      `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
      [m3.member_id],
    );
    assert.equal(bal.rows[0].current_credits, 5);
  } finally {
    await privilegedPool.query(
      `DELETE FROM credit_ledger_entries WHERE class_booking_id IN
       (SELECT id FROM class_bookings WHERE class_instance_id = $1)`,
      [ci.id],
    );
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('insufficient credits → 400, no class_booking row left behind', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-01-08T15:00:00.000Z' });
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 1); // class costs 2

    const res = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /insufficient/i);

    // Tx rolled back — no class_booking row
    const check = await privilegedPool.query(
      `SELECT 1 FROM class_bookings WHERE member_id = $1`,
      [m.member_id],
    );
    assert.equal(check.rows.length, 0);
    // Balance still 1
    const bal = await privilegedPool.query(
      `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
      [m.member_id],
    );
    assert.equal(bal.rows[0].current_credits, 1);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('book past class instance → 409', { skip }, async () => {
  // Insert directly with past start_time (no GiST conflict on this
  // resource since unique past slot).
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, $6)
     RETURNING id`,
    [tenant_id, class_offering_id, resource_id, start, end, CLASS_CAPACITY],
  );
  const ci = r.rows[0];
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);
    const res = await memberFetch(m.token, '/api/class-bookings', {
      method: 'POST',
      body: JSON.stringify({ class_instance_id: ci.id }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /start time has passed/i);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

// ============================================================
// cancel
// ============================================================

test('cancel class booking ≥24h before start: 100% refund', { skip }, async () => {
  // Build a far-future instance + synthetic booking on it
  const ci = await newInstance({ start_time: '2028-02-01T15:00:00.000Z' });
  try {
    const m = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: m.member_id,
    });
    const res = await memberFetch(
      m.token,
      `/api/class-bookings/${cb.id}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refund_percent, 100);
    assert.equal(body.refund_credits, CLASS_CREDIT_COST);

    // Ledger row references class_booking_id
    const ledger = await privilegedPool.query(
      `SELECT amount, reason, class_booking_id, booking_id
         FROM credit_ledger_entries WHERE class_booking_id = $1`,
      [cb.id],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].reason, 'booking_refund');
    assert.equal(ledger.rows[0].amount, CLASS_CREDIT_COST);
    assert.equal(ledger.rows[0].booking_id, null);
  } finally {
    await privilegedPool.query(`DELETE FROM credit_ledger_entries WHERE class_booking_id IN (SELECT id FROM class_bookings WHERE class_instance_id = $1)`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('cancel inside no-refund window: cancel succeeds, refund = 0', { skip }, async () => {
  // Instance 1h from now (well inside the 6h partial-refund cutoff
  // and 24h free cutoff). Build via privileged pool directly so we
  // don't fight the advance-window policy.
  const start = new Date(Date.now() + 1 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant_id, class_offering_id, resource_id, start, end, CLASS_CAPACITY],
  );
  const ci = r.rows[0];
  try {
    const m = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: m.member_id,
    });
    const res = await memberFetch(
      m.token,
      `/api/class-bookings/${cb.id}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refund_percent, 0);
    assert.equal(body.refund_credits, 0);
    assert.equal(body.balance_after, null);
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('member cannot cancel another member\'s class booking → 403', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-03-01T15:00:00.000Z' });
  try {
    const owner = await newMember();
    const stranger = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: owner.member_id,
    });
    const res = await memberFetch(
      stranger.token,
      `/api/class-bookings/${cb.id}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(res.status, 403);
    // Booking still confirmed
    const check = await privilegedPool.query(
      `SELECT status FROM class_bookings WHERE id = $1`,
      [cb.id],
    );
    assert.equal(check.rows[0].status, 'confirmed');
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

// ============================================================
// no-show
// ============================================================

test('admin marks past confirmed class booking as no_show → 200', { skip }, async () => {
  // Past instance
  const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant_id, class_offering_id, resource_id, start, end, CLASS_CAPACITY],
  );
  const ci = r.rows[0];
  try {
    const m = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: m.member_id,
    });
    const res = await fetch(
      `${baseUrl}/api/class-bookings/${cb.id}/mark-no-show?tenant=${TENANT}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'no_show');

    const check = await privilegedPool.query(
      `SELECT status, no_show_marked_at, no_show_marked_by
         FROM class_bookings WHERE id = $1`,
      [cb.id],
    );
    assert.equal(check.rows[0].status, 'no_show');
    assert.ok(check.rows[0].no_show_marked_at);
    assert.ok(check.rows[0].no_show_marked_by);
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('member cannot mark class booking no-show → 403', { skip }, async () => {
  const start = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING id`,
    [tenant_id, class_offering_id, resource_id, start, end, CLASS_CAPACITY],
  );
  const ci = r.rows[0];
  try {
    const m = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: m.member_id,
    });
    const res = await memberFetch(
      m.token,
      `/api/class-bookings/${cb.id}/mark-no-show`,
      { method: 'POST' },
    );
    assert.equal(res.status, 403);
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});

test('cannot mark no-show on future class booking → 409', { skip }, async () => {
  const ci = await newInstance({ start_time: '2028-04-04T15:00:00.000Z' });
  try {
    const m = await newMember();
    const cb = await syntheticClassBooking({
      class_instance_id: ci.id,
      member_id: m.member_id,
    });
    const res = await fetch(
      `${baseUrl}/api/class-bookings/${cb.id}/mark-no-show?tenant=${TENANT}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
      },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /future/i);
  } finally {
    await privilegedPool.query(`DELETE FROM class_bookings WHERE class_instance_id = $1`, [ci.id]);
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [ci.id]);
  }
});
