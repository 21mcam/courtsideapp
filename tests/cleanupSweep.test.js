// Demo-hygiene slice: scheduled janitor tests.
//
// Covers:
//   * Booking auto-completion (new in this slice, part of both the
//     manual POST /api/admin/cleanup and the 10-minute sweep):
//     - confirmed booking with past end_time → completed
//     - future confirmed booking untouched
//     - no_show / cancelled bookings untouched (no_show stays a
//       manual admin action; the sweep never creates or clears it)
//     - expired pending_payment holds still get CANCELLED (not
//       completed) — disjoint FROM-states, no interference
//   * runCleanupSweep({ tenantId }) — the scheduler entry point —
//     works through the runtime pool (tenant_lookup + GUC-set
//     transaction) and is idempotent.
//   * runHorizonSweep({ tenantId }) — daily class-schedule horizon
//     extension — materializes class_instances ~90 days out for a
//     schedule whose generated_through fell behind, advances
//     generated_through, and no-ops on a second run.
//
// Both sweeps are invoked with { tenantId } scoping so this file
// never mutates fixtures owned by concurrently-running test files.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-demo-hygiene';
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
let offering_id;
let class_resource_id;
let class_offering_id;

const { app } = await import('../src/app.js');
const { runCleanupSweep } = await import('../src/controllers/cleanup.js');
const { runHorizonSweep } = await import('../src/controllers/classSchedules.js');

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Demo Hygiene Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Admin owner for the manual cleanup endpoint.
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

  // Rental resource + offering for booking fixtures.
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Hygiene Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Hygiene Rental', 'cage-time', 60, 0, 4500, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offering_id, resource_id],
  );

  // Class resource + offering for the horizon-extension fixture.
  class_resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Hygiene Studio') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Hygiene Class', 'classes', 60, 2, 2500, 8, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, class_offering_id, class_resource_id],
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

