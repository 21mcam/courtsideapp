// No-login manage/reschedule flow — walk-in checkout v2.
//
// Covers:
//   * GET  /api/customers/bookings/manage/:token
//     - happy path: booking details + reschedule block + offering
//       resources for the picker
//     - unknown/garbage token → same 404 body as the lookup endpoint
//     - cross-tenant token → 404 (RLS + tenant filter)
//   * POST /api/customers/bookings/manage/:token/reschedule
//     - happy path: row moves, audit trail stamped, payment untouched,
//       reschedule email queued with the same manage link
//     - same-resource small shift (self-overlap exclusion)
//     - occupied target → 409 slot_conflict
//     - cutoff passed → 409 reschedule_cutoff_passed
//     - new slot outside advance window → 409 (uncoded)
//     - pending_payment / cancelled bookings → not reschedulable
//
// Tokens are minted by the payment webhook, so most tests run a full
// create → webhook-confirm cycle and then read the raw token out of
// the confirmation email in the keyless skipped-send log.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT = 'verify-reschedule';
const TZ = 'America/New_York';
const WEBHOOK_SECRET = 'whsec_test_reschedule';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');
const emailSvc = await import('../src/services/email.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let stripe_account_id;
let cage_a; // resource with hours
let cage_b; // second resource — cross-resource reschedules
let offering_id;
const DURATION_MIN = 60;
const DOLLAR_PRICE = 6000; // $60.00 — Momentum's AOV, why not

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Reschedule Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ])
  ).rows[0].id;

  // Permissive advance window (2027 fixtures) + 24h reschedule cutoff.
  await privilegedPool.query(
    `INSERT INTO booking_policies
       (tenant_id, max_advance_booking_days, customer_reschedule_hours_before)
     VALUES ($1, 730, 24)
     ON CONFLICT (tenant_id) DO UPDATE SET
       max_advance_booking_days = EXCLUDED.max_advance_booking_days,
       customer_reschedule_hours_before = EXCLUDED.customer_reschedule_hours_before`,
    [tenant_id],
  );

  stripeFake.__resetStripeFake();
  stripe_account_id = `acct_test_${randomUUID().slice(0, 8)}`;
  stripeFake.__setAccountState(stripe_account_id, {
    id: stripe_account_id,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  await privilegedPool.query(
    `INSERT INTO stripe_connections (tenant_id, stripe_account_id,
       details_submitted, charges_enabled, payouts_enabled)
     VALUES ($1, $2, true, true, true)`,
    [tenant_id, stripe_account_id],
  );

  cage_a = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage A') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  cage_b = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage B') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, '60-min Cage', 'cage-time', $2, 0, $3, 1, false, true)
       RETURNING id`,
      [tenant_id, DURATION_MIN, DOLLAR_PRICE],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [tenant_id, offering_id, cage_a, cage_b],
  );
  // Mondays 9-17 EST on both cages.
  await privilegedPool.query(
    `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, 1, '09:00', '17:00'), ($1, $3, 1, '09:00', '17:00')`,
    [tenant_id, cage_a, cage_b],
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
    await privilegedPool.query(
      `DELETE FROM stripe_webhook_events WHERE account_id = $1`,
      [stripe_account_id],
    );
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
// ============================================================

function publicFetch(path, init = {}, tenantSub = TENANT) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${tenantSub}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function postWebhook(eventBody) {
  const payload = JSON.stringify(eventBody);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body: payload,
  });
}

// Full lifecycle: create pending booking on cage A → webhook-confirm →
// extract the raw manage token from the confirmation email.
async function confirmedBooking(start_time, { resource = null } = {}) {
  emailSvc.__clearSkippedEmails();
  const email = `resched-${randomUUID()}@example.com`;
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id: resource ?? cage_a,
      start_time,
      customer: { full_name: 'Momo Fan', phone: '+15555550160', email },
      success_url: 'https://app.example/walk-in/success',
      cancel_url: 'https://app.example/walk-in?cancelled=1',
    }),
  });
  const created = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    throw new Error(`create failed: ${res.status} ${created.error}`);
  }
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    created.session_id,
  );
  const wres = await postWebhook({
    id: `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: session.id,
        mode: 'payment',
        status: 'complete',
        amount_total: DOLLAR_PRICE,
        payment_intent,
        metadata: session.metadata,
      },
    },
  });
  assert.equal(wres.status, 200);
  const mail = emailSvc
    .__getSkippedEmails()
    .find((e) => e.to === email && /confirmed/i.test(e.subject));
  assert.ok(mail, 'confirmation email queued');
  const m = mail.text.match(/\/walk-in\/manage\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'manage URL in email');
  return { booking_id: created.booking.id, token: m[1], email };
}

