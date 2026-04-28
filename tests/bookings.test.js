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

  // Booking policy used by the cancel tests below. Set explicit
  // values so refund-tier assertions are deterministic regardless
  // of schema defaults.
  // Permissive max_advance_booking_days so existing 2027-dated tests
  // aren't rejected by the advance-window policy. Specific tests
  // below temporarily tighten it to assert the gate works.
  await privilegedPool.query(
    `INSERT INTO booking_policies (
       tenant_id, free_cancel_hours_before,
       partial_refund_hours_before, partial_refund_percent,
       allow_member_self_cancel,
       min_advance_booking_minutes, max_advance_booking_days
     ) VALUES ($1, 24, 6, 50, true, 0, 730)
     ON CONFLICT (tenant_id) DO UPDATE SET
       free_cancel_hours_before    = EXCLUDED.free_cancel_hours_before,
       partial_refund_hours_before = EXCLUDED.partial_refund_hours_before,
       partial_refund_percent      = EXCLUDED.partial_refund_percent,
       allow_member_self_cancel    = EXCLUDED.allow_member_self_cancel,
       min_advance_booking_minutes = EXCLUDED.min_advance_booking_minutes,
       max_advance_booking_days    = EXCLUDED.max_advance_booking_days`,
    [tenant_id],
  );

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

// ============================================================
// cancel flow
// ============================================================

// Inserts a synthetic confirmed booking via the privileged pool —
// bypasses the real op_hours / availability gates so the cancel
// tests can put bookings at arbitrary distances from `now` without
// fighting the booking-creation flow's window checks. The cancel
// path itself doesn't care about op_hours, only about start_time
// vs now and policy thresholds.
async function syntheticBooking({ member_id, hoursFromNow, credits = OFFERING_CREDITS }) {
  const start = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const end = new Date(start.getTime() + OFFERING_DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id, member_id,
       start_time, end_time, status,
       amount_due_cents, credit_cost_charged, payment_status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'confirmed', 0, $7, 'not_required'
     )
     RETURNING id, start_time, end_time, credit_cost_charged`,
    [tenant_id, offering_id, resource_id, member_id, start, end, credits],
  );
  return r.rows[0];
}

test('cancel ≥24h before start: 100% refund', { skip }, async () => {
  const m = await newMember();
  // Member starts at 0 credits — refund will push them up.
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: 48,
  });

  const res = await memberFetch(m.token, `/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancellation_reason: 'changed plans' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refund_percent, 100);
  assert.equal(body.refund_credits, OFFERING_CREDITS);
  assert.equal(body.balance_after, OFFERING_CREDITS);
  assert.ok(body.refund_entry_id);

  // Booking row is now cancelled with audit fields populated.
  const updated = await privilegedPool.query(
    `SELECT status, cancelled_at, cancelled_by_type, cancelled_by_user_id,
            cancellation_reason
       FROM bookings WHERE id = $1`,
    [booking.id],
  );
  assert.equal(updated.rows[0].status, 'cancelled');
  assert.ok(updated.rows[0].cancelled_at);
  assert.equal(updated.rows[0].cancelled_by_type, 'member');
  assert.equal(updated.rows[0].cancelled_by_user_id, m.user_id);
  assert.equal(updated.rows[0].cancellation_reason, 'changed plans');

  // Ledger has a booking_refund row referencing this booking.
  const ledger = await privilegedPool.query(
    `SELECT amount, reason, booking_id FROM credit_ledger_entries
      WHERE member_id = $1 AND booking_id = $2`,
    [m.member_id, booking.id],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].reason, 'booking_refund');
  assert.equal(ledger.rows[0].amount, OFFERING_CREDITS);
});