// Insert a synthetic customer booking. Each caller passes a distinct
// hour window so the GiST exclusion on (resource, time_range) never
// collides across fixtures sharing the resource.
async function syntheticBooking({ startHoursFromNow, status, extra = {} }) {
  const startMs = Date.now() + startHoursFromNow * 60 * 60 * 1000;
  const start = new Date(startMs);
  const end = new Date(startMs + 60 * 60 * 1000);
  const cols = {
    payment_status: 'paid',
    amount_paid_cents: 4500,
    ...extra,
  };
  const r = await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id,
       customer_first_name, customer_last_name, customer_email,
       start_time, end_time, status,
       amount_due_cents, credit_cost_charged,
       payment_status, amount_paid_cents,
       hold_expires_at, no_show_marked_at, cancelled_at
     ) VALUES (
       $1, $2, $3, 'Demo', 'Hygiene', $4, $5, $6, $7,
       4500, 0, $8, $9, $10, $11, $12
     )
     RETURNING id`,
    [
      tenant_id,
      offering_id,
      resource_id,
      `hygiene-${randomUUID()}@example.com`,
      start,
      end,
      status,
      cols.payment_status,
      cols.amount_paid_cents,
      cols.hold_expires_at ?? null,
      cols.no_show_marked_at ?? null,
      cols.cancelled_at ?? null,
    ],
  );
  return r.rows[0];
}

async function bookingStatus(id) {
  const r = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [id],
  );
  return r.rows[0].status;
}

// ============================================================
// booking auto-completion (manual endpoint)
// ============================================================

test('cleanup completes confirmed bookings whose end_time has passed', { skip }, async () => {
  // Ended 2h ago (start -3h, end -2h).
  const past = await syntheticBooking({ startHoursFromNow: -3, status: 'confirmed' });

  const res = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.bookings_completed >= 1);

  assert.equal(await bookingStatus(past.id), 'completed');
});

test('cleanup leaves future confirmed bookings alone', { skip }, async () => {
  const future = await syntheticBooking({ startHoursFromNow: 20, status: 'confirmed' });

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  assert.equal(await bookingStatus(future.id), 'confirmed');
});

test('cleanup never touches no_show or cancelled bookings', { skip }, async () => {
  const noShow = await syntheticBooking({
    startHoursFromNow: -6,
    status: 'no_show',
    extra: { no_show_marked_at: new Date() },
  });
  const cancelled = await syntheticBooking({
    startHoursFromNow: -9,
    status: 'cancelled',
    extra: { cancelled_at: new Date() },
  });

  await adminFetch('/api/admin/cleanup', { method: 'POST' });

  assert.equal(await bookingStatus(noShow.id), 'no_show');
  assert.equal(await bookingStatus(cancelled.id), 'cancelled');
});

test('expired pending_payment holds are cancelled, not completed', { skip }, async () => {
  // Future slot (+30h) whose hold expired 30 minutes ago.
  const pending = await syntheticBooking({
    startHoursFromNow: 30,
    status: 'pending_payment',
    extra: {
      payment_status: 'pending',
      amount_paid_cents: 0,
      hold_expires_at: new Date(Date.now() - 30 * 60 * 1000),
    },
  });

  const res = await adminFetch('/api/admin/cleanup', { method: 'POST' });
  const body = await res.json();
  assert.ok(body.bookings_cancelled >= 1);

  const r = await privilegedPool.query(
    `SELECT status, cancelled_by_type FROM bookings WHERE id = $1`,
    [pending.id],
  );
  assert.equal(r.rows[0].status, 'cancelled');
  assert.equal(r.rows[0].cancelled_by_type, 'system');
});

// ============================================================
// runCleanupSweep — the scheduler entry point
// ============================================================

test('runCleanupSweep completes past bookings via the runtime pool', { skip }, async () => {
  const past = await syntheticBooking({ startHoursFromNow: -12, status: 'confirmed' });

  const results = await runCleanupSweep({ tenantId: tenant_id });
  assert.equal(results.length, 1);
  assert.equal(results[0].tenant_id, tenant_id);
  assert.ok(results[0].bookings_completed >= 1);

  assert.equal(await bookingStatus(past.id), 'completed');

  // Idempotent: a second scoped run finds nothing left to complete
  // (this file owns the tenant, so counts are deterministic).
  const again = await runCleanupSweep({ tenantId: tenant_id });
  assert.equal(again[0].bookings_completed, 0);
  assert.equal(await bookingStatus(past.id), 'completed');
});

// ============================================================
// runHorizonSweep — daily class-schedule horizon extension
// ============================================================

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

test('runHorizonSweep extends a stale class schedule ~90 days out', { skip }, async () => {
  // Schedule starts on the most recent Monday, with generated_through
  // stuck at start_date — as if the initial generation happened long
  // ago and nothing has topped it up since.
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(now.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const startDate = isoDate(monday);

  const schedRes = await privilegedPool.query(
    `INSERT INTO class_schedules (
       tenant_id, offering_id, resource_id, day_of_week,
       start_time, start_date, generated_through
     ) VALUES ($1, $2, $3, 1, '10:00', $4, $4)
     RETURNING id`,
    [tenant_id, class_offering_id, class_resource_id, startDate],
  );
  const schedule_id = schedRes.rows[0].id;

  const results = await runHorizonSweep({ tenantId: tenant_id });
  assert.equal(results.length, 1);
  assert.equal(results[0].tenant_id, tenant_id);
  assert.ok(
    results[0].schedules_extended >= 1,
    'schedule should have been extended',
  );
  assert.ok(
    results[0].generated >= 10,
    `expected ~12 weekly instances, got ${results[0].generated}`,
  );

  // generated_through advanced to the last Monday within today+90d.
  const schedRow = await privilegedPool.query(
    `SELECT generated_through FROM class_schedules WHERE id = $1`,
    [schedule_id],
  );
  const generatedThrough = new Date(schedRow.rows[0].generated_through);
  const minExpected = new Date(now.getTime() + 80 * 24 * 60 * 60 * 1000);
  assert.ok(
    generatedThrough > minExpected,
    `generated_through ${isoDate(generatedThrough)} should be > ${isoDate(minExpected)}`,
  );

  const countRes = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM class_instances
      WHERE tenant_id = $1 AND class_schedule_id = $2`,
    [tenant_id, schedule_id],
  );
  assert.ok(countRes.rows[0].n >= 10);

  // Idempotent: running again the same day generates nothing new.
  const again = await runHorizonSweep({ tenantId: tenant_id });
  assert.equal(again[0].generated, 0);
  const countAgain = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM class_instances
      WHERE tenant_id = $1 AND class_schedule_id = $2`,
    [tenant_id, schedule_id],
  );
  assert.equal(countAgain.rows[0].n, countRes.rows[0].n);
});

test('runHorizonSweep skips inactive schedules', { skip }, async () => {
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(now.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const startDate = isoDate(monday);

  // Inactive schedule on a different weekday/time to avoid GiST
  // overlap with the active fixture above (same resource).
  const schedRes = await privilegedPool.query(
    `INSERT INTO class_schedules (
       tenant_id, offering_id, resource_id, day_of_week,
       start_time, start_date, generated_through, active
     ) VALUES ($1, $2, $3, 1, '14:00', $4, $4, false)
     RETURNING id`,
    [tenant_id, class_offering_id, class_resource_id, startDate],
  );
  const schedule_id = schedRes.rows[0].id;

  await runHorizonSweep({ tenantId: tenant_id });

  const countRes = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM class_instances
      WHERE tenant_id = $1 AND class_schedule_id = $2`,
    [tenant_id, schedule_id],
  );
  assert.equal(countRes.rows[0].n, 0, 'inactive schedule must not generate');

  const schedRow = await privilegedPool.query(
    `SELECT generated_through FROM class_schedules WHERE id = $1`,
    [schedule_id],
  );
  assert.equal(isoDate(new Date(schedRow.rows[0].generated_through)), startDate);
});
