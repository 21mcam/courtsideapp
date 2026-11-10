// Front-desk booking operations (migration 037).
//
// Covers:
//   * create: phone-only walk-in (no email), full_name split, neither
//     email nor phone → 400, staff-only offering (allow_public_booking
//     = false) bookable from the desk
//   * mark-paid: cash walk-in → paid + revenue; member booking, already
//     paid, cancelled → 409; mark-unpaid undoes; cancel reports an
//     in-person refund, not a Stripe one
//   * reschedule: new time keeps length + records audit + clears
//     reminder; move to another resource; conflict / unlinked resource
//     / not-confirmed → 409; member token → 403

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-front-desk';
const TZ = 'America/New_York';

const { app } = await import('../src/app.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let pool;
let tenant_id;
let adminToken;
let memberToken;
let member_id;
let cageA;
let cageB;
let cageC; // not linked to the rental offering
let rental; // 60 min, $45, public
let staffOnly; // 180 min, $120, allow_public_booking = false
const PRICE = 4500;

// Far-future dates that no other test file uses.
const DAY = '2027-04-05';
const iso = (hhmm, date = DAY) => new Date(`${date}T${hhmm}:00.000-04:00`).toISOString();

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  await pool.query(
    `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Front Desk Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (await pool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [TENANT]))
    .rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const u = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Desk', 'Staff') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash('password', 10)],
  );
  await pool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  const mkResource = async (name) =>
    (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, $2) RETURNING id`, [
      tenant_id,
      name,
    ])).rows[0].id;
  cageA = await mkResource('Cage A');
  cageB = await mkResource('Cage B');
  cageC = await mkResource('Cage C');

  const mkOffering = async (name, minutes, price, isPublic) =>
    (
      await pool.query(
        `INSERT INTO offerings
           (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
            capacity, allow_member_booking, allow_public_booking)
         VALUES ($1, $2, 'cage-time', $3, 2, $4, 1, true, $5) RETURNING id`,
        [tenant_id, name, minutes, price, isPublic],
      )
    ).rows[0].id;
  rental = await mkOffering('Cage 60', 60, PRICE, true);
  staffOnly = await mkOffering('3 Hours Cage Time', 180, 12000, false);
  await pool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
    [tenant_id, rental, cageA, cageB, staffOnly],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'password' }),
  });
  adminToken = (await login.json()).token;

  const reg = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `member-${randomUUID()}@example.com`,
      password: 'password123',
      first_name: 'Mem',
      last_name: 'Ber',
    }),
  });
  ({ token: memberToken, member_id } = await reg.json());
  await api(`/api/admin/members/${member_id}/credit-adjustments`, {
    method: 'POST',
    body: JSON.stringify({ amount: 20, note: 'seed' }),
  });
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (pool) {
    await pool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await pool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function api(path, init = {}, token = adminToken) {
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

const post = (path, body, token) =>
  api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, token);

async function book({ start, end, resource = cageA, offering = rental, customer, member } = {}) {
  const res = await post('/api/admin/bookings', {
    offering_id: offering,
    resource_id: resource,
    start_time: iso(start),
    end_time: iso(end),
    ...(member ? { member_id } : { customer: customer ?? { full_name: 'Walk Up', phone: '555-0100' } }),
  });
  return { res, body: await res.json() };
}

// ============================================================
// create
// ============================================================

test('phone-only walk-in: no email needed; full_name is split', { skip }, async () => {
  const { res, body } = await book({
    start: '09:00',
    end: '10:00',
    customer: { full_name: 'Jerry Q Huntzinger', phone: '646-555-0101' },
  });
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.booking.customer_email, null);
  assert.equal(body.booking.customer_phone, '646-555-0101');
  assert.equal(body.booking.customer_first_name, 'Jerry Q');
  assert.equal(body.booking.customer_last_name, 'Huntzinger');
  assert.equal(body.booking.payment_status, 'pending');
});

test('walk-in with an empty email string and a phone is accepted', { skip }, async () => {
  const { res } = await book({
    start: '10:00',
    end: '11:00',
    customer: { first_name: 'Cher', email: '', phone: '555-0102' },
  });
  assert.equal(res.status, 201);
});

test('walk-in with neither email nor phone → 400', { skip }, async () => {
  const { res, body } = await book({
    start: '11:00',
    end: '12:00',
    customer: { full_name: 'No Contact' },
  });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(body), /email or a phone/);
});

test('staff-only offering (not public) is bookable for a walk-in from the desk', { skip }, async () => {
  const { res, body } = await book({
    start: '12:00',
    end: '15:00',
    offering: staffOnly,
    customer: { full_name: 'Team Rental', phone: '555-0103' },
  });
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.booking.amount_due_cents, 12000);
});