test('cancel between partial and free windows: partial refund (50%)', { skip }, async () => {
  const m = await newMember();
  // 12h is < 24 (free) but ≥ 6 (partial). Policy says 50%.
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: 12,
  });

  const res = await memberFetch(m.token, `/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refund_percent, 50);
  // floor(3 * 50 / 100) = 1
  assert.equal(body.refund_credits, 1);
  assert.equal(body.balance_after, 1);
});

test('cancel inside no-refund window: cancel succeeds, refund = 0', { skip }, async () => {
  const m = await newMember();
  // 1h is < 6 (partial threshold) — no refund.
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: 1,
  });

  const res = await memberFetch(m.token, `/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refund_percent, 0);
  assert.equal(body.refund_credits, 0);
  // No apply_credit_change call when refund == 0; balance_after is null.
  assert.equal(body.balance_after, null);

  // Booking still cancelled.
  const updated = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [booking.id],
  );
  assert.equal(updated.rows[0].status, 'cancelled');

  // No ledger entry for this booking.
  const ledger = await privilegedPool.query(
    `SELECT 1 FROM credit_ledger_entries WHERE booking_id = $1`,
    [booking.id],
  );
  assert.equal(ledger.rows.length, 0);
});

test('cancel an already-cancelled booking → 409', { skip }, async () => {
  const m = await newMember();
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: 48,
  });

  // First cancel — succeeds.
  const first = await memberFetch(m.token, `/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(first.status, 200);

  // Second cancel — booking is now 'cancelled', not 'confirmed'.
  const second = await memberFetch(m.token, `/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.match(body.error, /cancelled.*confirmed/i);
});

test('member cannot cancel another member\'s booking → 403', { skip }, async () => {
  const owner = await newMember();
  const stranger = await newMember();

  const booking = await syntheticBooking({
    member_id: owner.member_id,
    hoursFromNow: 48,
  });

  const res = await memberFetch(
    stranger.token,
    `/api/bookings/${booking.id}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
  assert.equal(res.status, 403);

  // Booking remains confirmed.
  const check = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [booking.id],
  );
  assert.equal(check.rows[0].status, 'confirmed');
});

// ============================================================
// advance-booking window policy
// ============================================================

// booking_policies.min_advance_booking_minutes / max_advance_booking_days
// gate booking creation. The shared tenant fixture is permissive (0
// min, 730 days); each test below tightens the policy, runs, then
// restores. Tests pick unique slot dates so they don't collide with
// other booking-creation tests.

async function setAdvanceWindow(minMin, maxDays) {
  await privilegedPool.query(
    `UPDATE booking_policies
        SET min_advance_booking_minutes = $1,
            max_advance_booking_days    = $2
      WHERE tenant_id = $3`,
    [minMin, maxDays, tenant_id],
  );
}

test('advance window: booking too soon (< min_advance) → 409', { skip }, async () => {
  await setAdvanceWindow(60, 730); // require 60 min lead time
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);

    // Slot 30 min from now — under the 60-min floor.
    const start = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const res = await memberFetch(m.token, '/api/bookings', {
      method: 'POST',
      body: JSON.stringify({ offering_id, resource_id, start_time: start }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /at least 60 minutes/i);

    // No booking row created — request rejected before INSERT.
    const dbCheck = await privilegedPool.query(
      `SELECT 1 FROM bookings WHERE member_id = $1`,
      [m.member_id],
    );
    assert.equal(dbCheck.rows.length, 0);
  } finally {
    await setAdvanceWindow(0, 730);
  }
});

test('advance window: booking too far out (> max_advance_days) → 409', { skip }, async () => {
  await setAdvanceWindow(0, 7); // only 7 days out
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);

    // 2027-02-01 is hundreds of days out — exceeds 7.
    const res = await memberFetch(m.token, '/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        offering_id,
        resource_id,
        start_time: '2027-02-01T19:00:00.000Z',
      }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /more than 7 days/i);
  } finally {
    await setAdvanceWindow(0, 730);
  }
});

test('advance window: slot inside the policy window → 201', { skip }, async () => {
  await setAdvanceWindow(0, 14); // 14-day window
  try {
    const m = await newMember();
    await grantCredits(m.member_id, 5);

    // 5 days from now at noon UTC (well inside operating hours for
    // most days; we'll pick a Monday slot at 14:00 EST = 19:00 UTC
    // when DOW happens to land on Monday). Actually, simpler: just
    // use a fixed Monday 5-7 days out from a known reference.
    //
    // currentDate context: 2026-04-28 (Tuesday). Closest Monday
    // in window: 2026-05-04 (6 days out, Monday).
    const res = await memberFetch(m.token, '/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        offering_id,
        resource_id,
        start_time: '2026-05-04T19:00:00.000Z', // 14:00 EST
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.booking.status, 'confirmed');

    // Cleanup so this booking doesn't leak into other tests.
    await privilegedPool.query(
      `DELETE FROM credit_ledger_entries WHERE booking_id = $1`,
      [body.booking.id],
    );
    await privilegedPool.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE id = $1`,
      [body.booking.id],
    );
  } finally {
    await setAdvanceWindow(0, 730);
  }
});