function manageGet(token) {
  return publicFetch(`/api/customers/bookings/manage/${token}`);
}

function reschedulePost(token, body) {
  return publicFetch(`/api/customers/bookings/manage/${token}/reschedule`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ============================================================
// manage GET
// ============================================================

test('manage GET returns booking + reschedule window + offering resources', { skip }, async () => {
  const { booking_id, token } = await confirmedBooking('2027-08-02T15:00:00.000Z');
  const res = await manageGet(token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.booking.id, booking_id);
  assert.equal(body.booking.status, 'confirmed');
  assert.equal(body.booking.payment_status, 'paid');
  assert.equal(body.booking.offering_name, '60-min Cage');
  assert.equal(body.booking.reschedule_count, 0);
  assert.equal(body.reschedule.allowed, true);
  assert.equal(body.reschedule.reason, null);
  assert.equal(body.reschedule.hours_before, 24);
  // cutoff = start - 24h
  assert.equal(
    body.reschedule.cutoff_at,
    '2027-08-01T15:00:00.000Z',
  );
  // Picker constraints ride along.
  assert.equal(body.offering.id, offering_id);
  assert.deepEqual(
    body.offering.resources.map((r) => r.name).sort(),
    ['Cage A', 'Cage B'],
  );
});

test('manage GET: unknown and garbage tokens 404 with the lookup body', { skip }, async () => {
  for (const bad of ['x', 'a'.repeat(40), randomUUID()]) {
    const res = await manageGet(bad);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'booking not found' });
  }
});

test('manage token from tenant A is a 404 under tenant B', { skip }, async () => {
  const { token } = await confirmedBooking('2027-08-02T16:00:00.000Z');
  const otherSub = `verify-resched-b-${randomUUID().slice(0, 6)}`;
  const otherTid = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Other', 'UTC') RETURNING id`,
      [otherSub],
    )
  ).rows[0].id;
  try {
    const res = await publicFetch(
      `/api/customers/bookings/manage/${token}`,
      {},
      otherSub,
    );
    assert.equal(res.status, 404);
  } finally {
    await privilegedPool.query(`DELETE FROM tenants WHERE id = $1`, [otherTid]);
  }
});

// ============================================================
// reschedule POST
// ============================================================

test('reschedule happy path: row moves, audit stamped, payment untouched, email queued', { skip }, async () => {
  const { booking_id, token, email } = await confirmedBooking(
    '2027-08-09T15:00:00.000Z',
  );
  emailSvc.__clearSkippedEmails();

  const res = await reschedulePost(token, {
    start_time: '2027-08-09T18:00:00.000Z',
    resource_id: cage_b,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.booking.start_time, '2027-08-09T18:00:00.000Z');
  assert.equal(body.booking.resource_name, 'Cage B');
  assert.equal(body.booking.reschedule_count, 1);

  const r = await privilegedPool.query(
    `SELECT start_time, end_time, resource_id, previous_start_time,
            rescheduled_at, reschedule_count, status, payment_status,
            amount_due_cents, amount_paid_cents, manage_token_hash
       FROM bookings WHERE id = $1`,
    [booking_id],
  );
  const row = r.rows[0];
  assert.equal(row.start_time.toISOString(), '2027-08-09T18:00:00.000Z');
  assert.equal(row.end_time.toISOString(), '2027-08-09T19:00:00.000Z');
  assert.equal(row.resource_id, cage_b);
  assert.equal(row.previous_start_time.toISOString(), '2027-08-09T15:00:00.000Z');
  assert.ok(row.rescheduled_at);
  assert.equal(row.reschedule_count, 1);
  // Same offering, same price — nothing money-side may move.
  assert.equal(row.status, 'confirmed');
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.amount_due_cents, DOLLAR_PRICE);
  assert.equal(row.amount_paid_cents, DOLLAR_PRICE);
  // Token unchanged: the emailed link keeps working.
  assert.equal(
    row.manage_token_hash,
    createHash('sha256').update(token).digest('hex'),
  );

  // Reschedule email with old + new time and the SAME manage link.
  const mail = emailSvc
    .__getSkippedEmails()
    .find((e) => e.to === email && /moved/i.test(e.subject));
  assert.ok(mail, 'reschedule email queued');
  assert.ok(mail.text.includes(`/walk-in/manage?token=${token}`));
});

