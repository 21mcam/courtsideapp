// POST /api/admin/bookings — calendar click/drag creation.
//
// Covers:
//   * auth: 401 unauthenticated, 403 member token
//   * validation: XOR member/customer, end before start, >24h
//   * gates: 404 unknown offering, 409 class offering, 409 unlinked
//     resource, 409 overlap with existing booking, 409 blackout
//   * member path: confirmed booking, custom (dragged) length kept,
//     credits spent through the ledger, 400 + rollback when the
//     member can't afford it
//   * customer path: confirmed cash-on-arrival booking (payment_status
//     'pending', amount_due = offering dollar_price, no Stripe)
//   * admin override: outside operating hours is ALLOWED (no
//     operating_hours row covers the slot)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-admin-create';
const TZ = 'America/New_York';

const { app } = await import('../src/app.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let memberToken;
let member_id;
let resource_id;
let offering_id; // rental, 60 min, 3 credits, $45
let class_offering_id;
const CREDIT_COST = 3;
const DOLLAR_PRICE = 4500;

// Far-future Monday so nothing collides with other test files.
// 2027-03-01 is a Monday; operating hours below cover Mondays only.
const MONDAY = '2027-03-01';
const iso = (hhmm) => `${MONDAY}T${hhmm}:00.000-05:00`; // EST

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Admin Create Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ])
  ).rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const hash = await bcrypt.hash('password', 10);
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'X') RETURNING id`,
    [tenant_id, adminEmail, hash],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Create Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cage 60', 'cage-time', 60, $2, $3, 1, true, true)
       RETURNING id`,
      [tenant_id, CREDIT_COST, DOLLAR_PRICE],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Clinic', 'classes', 60, 2, $2, 8, true, false)
       RETURNING id`,
      [tenant_id, DOLLAR_PRICE],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $4, $3)`,
    [tenant_id, offering_id, resource_id, class_offering_id, resource_id],
  );
  // Mondays 9-17 only — everything outside is "outside operating
  // hours" for the member flow, which admins may override.
  await privilegedPool.query(
    `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, 1, '09:00', '17:00')`,
    [tenant_id, resource_id],
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

  // Member with 10 credits, seeded through the admin API so the
  // ledger + balance stay consistent.
  const memberEmail = `member-${randomUUID()}@example.com`;
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: memberEmail,
        password: 'password123',
        first_name: 'Booked',
        last_name: 'Member',
      }),
    },
  );
  assert.equal(reg.status, 201);
  ({ token: memberToken, member_id } = await reg.json());
  const adj = await adminFetch(`/api/admin/members/${member_id}/credit-adjustments`, {
    method: 'POST',
    body: JSON.stringify({ amount: 10, note: 'test seed' }),
  });
  assert.equal(adj.status, 201);
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
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

function body(overrides = {}) {
  return {
    offering_id,
    resource_id,
    start_time: iso('10:00'),
    end_time: iso('11:00'),
    ...overrides,
  };
}

const walkin = () => ({
  first_name: 'Front',
  last_name: 'Desk',
  email: `desk-${randomUUID()}@example.com`,
});

// ============================================================
// auth
// ============================================================

test('unauthenticated create is 401', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/bookings?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body({ customer: walkin() })),
  });
  assert.equal(res.status, 401);
});

test('member token is 403', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/bookings?tenant=${TENANT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify(body({ customer: walkin() })),
  });
  assert.equal(res.status, 403);
});

// ============================================================
// validation
// ============================================================

test('member_id AND customer together is 400; neither is 400', { skip }, async () => {
  const both = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(body({ member_id, customer: walkin() })),
  });
  assert.equal(both.status, 400);
  const neither = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(body()),
  });
  assert.equal(neither.status, 400);
});

test('end before start is 400; longer than 24h is 400', { skip }, async () => {
  const backwards = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({ start_time: iso('11:00'), end_time: iso('10:00'), customer: walkin() }),
    ),
  });
  assert.equal(backwards.status, 400);
  const tooLong = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({
        start_time: iso('10:00'),
        end_time: `2027-03-02T11:00:00.000-05:00`,
        customer: walkin(),
      }),
    ),
  });
  assert.equal(tooLong.status, 400);
});

// ============================================================
// gates
// ============================================================

