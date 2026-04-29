// Walk-in booking flow tests — Phase 5 slice 7.
//
// Covers:
//   * POST /api/customers/bookings (public, no auth):
//     - 404 unknown offering
//     - 403 offering doesn't allow public booking
//     - 409 offering is class (capacity > 1)
//     - 409 slot outside operating hours
//     - 409 slot already booked (creates first booking, second 409s)
//     - 409 tenant has no charges-enabled connection
//     - 201 happy path: booking row in pending_payment with hold_expires_at;
//       Stripe Checkout session created with metadata + price_data
//   * Webhook checkout.session.completed (mode='payment'):
//     - Flips booking → confirmed + paid + payment_intent stamped + amount_paid_cents
//     - Idempotent (dedup table catches duplicate event_id)
//     - Status guard: cancelled-meanwhile booking does NOT get re-confirmed

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT = 'verify-walkins';
const TZ = 'America/New_York';
const WEBHOOK_SECRET = 'whsec_test_walkins';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let stripe_account_id;
let resource_id;
let public_offering_id;
let private_offering_id;
let class_offering_id;
const DURATION_MIN = 60;
const DOLLAR_PRICE = 4500; // $45.00

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Walk-in Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Admin owner so platform endpoints work, even though walk-in booking
  // itself doesn't need auth.
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'X') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash('password', 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // Stripe connection — onboarded.
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

  // Resource + offerings.
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Walk-in Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  public_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Public Cage 60min', 'cage-time', $2, 3, $3, 1, true, true)
       RETURNING id`,
      [tenant_id, DURATION_MIN, DOLLAR_PRICE],
    )
  ).rows[0].id;
  private_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Members-only Cage', 'cage-time', $2, 3, $3, 1, true, false)
       RETURNING id`,
      [tenant_id, DURATION_MIN, DOLLAR_PRICE],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Classy', 'classes', $2, 2, $3, 8, true, true)
       RETURNING id`,
      [tenant_id, DURATION_MIN, DOLLAR_PRICE],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)`,
    [tenant_id, public_offering_id, resource_id, private_offering_id, class_offering_id],
  );

  // Operating hours: Mondays 9-17 EST.
  await privilegedPool.query(
    `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, 1, '09:00', '17:00')`,
    [tenant_id, resource_id],
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
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain = $1`,
      [TENANT],
    );
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
// ============================================================

function publicFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
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

function someCustomer() {
  return {
    first_name: 'Walk',
    last_name: 'In',
    email: `walk-${randomUUID()}@example.com`,
    phone: '+15555550101',
  };
}

function bookingBody(start_time, opts = {}) {
  return {
    offering_id: opts.offering_id ?? public_offering_id,
    resource_id,
    start_time,
    customer: opts.customer ?? someCustomer(),
    success_url: 'https://app.example/booked?session_id=x',
    cancel_url: 'https://app.example/?cancelled=1',
  };
}

// ============================================================
// gates
// ============================================================

test('public booking 404 for unknown offering', { skip }, async () => {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      bookingBody('2027-02-01T15:00:00.000Z', { offering_id: randomUUID() }),
    ),
  });
  assert.equal(res.status, 404);
});

test('public booking 403 if offering does not allow_public_booking', { skip }, async () => {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      bookingBody('2027-02-08T15:00:00.000Z', {
        offering_id: private_offering_id,
      }),
    ),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /public/i);
});

test('public booking 409 for class offering (capacity > 1)', { skip }, async () => {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      bookingBody('2027-02-15T15:00:00.000Z', {
        offering_id: class_offering_id,
      }),
    ),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /class/i);
});

test('public booking 409 outside operating hours', { skip }, async () => {
  // 7am EST = 12:00 UTC, before 9am open
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody('2027-03-01T12:00:00.000Z')),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /operating hours/i);
});

test('public booking 409 when slot already booked', { skip }, async () => {
  const slot = '2027-04-05T15:00:00.000Z';
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  assert.equal(r1.status, 201);

  const r2 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  assert.equal(r2.status, 409);
});

test('public booking 409 when tenant connection not charges-enabled', { skip }, async () => {
  // Spin up a separate tenant with no connection to test gate.
  const otherSubdomain = `verify-walkins-noconn-${randomUUID().slice(0, 6)}`;
  const otherTid = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'NoConn', 'UTC') RETURNING id`,
      [otherSubdomain],
    )
  ).rows[0].id;
  const otherResource = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'X') RETURNING id`,
      [otherTid],
    )
  ).rows[0].id;
  const otherOffering = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'X', 'cage-time', 60, 0, 1000, 1, true, true)
       RETURNING id`,
      [otherTid],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [otherTid, otherOffering, otherResource],
  );
  await privilegedPool.query(
    `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, 1, '00:00', '23:59:59')`,
    [otherTid, otherResource],
  );

  try {
    const res = await fetch(
      `${baseUrl}/api/customers/bookings?tenant=${otherSubdomain}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offering_id: otherOffering,
          resource_id: otherResource,
          start_time: '2027-05-03T12:00:00.000Z',
          customer: someCustomer(),
          success_url: 'https://app.example/ok',
          cancel_url: 'https://app.example/no',
        }),
      },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /card payments/i);
  } finally {
    await privilegedPool.query(`DELETE FROM tenants WHERE id = $1`, [otherTid]);
  }
});

// ============================================================
// happy path
// ============================================================

test('public booking 201 happy path: pending_payment row + Checkout URL with metadata', { skip }, async () => {
  const slot = '2027-06-07T15:00:00.000Z';
  const cust = someCustomer();
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot, { customer: cust })),
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  // Booking shape
  assert.ok(body.booking?.id);
  assert.equal(body.booking.status, 'pending_payment');
  assert.equal(body.booking.payment_status, 'pending');
  assert.equal(body.booking.amount_due_cents, DOLLAR_PRICE);
  assert.ok(body.booking.hold_expires_at);

  // Stripe URL + session id
  assert.match(body.checkout_url, /^https:\/\/stripe\.example\/checkout\//);
  assert.match(body.session_id, /^cs_test_/);

  // DB row matches
  const r = await privilegedPool.query(
    `SELECT customer_first_name, customer_last_name, customer_email,
            status, payment_status, amount_due_cents
       FROM bookings WHERE id = $1`,
    [body.booking.id],
  );
  assert.equal(r.rows[0].customer_first_name, cust.first_name);
  assert.equal(r.rows[0].customer_email, cust.email);
  assert.equal(r.rows[0].status, 'pending_payment');
  assert.equal(r.rows[0].amount_due_cents, DOLLAR_PRICE);
});

// ============================================================
// webhook: payment success flips booking
// ============================================================

test('webhook checkout.session.completed (payment) flips booking to confirmed + paid', { skip }, async () => {
  // Create a fresh booking
  const slot = '2027-06-14T15:00:00.000Z';
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  const created = await r1.json();
  const bookingId = created.booking.id;
  const sessionId = created.session_id;

  // Drive the fake to "complete" the session
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    sessionId,
  );

  // POST the webhook
  const event = {
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
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const r = await privilegedPool.query(
    `SELECT status, payment_status, amount_paid_cents, stripe_payment_intent_id
       FROM bookings WHERE id = $1`,
    [bookingId],
  );
  assert.equal(r.rows[0].status, 'confirmed');
  assert.equal(r.rows[0].payment_status, 'paid');
  assert.equal(r.rows[0].amount_paid_cents, DOLLAR_PRICE);
  assert.equal(r.rows[0].stripe_payment_intent_id, payment_intent);
});

test('webhook duplicate delivery is deduped (no double UPDATE)', { skip }, async () => {
  const slot = '2027-06-21T15:00:00.000Z';
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  const created = await r1.json();
  const sessionId = created.session_id;
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    sessionId,
  );

  const event = {
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
  };
  const r2a = await postWebhook(event);
  const body2a = await r2a.json();
  assert.ok(!body2a.deduped);

  const r2b = await postWebhook(event);
  const body2b = await r2b.json();
  assert.equal(body2b.deduped, true);
});

test('webhook does NOT re-confirm a booking that was cancelled in the meantime', { skip }, async () => {
  const slot = '2027-06-28T15:00:00.000Z';
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  const created = await r1.json();
  const bookingId = created.booking.id;
  const sessionId = created.session_id;
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    sessionId,
  );

  // Admin cancels the booking before webhook fires
  await privilegedPool.connect().then(async (c) => {
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
      await c.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [bookingId],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  const event = {
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
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  // Booking stays cancelled — handler's WHERE status = 'pending_payment'
  // gate is the safety.
  const r = await privilegedPool.query(
    `SELECT status, payment_status FROM bookings WHERE id = $1`,
    [bookingId],
  );
  assert.equal(r.rows[0].status, 'cancelled');
  // payment_status was 'pending' when row was cancelled (we cancel
  // without reconciling money fields here; this just verifies we
  // don't *flip* it to 'paid' on the late webhook).
  assert.notEqual(r.rows[0].payment_status, 'paid');
});
