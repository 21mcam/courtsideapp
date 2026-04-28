// Member booking flow tests — Phase 3 slice 2.
//
// Uses /api/admin/members/:id/credit-adjustments to grant credits
// (exercises the apply_credit_change function via the real HTTP
// path, same as production). Each test creates a fresh member for
// state isolation; the tenant + resource + offering + op_hours
// fixtures are shared across tests for setup speed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-bookings';
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
let offering_id;
const OFFERING_CREDITS = 3;
const OFFERING_DURATION_MIN = 60;

// Tests use Mondays in 2027 (EST winter, no DST). Each test that
// books a slot picks its own date to avoid cross-test conflicts.
const DOW_MONDAY = 1;

// First-test slot: 14:00 EST on Mon 2027-02-01 = 19:00 UTC (winter
// offset -05:00).
const SLOT_START = '2027-02-01T19:00:00.000Z';

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Bookings Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  const t = await privilegedPool.query(
    `SELECT id FROM tenants WHERE subdomain = $1`,
    [TENANT],
  );
  tenant_id = t.rows[0].id;

  // Admin owner — used to grant credits to members via the
  // admin endpoint.
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // Resource + offering + link + op_hours covering 9am-5pm EST on
  // Mondays. Only created once for the whole file.
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, '30-min cage', 'cage-time', $2, $3, 3000, true, true)
       RETURNING id`,
      [tenant_id, OFFERING_DURATION_MIN, OFFERING_CREDITS],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offering_id, resource_id],
  );
  await privilegedPool.query(
    `INSERT INTO operating_hours
       (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, $3, '09:00', '17:00')`,
    [tenant_id, resource_id, DOW_MONDAY],
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
  if (!adminLogin.ok) throw new Error(`admin login failed`);
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

// Register a member via the API and return { member_id, user_id, token }.
async function newMember() {
  const email = `member-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';
  const reg = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      first_name: 'Booking',
      last_name: 'Tester',
    }),
  });
  if (!reg.ok) throw new Error(`register-member failed: HTTP ${reg.status}`);
  const body = await reg.json();
  return { ...body, email, password };
}

// Grant credits to a member by hitting the admin credit-adjustment
// endpoint (exercises the real apply_credit_change path).
async function grantCredits(member_id, amount) {
  const res = await fetch(
    `${baseUrl}/api/admin/members/${member_id}/credit-adjustments?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount, note: 'test grant' }),
    },
  );
  if (!res.ok) {
    throw new Error(`grant credits failed: HTTP ${res.status}`);
  }
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

// ============================================================
// tests
// ============================================================

test('happy path: member books a valid slot, balance debited', { skip }, async () => {
  const m = await newMember();
  await grantCredits(m.member_id, 5); // 5 credits, plenty for a 3-credit offering

  const res = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: SLOT_START,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.booking?.id);
  assert.equal(body.booking.member_id, m.member_id);
  assert.equal(body.booking.status, 'confirmed');
  assert.equal(body.booking.credit_cost_charged, OFFERING_CREDITS);
  assert.equal(body.balance_after, 5 - OFFERING_CREDITS, 'balance should be 2');
  assert.ok(body.ledger_entry_id);

  // GET /me reflects
  const listRes = await memberFetch(m.token, '/api/bookings/me');
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.bookings.length, 1);
  assert.equal(listBody.bookings[0].id, body.booking.id);
  assert.equal(listBody.bookings[0].offering_name, '30-min cage');

  // Cleanup so concurrent overlap tests below don't conflict.
  await privilegedPool.query(`DELETE FROM credit_ledger_entries WHERE booking_id = $1`, [body.booking.id]);
  await privilegedPool.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [body.booking.id]);
});

test('admin-only user (no member_id) cannot book → 403', { skip }, async () => {
  // Create an admin-only user via privileged pool and log in.
  const email = `admin-only-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Only') RETURNING id`,
    [tenant_id, email, await bcrypt.hash(password, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [tenant_id, u.rows[0].id],
  );
  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { token } = await login.json();

  const res = await memberFetch(token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: '2027-02-08T19:00:00.000Z', // different date so no conflict
    }),
  });
  assert.equal(res.status, 403);
});