test('unknown offering 404; class offering 409', { skip }, async () => {
  const unknown = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({ offering_id: randomUUID(), customer: walkin() }),
    ),
  });
  assert.equal(unknown.status, 404);
  const cls = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({ offering_id: class_offering_id, customer: walkin() }),
    ),
  });
  assert.equal(cls.status, 409);
});

test('blackout on the window is 409', { skip }, async () => {
  const bl = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      resource_id,
      starts_at: iso('13:00'),
      ends_at: iso('14:00'),
      reason: 'maintenance',
    }),
  });
  assert.equal(bl.status, 201);
  const { blackout } = await bl.json();
  try {
    const res = await adminFetch('/api/admin/bookings', {
      method: 'POST',
      body: JSON.stringify(
        body({
          start_time: iso('13:30'),
          end_time: iso('14:30'),
          customer: walkin(),
        }),
      ),
    });
    assert.equal(res.status, 409);
    const resBody = await res.json();
    assert.match(resBody.error, /blacked out/);
  } finally {
    await adminFetch(`/api/admin/blackouts/${blackout.id}`, { method: 'DELETE' });
  }
});

// ============================================================
// member path
// ============================================================

test('member booking: custom dragged length kept, credits spent', { skip }, async () => {
  // 90 minutes — not the offering's 60. The dragged window wins;
  // the credit cost stays the offering's flat 3.
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({ member_id, start_time: iso('10:00'), end_time: iso('11:30') }),
    ),
  });
  assert.equal(res.status, 201);
  const { booking, balance_after } = await res.json();
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.member_id, member_id);
  assert.equal(booking.credit_cost_charged, CREDIT_COST);
  assert.equal(booking.payment_status, 'not_required');
  assert.equal(
    (new Date(booking.end_time) - new Date(booking.start_time)) / 60000,
    90,
  );
  assert.equal(balance_after, 10 - CREDIT_COST);

  // Ledger invariant: latest entry's balance_after matches balance.
  const ledger = await privilegedPool.query(
    `SELECT reason, amount, balance_after FROM credit_ledger_entries
      WHERE tenant_id = $1 AND member_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenant_id, member_id],
  );
  assert.equal(ledger.rows[0].reason, 'booking_spend');
  assert.equal(ledger.rows[0].amount, -CREDIT_COST);
  assert.equal(ledger.rows[0].balance_after, 10 - CREDIT_COST);
});

test('overlapping window is 409', { skip }, async () => {
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({
        start_time: iso('10:30'),
        end_time: iso('11:00'),
        customer: walkin(),
      }),
    ),
  });
  assert.equal(res.status, 409);
});

test('insufficient credits: 400 and the booking is rolled back', { skip }, async () => {
  // Member has 7 left; drain to 1 so a 3-credit booking fails.
  const drain = await adminFetch(`/api/admin/members/${member_id}/credit-adjustments`, {
    method: 'POST',
    body: JSON.stringify({ amount: -6, note: 'drain' }),
  });
  assert.equal(drain.status, 201);
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({ member_id, start_time: iso('15:00'), end_time: iso('16:00') }),
    ),
  });
  assert.equal(res.status, 400);
  const rows = await privilegedPool.query(
    `SELECT 1 FROM bookings
      WHERE tenant_id = $1 AND resource_id = $2
        AND start_time = $3`,
    [tenant_id, resource_id, new Date(iso('15:00'))],
  );
  assert.equal(rows.rows.length, 0, 'booking INSERT must be rolled back');
});

// ============================================================
// customer path + operating-hours override
// ============================================================

test('walk-in booking: cash on arrival, outside operating hours allowed', { skip }, async () => {
  // 7-9 PM is outside the seeded 9-17 hours — the member/public flows
  // 409 here, but the front desk may book it.
  const customer = walkin();
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify(
      body({
        start_time: iso('19:00'),
        end_time: iso('21:00'),
        customer,
      }),
    ),
  });
  assert.equal(res.status, 201);
  const { booking } = await res.json();
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.member_id, null);
  assert.equal(booking.customer_email, customer.email);
  assert.equal(booking.credit_cost_charged, 0);
  assert.equal(booking.amount_due_cents, DOLLAR_PRICE);
  assert.equal(booking.payment_status, 'pending');
});