test('same-resource small shift works (self-overlap excluded)', { skip }, async () => {
  const { token } = await confirmedBooking('2027-08-16T15:00:00.000Z');
  // Overlaps its own old window (15:00-16:00 → 15:00+30m? no — same
  // resource, shifted 1h earlier into 14:00-15:00 would NOT overlap;
  // use a genuinely overlapping shift: 15:30 is not slot-aligned but
  // the API takes any in-hours start. 14:30-15:30 overlaps 15:00.)
  const res = await reschedulePost(token, {
    start_time: '2027-08-16T14:30:00.000Z',
    resource_id: cage_a,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.booking.start_time, '2027-08-16T14:30:00.000Z');
});

test('occupied target slot → 409 slot_conflict', { skip }, async () => {
  const { token } = await confirmedBooking('2027-08-23T15:00:00.000Z');
  // Occupy the target on BOTH cages so no candidate works.
  const blockerA = await confirmedBooking('2027-08-23T17:00:00.000Z', {
    resource: cage_a,
  });
  assert.ok(blockerA);
  const res = await reschedulePost(token, {
    start_time: '2027-08-23T17:00:00.000Z',
    resource_id: cage_a,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'slot_conflict');
});

test('cutoff passed → 409 reschedule_cutoff_passed', { skip }, async () => {
  // Booking whose start is ~12h out (inside the 24h cutoff), placed
  // directly in the DB with a known token hash — the public create
  // path can't make near-term Monday-hours bookings deterministically.
  const token = randomUUID() + randomUUID();
  const hash = createHash('sha256').update(token).digest('hex');
  const start = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + DURATION_MIN * 60 * 1000);
  await privilegedPool.query(
    `INSERT INTO bookings
       (tenant_id, offering_id, resource_id,
        customer_first_name, customer_last_name, customer_email,
        customer_phone, start_time, end_time, status,
        amount_due_cents, amount_paid_cents, payment_status,
        manage_token_hash)
     VALUES ($1, $2, $3, 'Cut', 'Off', 'cutoff@example.com',
             '+15555550161', $4, $5, 'confirmed', $6, $6, 'paid', $7)`,
    [tenant_id, offering_id, cage_a, start, end, DOLLAR_PRICE, hash],
  );

  const g = await manageGet(token);
  assert.equal(g.status, 200);
  const gb = await g.json();
  assert.equal(gb.reschedule.allowed, false);
  assert.equal(gb.reschedule.reason, 'cutoff_passed');

  const res = await reschedulePost(token, {
    start_time: '2027-08-30T15:00:00.000Z',
    resource_id: cage_a,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'reschedule_cutoff_passed');
});

test('new slot outside the advance window → 409 uncoded', { skip }, async () => {
  const { token } = await confirmedBooking('2027-09-06T15:00:00.000Z');
  await privilegedPool.query(
    `UPDATE booking_policies SET max_advance_booking_days = 7
      WHERE tenant_id = $1`,
    [tenant_id],
  );
  try {
    const res = await reschedulePost(token, {
      start_time: '2027-09-06T18:00:00.000Z',
      resource_id: cage_a,
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /more than 7 days/i);
    assert.equal(body.code, undefined);
  } finally {
    await privilegedPool.query(
      `UPDATE booking_policies SET max_advance_booking_days = 730
        WHERE tenant_id = $1`,
      [tenant_id],
    );
  }
});

test('pending_payment and cancelled bookings are not reschedulable', { skip }, async () => {
  // Cancelled: confirm one, cancel it, then try.
  const { booking_id, token } = await confirmedBooking(
    '2027-09-13T15:00:00.000Z',
  );
  await privilegedPool.query(
    `UPDATE bookings
        SET status = 'cancelled', cancelled_at = now(),
            cancelled_by_type = 'admin',
            cancelled_by_user_id = gen_random_uuid(),
            payment_status = 'refunded',
            amount_refunded_cents = amount_paid_cents
      WHERE id = $1`,
    [booking_id],
  );
  const res = await reschedulePost(token, {
    start_time: '2027-09-13T18:00:00.000Z',
    resource_id: cage_a,
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_reschedulable');

  const g = await manageGet(token);
  const gb = await g.json();
  assert.equal(gb.reschedule.allowed, false);
  assert.equal(gb.reschedule.reason, 'not_confirmed');

  // pending_payment rows never have a token in real life (the webhook
  // mints on confirm) — the closest real-world case is covered above.
});
