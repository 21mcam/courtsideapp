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

  // Permissive max_advance_booking_days so the 2027-dated fixture
  // slots aren't rejected by the advance-window gate (now enforced on
  // the public path too). Specific tests tighten it to assert the
  // gate works.
  await privilegedPool.query(
    `INSERT INTO booking_policies (tenant_id, max_advance_booking_days)
     VALUES ($1, 730)
     ON CONFLICT (tenant_id) DO UPDATE SET
       max_advance_booking_days = EXCLUDED.max_advance_booking_days`,
    [tenant_id],
  );

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
    full_name: 'Walk In',
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
// public offerings list
// ============================================================

test('GET /api/customers/offerings lists only public, priced rentals', { skip }, async () => {
  const res = await publicFetch('/api/customers/offerings');
  assert.equal(res.status, 200);
  const { offerings } = await res.json();
  const names = offerings.map((o) => o.name);
  assert.ok(names.includes('Public Cage 60min'));
  assert.ok(!names.includes('Members-only Cage'), 'private offering leaked');
  assert.ok(!names.includes('Classy'), 'class offering leaked');

  const pub = offerings.find((o) => o.name === 'Public Cage 60min');
  assert.equal(pub.dollar_price, DOLLAR_PRICE);
  assert.equal(pub.duration_minutes, DURATION_MIN);
  assert.ok(!('credit_cost' in pub), 'credit_cost must not be exposed publicly');
  assert.deepEqual(
    pub.resources.map((r) => r.name),
    ['Walk-in Cage'],
  );
});

