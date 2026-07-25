// GET /api/admin/members/:id — member detail endpoint (people-flows
// slice).
//
// Covers:
//   1. Full detail payload: profile + current_credits, subscription
//      (joined with its active plan period), recent bookings (with
//      offering/resource names), and the credit ledger newest-first.
//   2. Ledger pagination via ?ledger_limit / ?ledger_offset + total.
//   3. 404 for unknown and malformed ids.
//   4. requireAdmin: member tokens get 403.
//
// Self-contained: throwaway tenant + fixtures via the privileged
// pool, dropped on teardown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-member-detail';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED is required to set up member detail fixtures';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let memberToken;
let member_id;
let booking_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
    TENANT,
  ]);
  tenant_id = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Member Detail Tests', 'America/New_York')
       RETURNING id`,
      [TENANT],
    )
  ).rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminHash = await bcrypt.hash('correcthorsebatterystaple', 10);
  const adminUser = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, adminHash],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, adminUser.rows[0].id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const adminLogin = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: 'correcthorsebatterystaple',
    }),
  });
  adminToken = (await adminLogin.json()).token;

  // Member with a login (registered via the API).
  const memberEmail = `member-${randomUUID()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: memberEmail,
      password: 'password123',
      first_name: 'Detail',
      last_name: 'Member',
    }),
  });
  assert.equal(reg.status, 201);
  ({ token: memberToken, member_id } = await reg.json());

  // Three ledger entries: +5, -2, +4 → balance 7, total 3.
  for (const [amount, note] of [
    [5, 'first grant'],
    [-2, 'correction'],
    [4, 'second grant'],
  ]) {
    const res = await adminFetch(
      `/api/admin/members/${member_id}/credit-adjustments`,
      { method: 'POST', body: JSON.stringify({ amount, note }) },
    );
    assert.equal(res.status, 201, `credit adjustment ${note} failed`);
  }

  // Booking fixture (same direct-insert pattern as admin.test.js).
  const resourceId = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Detail Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  const offeringId = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, 'detail-cage-60', 'cage-time', 60, 1, 3000, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offeringId, resourceId],
  );
  const start = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  booking_id = (
    await privilegedPool.query(
      `INSERT INTO bookings (
         tenant_id, offering_id, resource_id, member_id,
         start_time, end_time, status,
         amount_due_cents, credit_cost_charged, payment_status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 0, 1, 'not_required')
       RETURNING id`,
      [tenant_id, offeringId, resourceId, member_id, start, end],
    )
  ).rows[0].id;

  // Active subscription on a plan (current plan period open-ended).
  const planId = (
    await privilegedPool.query(
      `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
       VALUES ($1, 'Detail Pro', 26900, 20) RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  const subscriptionId = (
    await privilegedPool.query(
      `INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenant_id, member_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, subscriptionId, planId],
  );
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

test('member detail returns profile, credits, subscription, bookings, ledger', { skip }, async () => {
  const res = await adminFetch(`/api/admin/members/${member_id}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // Profile + balance
  assert.equal(body.member.id, member_id);
  assert.equal(body.member.first_name, 'Detail');
  assert.ok(body.member.user_id, 'registered member should be linked to a user');
  assert.equal(body.member.current_credits, 7);

  // Subscription joined with its current plan
  assert.ok(body.subscription, 'active subscription should be returned');
  assert.equal(body.subscription.status, 'active');
  assert.equal(body.subscription.plan_name, 'Detail Pro');
  assert.equal(body.subscription.monthly_price_cents, 26900);

  // Bookings joined with offering + resource names
  const booking = body.bookings.find((b) => b.id === booking_id);
  assert.ok(booking, 'fixture booking should appear');
  assert.equal(booking.offering_name, 'detail-cage-60');
  assert.equal(booking.resource_name, 'Detail Cage');
  assert.equal(booking.status, 'confirmed');

  // Ledger: newest first, defaults, invariant balance_after chain
  assert.equal(body.ledger.total, 3);
  assert.equal(body.ledger.entries.length, 3);
  assert.equal(body.ledger.limit, 20);
  assert.equal(body.ledger.offset, 0);
  assert.equal(body.ledger.entries[0].balance_after, 7);
  assert.equal(body.ledger.entries[0].amount, 4);
  assert.equal(body.ledger.entries[2].balance_after, 5);
  assert.equal(body.ledger.entries[2].note, 'first grant');
  for (const e of body.ledger.entries) {
    assert.equal(e.reason, 'admin_adjustment');
  }
});

test('ledger pagination via ledger_limit/ledger_offset', { skip }, async () => {
  const page1 = await adminFetch(
    `/api/admin/members/${member_id}?ledger_limit=2&ledger_offset=0`,
  );
  assert.equal(page1.status, 200);
  const b1 = await page1.json();
  assert.equal(b1.ledger.entries.length, 2);
  assert.equal(b1.ledger.total, 3);
  assert.equal(b1.ledger.limit, 2);
  assert.equal(b1.ledger.entries[0].balance_after, 7);

  const page2 = await adminFetch(
    `/api/admin/members/${member_id}?ledger_limit=2&ledger_offset=2`,
  );
  const b2 = await page2.json();
  assert.equal(b2.ledger.entries.length, 1);
  assert.equal(b2.ledger.offset, 2);
  // Oldest entry: the +5 grant that took the balance to 5.
  assert.equal(b2.ledger.entries[0].amount, 5);
  assert.equal(b2.ledger.entries[0].balance_after, 5);

  // Bad pagination values → 400.
  const bad = await adminFetch(
    `/api/admin/members/${member_id}?ledger_limit=0`,
  );
  assert.equal(bad.status, 400);
});

test('member without subscription returns subscription: null', { skip }, async () => {
  const { member } = await (
    await adminFetch('/api/admin/members', {
      method: 'POST',
      body: JSON.stringify({
        email: `nosub-${randomUUID()}@example.com`,
        first_name: 'No',
        last_name: 'Sub',
      }),
    })
  ).json();
  const res = await adminFetch(`/api/admin/members/${member.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.subscription, null);
  assert.equal(body.member.current_credits, 0);
  assert.deepEqual(body.bookings, []);
  assert.equal(body.ledger.total, 0);
});

test('unknown and malformed member ids return 404', { skip }, async () => {
  const unknown = await adminFetch(`/api/admin/members/${randomUUID()}`);
  assert.equal(unknown.status, 404);

  const malformed = await adminFetch('/api/admin/members/not-a-uuid');
  assert.equal(malformed.status, 404);
});

test('member token gets 403 on member detail (requireAdmin)', { skip }, async () => {
  const res = await fetch(
    `${baseUrl}/api/admin/members/${member_id}?tenant=${TENANT}`,
    { headers: { Authorization: `Bearer ${memberToken}` } },
  );
  assert.equal(res.status, 403);
});