test('the public walk-in path still refuses a staff-only offering', { skip }, async () => {
  // DB-level: without the staff flag the validity trigger still blocks it.
  await assert.rejects(
    pool.query(
      `INSERT INTO bookings (tenant_id, offering_id, resource_id,
         customer_first_name, customer_last_name, customer_phone,
         start_time, end_time, amount_due_cents, payment_status, status)
       VALUES ($1, $2, $3, 'A', 'B', '555', $4, $5, 12000, 'pending', 'confirmed')`,
      [tenant_id, staffOnly, cageA, iso('16:00', '2027-04-06'), iso('19:00', '2027-04-06')],
    ),
    /does not allow public bookings/,
  );
});

// ============================================================
// mark paid / unpaid
// ============================================================

async function revenue() {
  const r = await api('/api/admin/reports/summary');
  return (await r.json()).revenueThisMonthCents;
}

test('mark-paid records an in-person payment and it reaches revenue', { skip }, async () => {
  // Booked for a future date, but paid now → counts this month.
  const { body } = await book({ start: '16:00', end: '17:00' });
  const id = body.booking.id;
  const before = await revenue();

  const res = await post(`/api/admin/bookings/${id}/mark-paid`, { method: 'card' });
  assert.equal(res.status, 200);
  const paid = (await res.json()).booking;
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.amount_paid_cents, PRICE);
  assert.equal(paid.payment_method, 'card');
  assert.ok(paid.paid_at);
  assert.equal(await revenue(), before + PRICE);

  // Twice → 409.
  assert.equal((await post(`/api/admin/bookings/${id}/mark-paid`)).status, 409);

  // Undo → owed again, revenue back.
  const undo = await post(`/api/admin/bookings/${id}/mark-unpaid`);
  assert.equal(undo.status, 200);
  const unpaid = (await undo.json()).booking;
  assert.equal(unpaid.payment_status, 'pending');
  assert.equal(unpaid.payment_method, null);
  assert.equal(await revenue(), before);
});

test('mark-paid defaults to cash; invalid method → 400', { skip }, async () => {
  const { body } = await book({ start: '17:00', end: '18:00' });
  assert.equal(
    (await post(`/api/admin/bookings/${body.booking.id}/mark-paid`, { method: 'venmo' })).status,
    400,
  );
  const res = await post(`/api/admin/bookings/${body.booking.id}/mark-paid`);
  assert.equal((await res.json()).booking.payment_method, 'cash');
});

test('cancelling a cash-paid booking reports an in-person refund, not Stripe', { skip }, async () => {
  const { body } = await book({ start: '18:00', end: '19:00' });
  await post(`/api/admin/bookings/${body.booking.id}/mark-paid`);
  const res = await post(`/api/bookings/${body.booking.id}/cancel`, {});
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.equal(c.stripe_refund_due_cents, 0);
  assert.equal(c.in_person_refund_due_cents, PRICE);
  assert.equal(c.payment_method, 'cash');

  // Cancelled + already paid → can't be marked again.
  assert.equal((await post(`/api/admin/bookings/${body.booking.id}/mark-paid`)).status, 409);
});

test('mark-paid refuses member bookings and cancelled unpaid bookings', { skip }, async () => {
  const m = await book({ start: '19:00', end: '20:00', member: true });
  assert.equal(m.res.status, 201, JSON.stringify(m.body));
  assert.equal((await post(`/api/admin/bookings/${m.body.booking.id}/mark-paid`)).status, 409);

  const w = await book({ start: '20:00', end: '21:00' });
  await post(`/api/bookings/${w.body.booking.id}/cancel`, {});
  assert.equal((await post(`/api/admin/bookings/${w.body.booking.id}/mark-paid`)).status, 409);
});

test('mark-unpaid refuses a booking that was never marked paid in person', { skip }, async () => {
  const { body } = await book({ start: '21:00', end: '22:00' });
  assert.equal((await post(`/api/admin/bookings/${body.booking.id}/mark-unpaid`)).status, 409);
});

test('front-desk endpoints are admin-only', { skip }, async () => {
  const { body } = await book({ start: '08:00', end: '09:00', resource: cageB });
  const id = body.booking.id;
  assert.equal((await post(`/api/admin/bookings/${id}/mark-paid`, {}, memberToken)).status, 403);
  assert.equal(
    (await post(`/api/admin/bookings/${id}/reschedule`, { start_time: iso('13:00') }, memberToken))
      .status,
    403,
  );
});