test('GET /api/customers/offerings hides unpriced and inactive offerings', { skip }, async () => {
  const ids = {};
  for (const [key, name, price, active] of [
    ['free', 'Free Public Cage', 0, true],
    ['inactive', 'Retired Public Cage', 1000, false],
  ]) {
    ids[key] = (
      await privilegedPool.query(
        `INSERT INTO offerings
           (tenant_id, name, category, duration_minutes, credit_cost,
            dollar_price, capacity, allow_member_booking, allow_public_booking, active)
         VALUES ($1, $2, 'cage-time', 30, 1, $3, 1, true, true, $4)
         RETURNING id`,
        [tenant_id, name, price, active],
      )
    ).rows[0].id;
  }
  try {
    const res = await publicFetch('/api/customers/offerings');
    assert.equal(res.status, 200);
    const { offerings } = await res.json();
    const names = offerings.map((o) => o.name);
    assert.ok(!names.includes('Free Public Cage'), 'zero-price offering leaked');
    assert.ok(!names.includes('Retired Public Cage'), 'inactive offering leaked');
  } finally {
    await privilegedPool.query(
      `DELETE FROM offerings WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant_id, [ids.free, ids.inactive]],
    );
  }
});

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
  // Tagged so the no-preference UI may retry another resource.
  const body = await r2.json();
  assert.equal(body.code, 'slot_conflict');
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
  // Permissive advance window so the 2027 slot reaches the Stripe
  // connection gate (the thing under test) instead of 409ing earlier.
  await privilegedPool.query(
    `INSERT INTO booking_policies (tenant_id, max_advance_booking_days)
     VALUES ($1, 730)`,
    [otherTid],
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
    // Resource-INDEPENDENT: must NOT be tagged slot_conflict, or the
    // no-preference UI would mask it as "that time was just taken"
    // and retry-loop across resources forever.
    assert.equal(body.code, undefined);
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
  assert.equal(r.rows[0].customer_first_name, 'Walk');
  assert.equal(r.rows[0].customer_last_name, 'In');
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

test('webhook refunds (and does not re-confirm) a booking cancelled in the meantime', { skip }, async () => {
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
  // gate is the safety — and the payment is auto-refunded (the
  // customer paid for a slot we can't honor).
  const r = await privilegedPool.query(
    `SELECT status, payment_status, amount_paid_cents, amount_refunded_cents,
            stripe_payment_intent_id
       FROM bookings WHERE id = $1`,
    [bookingId],
  );
  assert.equal(r.rows[0].status, 'cancelled');
  assert.equal(r.rows[0].payment_status, 'refunded');
  assert.equal(r.rows[0].amount_paid_cents, DOLLAR_PRICE);
  assert.equal(r.rows[0].amount_refunded_cents, DOLLAR_PRICE);
  assert.equal(r.rows[0].stripe_payment_intent_id, payment_intent);

  // A refund was created on the connected account for this payment.
  const refunds = stripeFake
    .__getRefundsForAccount(stripe_account_id)
    .filter((rf) => rf.payment_intent === payment_intent);
  assert.equal(refunds.length, 1, 'exactly one refund for the payment');

  // Redelivery of the same event id is deduped and refunds nothing new.
  const res2 = await postWebhook(event);
  assert.equal((await res2.json()).deduped, true);
  assert.equal(
    stripeFake
      .__getRefundsForAccount(stripe_account_id)
      .filter((rf) => rf.payment_intent === payment_intent).length,
    1,
  );
});

test('walk-in Checkout session gets an expires_at aligned with the hold (>= Stripe 30min floor)', { skip }, async () => {
  const slot = '2027-07-05T15:00:00.000Z';
  const before_ = Math.floor(Date.now() / 1000);
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot)),
  });
  assert.equal(r1.status, 201);
  const created = await r1.json();

  const session = stripeFake.__getCheckoutSession(
    stripe_account_id,
    created.session_id,
  );
  assert.ok(session, 'session recorded on the fake');
  // Stripe's floor is 30min ahead; we send 31min to absorb clock skew.
  // The hold is min(now+30min, start_time); for this far-future slot
  // the session expiry is the 31min floor.
  assert.ok(
    session.expires_at >= before_ + 30 * 60,
    `expires_at ${session.expires_at} must be >= 30min out`,
  );
  assert.ok(
    session.expires_at <= before_ + 32 * 60,
    `expires_at ${session.expires_at} must not fall back to Stripe's 24h default`,
  );

  // DB hold ≈ 30 minutes out for a far-future slot.
  const hold = new Date(created.booking.hold_expires_at).getTime() / 1000;
  assert.ok(hold >= before_ + 29 * 60 && hold <= before_ + 31 * 60);
});

// ============================================================
// walk-in checkout v2: full_name / phone / note / hold_minutes
// ============================================================

test('full_name splits into first/last; single-token names duplicate', { skip }, async () => {
  const { splitFullName } = await import('../src/controllers/customerBookings.js');
  assert.deepEqual(splitFullName('Mia Lopez'), {
    first_name: 'Mia',
    last_name: 'Lopez',
  });
  assert.deepEqual(splitFullName('  Mary  Jo   van der Berg '), {
    first_name: 'Mary Jo van der',
    last_name: 'Berg',
  });
  // Single token satisfies both non-empty CHECKs by duplication.
  assert.deepEqual(splitFullName('Cher'), {
    first_name: 'Cher',
    last_name: 'Cher',
  });
});

test('multi-word full_name lands split in the DB', { skip }, async () => {
  const slot = '2027-06-28T15:00:00.000Z';
  const cust = { ...someCustomer(), full_name: 'Mary Jo Catcher' };
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody(slot, { customer: cust })),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const r = await privilegedPool.query(
    `SELECT customer_first_name, customer_last_name FROM bookings WHERE id = $1`,
    [body.booking.id],
  );
  assert.equal(r.rows[0].customer_first_name, 'Mary Jo');
  assert.equal(r.rows[0].customer_last_name, 'Catcher');
});

test('missing phone → 400 (phone is required for walk-ins)', { skip }, async () => {
  const cust = someCustomer();
  delete cust.phone;
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      bookingBody('2027-06-28T16:00:00.000Z', { customer: cust }),
    ),
  });
  assert.equal(res.status, 400);
});

test('customer note is persisted; blank note treated as absent', { skip }, async () => {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify({
      ...bookingBody('2027-06-28T17:00:00.000Z'),
      note: '  First time — my kid is 9.  ',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const r = await privilegedPool.query(
    `SELECT customer_note FROM bookings WHERE id = $1`,
    [body.booking.id],
  );
  assert.equal(r.rows[0].customer_note, 'First time — my kid is 9.');

  const res2 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify({
      ...bookingBody('2027-06-28T18:00:00.000Z'),
      note: '   ',
    }),
  });
  assert.equal(res2.status, 201);
  const body2 = await res2.json();
  const r2 = await privilegedPool.query(
    `SELECT customer_note FROM bookings WHERE id = $1`,
    [body2.booking.id],
  );
  assert.equal(r2.rows[0].customer_note, null);
});