// ============================================================
// no-show flow
// ============================================================

// Admin-only endpoint that flips a confirmed booking whose start_time
// has already passed into 'no_show'. Members get 403; future bookings
// get 409; non-confirmed statuses get 409.

test('admin marks a past confirmed booking as no_show → 200, audit fields populated', { skip }, async () => {
  const m = await newMember();
  // 2 hours ago — well past start_time.
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: -2,
  });

  const res = await fetch(
    `${baseUrl}/api/bookings/${booking.id}/mark-no-show?tenant=${TENANT}`,
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
  assert.equal(body.booking_id, booking.id);
  // Policy is the row inserted in `before` — no_show_action default 'none'.
  assert.equal(body.policy_action, 'none');

  const updated = await privilegedPool.query(
    `SELECT status, no_show_marked_at, no_show_marked_by FROM bookings WHERE id = $1`,
    [booking.id],
  );
  assert.equal(updated.rows[0].status, 'no_show');
  assert.ok(updated.rows[0].no_show_marked_at);
  assert.ok(updated.rows[0].no_show_marked_by);

  // Member's credits are NOT refunded — no_show forfeits them. The
  // synthetic booking didn't actually debit credits, so member
  // balance should still be 0.
  const bal = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [m.member_id],
  );
  // No credit_balance row may exist if no ledger entries — that's fine,
  // the point is no refund was issued.
  if (bal.rows.length > 0) {
    assert.equal(bal.rows[0].current_credits, 0);
  }
});

test('member cannot mark no_show → 403', { skip }, async () => {
  const m = await newMember();
  // Past hoursFromNow values are spaced > duration apart to avoid
  // exclusion-constraint collisions on the shared resource. Each
  // test below picks a unique negative offset.
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: -4,
  });

  const res = await memberFetch(
    m.token,
    `/api/bookings/${booking.id}/mark-no-show`,
    { method: 'POST' },
  );
  assert.equal(res.status, 403);

  // Booking remains confirmed.
  const check = await privilegedPool.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [booking.id],
  );
  assert.equal(check.rows[0].status, 'confirmed');
});

test('cannot mark no_show on a future booking → 409', { skip }, async () => {
  const m = await newMember();
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: 24,
  });

  const res = await fetch(
    `${baseUrl}/api/bookings/${booking.id}/mark-no-show?tenant=${TENANT}`,
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
});

test('cannot mark no_show on an already-cancelled booking → 409', { skip }, async () => {
  const m = await newMember();
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: -6,
  });

  // Cancel it first directly via privileged pool.
  await privilegedPool.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [booking.id],
  );

  const res = await fetch(
    `${baseUrl}/api/bookings/${booking.id}/mark-no-show?tenant=${TENANT}`,
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
  assert.match(body.error, /cancelled.*confirmed/i);
});

test('cannot mark no_show on an already-no_show booking → 409', { skip }, async () => {
  const m = await newMember();
  const booking = await syntheticBooking({
    member_id: m.member_id,
    hoursFromNow: -8,
  });

  // First call succeeds.
  const first = await fetch(
    `${baseUrl}/api/bookings/${booking.id}/mark-no-show?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    },
  );
  assert.equal(first.status, 200);

  // Second call on same booking — now in 'no_show', not 'confirmed'.
  const second = await fetch(
    `${baseUrl}/api/bookings/${booking.id}/mark-no-show?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    },
  );
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.match(body.error, /no_show.*confirmed/i);
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