// ============================================================
// reschedule
// ============================================================

const DAY2 = '2027-04-07';

test('reschedule to a new time keeps the length, records the hop, clears the reminder', { skip }, async () => {
  const res0 = await post('/api/admin/bookings', {
    offering_id: rental,
    resource_id: cageA,
    start_time: iso('10:00', DAY2),
    end_time: iso('11:30', DAY2), // custom 90-min length
    customer: { full_name: 'Move Me', phone: '555-0104' },
  });
  const id = (await res0.json()).booking.id;
  await pool.query(`UPDATE bookings SET reminder_sent_at = now() WHERE id = $1`, [id]);

  const res = await post(`/api/admin/bookings/${id}/reschedule`, {
    start_time: iso('14:00', DAY2),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const b = (await res.json()).booking;
  assert.equal(new Date(b.start_time).toISOString(), iso('14:00', DAY2));
  assert.equal(new Date(b.end_time).toISOString(), iso('15:30', DAY2));
  assert.equal(new Date(b.previous_start_time).toISOString(), iso('10:00', DAY2));
  assert.equal(b.reschedule_count, 1);

  const row = (
    await pool.query(`SELECT reminder_sent_at, rescheduled_at FROM bookings WHERE id = $1`, [id])
  ).rows[0];
  assert.equal(row.reminder_sent_at, null);
  assert.ok(row.rescheduled_at);
});

test('reschedule can move to another linked resource at the same time', { skip }, async () => {
  const res0 = await post('/api/admin/bookings', {
    offering_id: rental,
    resource_id: cageA,
    start_time: iso('16:00', DAY2),
    end_time: iso('17:00', DAY2),
    member_id,
  });
  const id = (await res0.json()).booking.id;
  const res = await post(`/api/admin/bookings/${id}/reschedule`, {
    start_time: iso('16:00', DAY2),
    resource_id: cageB,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).booking.resource_id, cageB);
});

test('reschedule can shift within its own window (overlapping itself is fine)', { skip }, async () => {
  const res0 = await post('/api/admin/bookings', {
    offering_id: rental,
    resource_id: cageB,
    start_time: iso('09:00', DAY2),
    end_time: iso('10:00', DAY2),
    customer: { full_name: 'Shift Me', phone: '555-0105' },
  });
  const id = (await res0.json()).booking.id;
  const res = await post(`/api/admin/bookings/${id}/reschedule`, {
    start_time: iso('09:30', DAY2),
  });
  assert.equal(res.status, 200);
});

test('reschedule refuses conflicts, unlinked resources, no-ops, and non-confirmed bookings', { skip }, async () => {
  const mk = async (start, end) =>
    (
      await (
        await post('/api/admin/bookings', {
          offering_id: rental,
          resource_id: cageA,
          start_time: iso(start, DAY2),
          end_time: iso(end, DAY2),
          customer: { full_name: 'Blocker', phone: '555-0106' },
        })
      ).json()
    ).booking.id;
  const a = await mk('18:00', '19:00');
  const b = await mk('19:00', '20:00');

  let res = await post(`/api/admin/bookings/${a}/reschedule`, { start_time: iso('18:30', DAY2) });
  assert.equal(res.status, 409, 'overlaps booking b');

  res = await post(`/api/admin/bookings/${a}/reschedule`, {
    start_time: iso('18:00', DAY2),
    resource_id: cageC,
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /isn't offered on Cage C/);

  res = await post(`/api/admin/bookings/${a}/reschedule`, { start_time: iso('18:00', DAY2) });
  assert.equal(res.status, 400, 'same time and resource is a no-op');

  await post(`/api/bookings/${b}/cancel`, {});
  res = await post(`/api/admin/bookings/${b}/reschedule`, { start_time: iso('21:00', DAY2) });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cancelled/);

  // b's old slot is free now, so a can move into it.
  res = await post(`/api/admin/bookings/${a}/reschedule`, { start_time: iso('18:30', DAY2) });
  assert.equal(res.status, 200);
});

test('reschedule a staff-only offering to another time works', { skip }, async () => {
  const res0 = await post('/api/admin/bookings', {
    offering_id: staffOnly,
    resource_id: cageA,
    start_time: iso('08:00', '2027-04-08'),
    end_time: iso('11:00', '2027-04-08'),
    customer: { full_name: 'Team', phone: '555-0107' },
  });
  assert.equal(res0.status, 201);
  const id = (await res0.json()).booking.id;
  const res = await post(`/api/admin/bookings/${id}/reschedule`, {
    start_time: iso('13:00', '2027-04-08'),
  });
  assert.equal(res.status, 200);
});