test('201 response carries hold_minutes (UI copy source of truth)', { skip }, async () => {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody('2027-06-28T19:00:00.000Z')),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.hold_minutes, 30);
});

// ============================================================
// advance-window enforcement on the public path
// ============================================================

test('advance window enforced on public create (uncoded 409s)', { skip }, async () => {
  // Tighten: min 60 minutes, max 7 days.
  await privilegedPool.query(
    `UPDATE booking_policies
        SET min_advance_booking_minutes = 60, max_advance_booking_days = 7
      WHERE tenant_id = $1`,
    [tenant_id],
  );
  try {
    // Too soon: 30 minutes out (also inside operating hours? doesn't
    // matter — the advance gate rejects before the hours check).
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const r1 = await publicFetch('/api/customers/bookings', {
      method: 'POST',
      body: JSON.stringify(bookingBody(soon)),
    });
    assert.equal(r1.status, 409);
    const b1 = await r1.json();
    assert.match(b1.error, /at least 60 minutes/i);
    // NOT slot_conflict — hits every resource identically; the
    // no-preference retry loop must not spin on it.
    assert.equal(b1.code, undefined);

    // Too far: fixture slot is months out, max is 7 days.
    const r2 = await publicFetch('/api/customers/bookings', {
      method: 'POST',
      body: JSON.stringify(bookingBody('2027-07-05T15:00:00.000Z')),
    });
    assert.equal(r2.status, 409);
    const b2 = await r2.json();
    assert.match(b2.error, /more than 7 days/i);
    assert.equal(b2.code, undefined);
  } finally {
    await privilegedPool.query(
      `UPDATE booking_policies
          SET min_advance_booking_minutes = 0, max_advance_booking_days = 730
        WHERE tenant_id = $1`,
      [tenant_id],
    );
  }
});

// ============================================================
// one-price guarantee
// ============================================================

test('one price: Checkout charges exactly the listed dollar_price, no extra line items', { skip }, async () => {
  // The listed price, from the same public endpoint customers see.
  const listRes = await publicFetch('/api/customers/offerings');
  const { offerings } = await listRes.json();
  const listed = offerings.find((o) => o.id === public_offering_id);
  assert.ok(listed, 'public offering must be listed');

  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(bookingBody('2027-07-05T16:00:00.000Z')),
  });
  assert.equal(res.status, 201);
  const body = await res.json();

  const session = stripeFake.__getCheckoutSession(
    stripe_account_id,
    body.session_id,
  );
  assert.ok(session, 'session recorded on the fake');
  // Exactly one line item, quantity 1, unit_amount === the LISTED
  // price. If any later screen ever charges more than the service
  // list shows, this is the test that fails.
  assert.equal(session.line_items.length, 1);
  assert.equal(session.line_items[0].quantity, 1);
  assert.equal(session.line_items[0].price_data.unit_amount, listed.dollar_price);
  assert.equal(session.amount_total, listed.dollar_price);
  assert.equal(body.booking.amount_due_cents, listed.dollar_price);
  assert.equal(session.discounts ?? undefined, undefined);
});

// ============================================================
// manage token minting (webhook) + confirmation email link
// ============================================================

test('webhook mints manage token: hash stored, raw token only in the email link', { skip }, async () => {
  const { createHash } = await import('node:crypto');
  const emailSvc = await import('../src/services/email.js');
  emailSvc.__clearSkippedEmails();

  const cust = someCustomer();
  const r1 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      bookingBody('2027-07-05T17:00:00.000Z', { customer: cust }),
    ),
  });
  assert.equal(r1.status, 201);
  const created = await r1.json();
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    created.session_id,
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
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const r = await privilegedPool.query(
    `SELECT manage_token_hash FROM bookings WHERE id = $1`,
    [created.booking.id],
  );
  const storedHash = r.rows[0].manage_token_hash;
  assert.match(storedHash, /^[0-9a-f]{64}$/);

  // The confirmation email (queued keyless → skipped log) carries the
  // manage URL; its raw token must hash to exactly the stored value.
  const mail = emailSvc
    .__getSkippedEmails()
    .find((e) => e.to === cust.email && /confirmed/i.test(e.subject));
  assert.ok(mail, 'confirmation email queued');
  const m = mail.text.match(/\/walk-in\/manage\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'manage URL present in email text');
  const rawToken = decodeURIComponent(m[1]);
  assert.equal(
    createHash('sha256').update(rawToken).digest('hex'),
    storedHash,
  );
});