test('insufficient credits → 400, no booking created', { skip }, async () => {
  const m = await newMember();
  // Grant only 1 credit; offering costs 3.
  await grantCredits(m.member_id, 1);

  const res = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: '2027-02-15T19:00:00.000Z', // unique date for isolation
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /insufficient credits/i);

  // No booking row should have been created (transaction rolled back).
  const dbCheck = await privilegedPool.query(
    `SELECT 1 FROM bookings WHERE member_id = $1`,
    [m.member_id],
  );
  assert.equal(dbCheck.rows.length, 0);

  // Member's balance should still be 1 — function rolled back the
  // ledger insert too.
  const balCheck = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [m.member_id],
  );
  assert.equal(balCheck.rows[0].current_credits, 1);
});

test('slot conflict: second member booking the same slot → 409', { skip }, async () => {
  const m1 = await newMember();
  const m2 = await newMember();
  await grantCredits(m1.member_id, 5);
  await grantCredits(m2.member_id, 5);

  // First booking succeeds.
  const slotStart = '2027-02-22T19:00:00.000Z';
  const r1 = await memberFetch(m1.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ offering_id, resource_id, start_time: slotStart }),
  });
  assert.equal(r1.status, 201);

  // Second member, same slot.
  const r2 = await memberFetch(m2.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ offering_id, resource_id, start_time: slotStart }),
  });
  assert.equal(r2.status, 409);
  const body = await r2.json();
  assert.match(body.error, /already booked/i);

  // m2's balance unchanged (5).
  const bal = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [m2.member_id],
  );
  assert.equal(bal.rows[0].current_credits, 5);
});

test('slot outside operating hours → 409', { skip }, async () => {
  const m = await newMember();
  await grantCredits(m.member_id, 5);

  // 7am EST = 12:00 UTC — before 9am open.
  const res = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: '2027-03-01T12:00:00.000Z', // Monday, 7am EST
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /operating hours/i);
});

test('slot inside a facility-wide blackout → 409', { skip }, async () => {
  // Use a unique date so we don't pollute other tests.
  const blackoutDay = '2027-03-08';

  // Insert a facility-wide blackout for the entire day.
  await privilegedPool.query(
    `INSERT INTO blackouts
       (tenant_id, resource_id, offering_id, starts_at, ends_at, reason)
     VALUES ($1, NULL, NULL, $2, $3, 'Test blackout')`,
    [tenant_id, '2027-03-08T00:00:00Z', '2027-03-09T00:00:00Z'],
  );

  const m = await newMember();
  await grantCredits(m.member_id, 5);

  const res = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: `${blackoutDay}T19:00:00.000Z`,
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /blacked out/i);
});

test('two bookings by same member at non-overlapping slots → both succeed, balance reflects both', { skip }, async () => {
  const m = await newMember();
  await grantCredits(m.member_id, 10);

  const r1 = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: '2027-04-05T15:00:00.000Z', // Monday 10am EST
    }),
  });
  assert.equal(r1.status, 201);
  const b1 = await r1.json();
  assert.equal(b1.balance_after, 10 - OFFERING_CREDITS);

  const r2 = await memberFetch(m.token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: '2027-04-05T16:00:00.000Z', // Monday 11am EST (back-to-back)
    }),
  });
  assert.equal(r2.status, 201);
  const b2 = await r2.json();
  assert.equal(b2.balance_after, 10 - OFFERING_CREDITS * 2);

  // Two distinct ledger entries for this member, both 'booking_spend'.
  const ledger = await privilegedPool.query(
    `SELECT amount, reason, booking_id FROM credit_ledger_entries
      WHERE member_id = $1 AND reason = 'booking_spend'
      ORDER BY entry_number ASC`,
    [m.member_id],
  );
  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows[0].amount, -OFFERING_CREDITS);
  assert.equal(ledger.rows[1].amount, -OFFERING_CREDITS);
});
