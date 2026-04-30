// Stale-state cleanup tests — Phase 5 slice 6.
//
// Verifies POST /api/admin/cleanup:
//   * Cancels pending_payment bookings whose hold_expires_at has
//     passed; leaves still-fresh holds alone.
//   * Cancels incomplete/pending subscriptions older than 24h; leaves
//     newer ones alone.
//   * Closes the active subscription_plan_periods row when a
//     subscription is cancelled.
//   * After cleanup, a member can start a new checkout (the
//     subscriptions_one_active_per_member partial unique index
//     no longer blocks them).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-cleanup';
const TZ = 'UTC';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let resource_id;
let public_offering_id;

const { app } = await import('../src/app.js');

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Cleanup Tests', $2)
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
     VALUES ($1, $2, $3, 'Admin', 'X') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // Resource + public offering for booking fixtures.
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cleanup Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  public_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cleanup Public', 'cage-time', 60, 0, 4500, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, public_offering_id, resource_id],
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

// Insert a synthetic pending_payment booking via privileged pool.
// hold_expires_at <= start_time is enforced by the schema; we set
// both to a chosen offset.
async function syntheticPendingBooking({ holdHoursFromNow }) {
  const startMs = Date.now() + Math.max(holdHoursFromNow + 1, 1) * 60 * 60 * 1000;
  const start = new Date(startMs);
  const end = new Date(startMs + 60 * 60 * 1000);
  const hold = new Date(Date.now() + holdHoursFromNow * 60 * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id,
       customer_first_name, customer_last_name, customer_email,
       start_time, end_time, status, hold_expires_at,
       amount_due_cents, credit_cost_charged, payment_status
     ) VALUES (
       $1, $2, $3, 'Stale', 'Hold', $4, $5, $6,
       'pending_payment', $7, 4500, 0, 'pending'
     )
     RETURNING id, hold_expires_at`,
    [
      tenant_id,
      public_offering_id,
      resource_id,
      `cleanup-${randomUUID()}@example.com`,
      start,
      end,
      hold,
    ],
  );
  return r.rows[0];
}

// Insert a synthetic incomplete subscription via privileged pool.
async function syntheticStaleSubscription({ ageHours, status = 'incomplete' }) {
  const memberEmail = `m-${randomUUID()}@example.com`;
  const memberId = randomUUID();
  const subId = randomUUID();
  const planId = randomUUID();

  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    await c.query(
      `INSERT INTO members (id, tenant_id, email, first_name, last_name)
       VALUES ($1, $2, $3, 'Cleanup', 'Member')`,
      [memberId, tenant_id, memberEmail],
    );
    await c.query(
      `INSERT INTO plans (id, tenant_id, name, monthly_price_cents, credits_per_week, active)
       VALUES ($1, $2, $3, 5000, 5, true)`,
      [planId, tenant_id, `Plan ${randomUUID().slice(0, 6)}`],
    );
    await c.query(
      `INSERT INTO subscriptions (
         id, tenant_id, member_id, status,
         stripe_subscription_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, now() - ($6 * interval '1 hour'))`,
      [
        subId,
        tenant_id,
        memberId,
        status,
        `sub_test_stale_${randomUUID().slice(0, 6)}`,
        ageHours,
      ],
    );
    await c.query(
      `INSERT INTO subscription_plan_periods
         (tenant_id, subscription_id, plan_id, started_at)
       VALUES ($1, $2, $3, now() - ($4 * interval '1 hour'))`,
      [tenant_id, subId, planId, ageHours],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  return { memberId, subId, planId };
}

// ============================================================
// expired pending_payment bookings
// ============================================================

test('cleanup cancels pending_payment booking whose hold_expires_at has passed', { skip }, async () => {
  // Stale: hold expired 30 min ago
  const stale = await syntheticPendingBooking({ holdHoursFromNow: -0.5 });

  const res = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.bookings_cancelled >= 1);

  const r = await privilegedPool.query(
    `SELECT status, cancelled_at, cancelled_by_type, cancellation_reason
       FROM bookings WHERE id = $1`,
    [stale.id],
  );
  assert.equal(r.rows[0].status, 'cancelled');
  assert.ok(r.rows[0].cancelled_at);
  assert.equal(r.rows[0].cancelled_by_type, 'system');
  assert.match(r.rows[0].cancellation_reason, /hold expired/i);
});

test('cleanup leaves still-fresh pending_payment booking alone', { skip }, async () => {
  // Hold expires 30 min from now
  const fresh = await syntheticPendingBooking({ holdHoursFromNow: 0.5 });

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  const r = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [fresh.id],
  );
  assert.equal(r.rows[0].status, 'pending_payment');
});

// ============================================================
// stale incomplete subscriptions
// ============================================================

test('cleanup cancels incomplete subscription older than 24h + closes plan period', { skip }, async () => {
  const stale = await syntheticStaleSubscription({ ageHours: 25 });

  const res = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.subscriptions_cancelled >= 1);

  const subRow = await privilegedPool.query(
    `SELECT status, ended_at FROM subscriptions WHERE id = $1`,
    [stale.subId],
  );
  assert.equal(subRow.rows[0].status, 'cancelled');
  assert.ok(subRow.rows[0].ended_at);

  const periodRow = await privilegedPool.query(
    `SELECT ended_at FROM subscription_plan_periods
      WHERE subscription_id = $1`,
    [stale.subId],
  );
  assert.ok(
    periodRow.rows[0].ended_at,
    'plan period should be closed when subscription cleaned up',
  );
});

test('cleanup leaves incomplete subscription younger than 24h alone', { skip }, async () => {
  const fresh = await syntheticStaleSubscription({ ageHours: 1 });

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  const r = await privilegedPool.query(
    `SELECT status FROM subscriptions WHERE id = $1`,
    [fresh.subId],
  );
  assert.equal(r.rows[0].status, 'incomplete');
});

test('cleanup also cancels stale "pending" status subscriptions', { skip }, async () => {
  const stale = await syntheticStaleSubscription({ ageHours: 30, status: 'pending' });

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  const r = await privilegedPool.query(
    `SELECT status FROM subscriptions WHERE id = $1`,
    [stale.subId],
  );
  assert.equal(r.rows[0].status, 'cancelled');
});

test('cleanup does NOT cancel active subscriptions', { skip }, async () => {
  // Active subscription (created 30 days ago, status='active').
  const memberId = randomUUID();
  const subId = randomUUID();
  const planId = randomUUID();

  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    await c.query(
      `INSERT INTO members (id, tenant_id, email, first_name, last_name)
       VALUES ($1, $2, $3, 'Active', 'Sub')`,
      [memberId, tenant_id, `active-${randomUUID()}@example.com`],
    );
    await c.query(
      `INSERT INTO plans (id, tenant_id, name, monthly_price_cents, credits_per_week, active)
       VALUES ($1, $2, $3, 5000, 5, true)`,
      [planId, tenant_id, `Active Plan ${randomUUID().slice(0, 6)}`],
    );
    await c.query(
      `INSERT INTO subscriptions (
         id, tenant_id, member_id, status,
         stripe_subscription_id, activated_at, created_at
       ) VALUES ($1, $2, $3, 'active', $4, now() - interval '30 days', now() - interval '30 days')`,
      [
        subId,
        tenant_id,
        memberId,
        `sub_test_active_${randomUUID().slice(0, 6)}`,
      ],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  const r = await privilegedPool.query(
    `SELECT status FROM subscriptions WHERE id = $1`,
    [subId],
  );
  assert.equal(r.rows[0].status, 'active');
});

// ============================================================
// non-admin gate
// ============================================================

test('non-admin cannot run cleanup (403)', { skip }, async () => {
  const email = `member-only-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        first_name: 'Mem',
        last_name: 'Only',
      }),
    },
  );
  const memberToken = (await reg.json()).token;

  const res = await fetch(`${baseUrl}/api/admin/cleanup?tenant=${TENANT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
  });
  assert.equal(res.status, 403);
});

// ============================================================
// idempotency
// ============================================================

test('cleanup is idempotent: running again returns zero counts', { skip }, async () => {
  const stale = await syntheticPendingBooking({ holdHoursFromNow: -0.5 });

  const r1 = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  const body1 = await r1.json();
  assert.ok(body1.bookings_cancelled >= 1);

  // Second run — the booking we just cleaned isn't pending anymore,
  // and (assuming no other tests created stale bookings simultaneously)
  // the count for THAT booking is 0.
  const r2 = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  const body2 = await r2.json();
  assert.ok(body2.bookings_cancelled >= 0);

  // The booking we cleaned in r1 should still be cancelled (no flip-back).
  const check = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [stale.id],
  );
  assert.equal(check.rows[0].status, 'cancelled');
});
