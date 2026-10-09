// Walk-in CLASS booking (customer-side slice 4).
//
//   GET  /api/customers/classes         public schedule + spots left
//   POST /api/customers/class-bookings  hold → Stripe Checkout
//   webhook checkout.session.completed (courtside_type=class_booking)
//   cleanup: expired class holds released
//   POST /api/customers/bookings/lookup finds class spots too

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import Stripe from 'stripe';

const WEBHOOK_SECRET = 'whsec_test_walkin_classes';
process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');
const { runCleanupSweep } = await import('../src/controllers/cleanup.js');

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';

const SUB = `wic-${randomUUID().slice(0, 8)}`;
const PRICE = 2500; // $25.00
const DAY = 86400000;

let server;
let baseUrl;
let priv;
let tenantId;
let acct;
let resourceId;
const offerings = {};
const inst = {};
const eventIds = [];

async function makeInstance(offeringId, daysAhead, hour, capacity, extra = {}) {
  const start = new Date(Date.now() + daysAhead * DAY);
  start.setUTCHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60000);
  const r = await priv.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id, start_time, end_time, capacity, cancelled_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7) RETURNING id, start_time`,
    [tenantId, offeringId, resourceId, start, end, capacity, extra.cancelled ? new Date() : null],
  );
  return r.rows[0];
}

function pub(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${SUB}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function bookBody(classInstanceId, email = `w-${randomUUID()}@example.com`) {
  return {
    class_instance_id: classInstanceId,
    customer: { full_name: 'Casey Walker', phone: '+15555550123', email },
    success_url: 'https://example.com/walk-in/success',
    cancel_url: 'https://example.com/walk-in/classes',
  };
}

async function book(classInstanceId, email) {
  return pub('/api/customers/class-bookings', {
    method: 'POST',
    body: JSON.stringify(bookBody(classInstanceId, email)),
  });
}

async function postWebhook(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

function completedEvent(sessionId) {
  const { session, payment_intent } = stripeFake.__completeCheckoutSession(acct, sessionId);
  const id = `evt_${randomUUID()}`;
  eventIds.push(id);
  return {
    event: {
      id,
      type: 'checkout.session.completed',
      account: acct,
      data: {
        object: {
          id: session.id,
          mode: 'payment',
          status: 'complete',
          amount_total: PRICE,
          payment_intent,
          metadata: session.metadata,
        },
      },
    },
    payment_intent,
  };
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Class Walk-ins', 'America/New_York') RETURNING id`,
      [SUB],
    )
  ).rows[0].id;

  stripeFake.__resetStripeFake();
  acct = `acct_test_${randomUUID().slice(0, 8)}`;
  stripeFake.__setAccountState(acct, { id: acct, details_submitted: true, charges_enabled: true, payouts_enabled: true });
  await priv.query(
    `INSERT INTO stripe_connections (tenant_id, stripe_account_id, details_submitted, charges_enabled, payouts_enabled)
     VALUES ($1, $2, true, true, true)`,
    [tenantId, acct],
  );

  resourceId = (
    await priv.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Clinic Field') RETURNING id`, [tenantId])
  ).rows[0].id;

  const offering = async (key, name, { publicOk = true, price = PRICE, capacity = 10 } = {}) => {
    offerings[key] = (
      await priv.query(
        `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost,
                                dollar_price, capacity, allow_member_booking, allow_public_booking)
         VALUES ($1, $2, 'classes', 60, 2, $3, $4, true, $5) RETURNING id`,
        [tenantId, name, price, capacity, publicOk],
      )
    ).rows[0].id;
    await priv.query(
      `INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`,
      [tenantId, offerings[key], resourceId],
    );
  };
  await offering('clinic', 'Hitting Clinic');
  await offering('membersOnly', 'Members Clinic', { publicOk: false });
  await offering('free', 'Free Intro', { price: 0 });

  inst.open = await makeInstance(offerings.clinic, 2, 14, 10);
  inst.small = await makeInstance(offerings.clinic, 3, 14, 2);
  inst.dup = await makeInstance(offerings.clinic, 4, 14, 10);
  inst.webhook = await makeInstance(offerings.clinic, 5, 14, 10);
  inst.lapsed = await makeInstance(offerings.clinic, 6, 14, 10);
  inst.membersOnly = await makeInstance(offerings.membersOnly, 2, 17, 10);
  inst.free = await makeInstance(offerings.free, 2, 19, 10);
  inst.cancelled = await makeInstance(offerings.clinic, 7, 14, 10, { cancelled: true });
  inst.tooFar = await makeInstance(offerings.clinic, 60, 14, 10); // default window 30 days

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM stripe_webhook_events WHERE event_id = ANY($1::text[])', [eventIds]);
  await priv.query('DELETE FROM class_bookings WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM class_instances WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('schedule lists only bookable public classes, with spots left, no roster', { skip }, async () => {
  const res = await pub('/api/customers/classes');
  assert.equal(res.status, 200);
  const { classes, policy } = await res.json();
  const ids = classes.map((c) => c.id);
  assert.ok(ids.includes(inst.open.id));
  for (const hidden of ['membersOnly', 'free', 'cancelled', 'tooFar']) {
    assert.ok(!ids.includes(inst[hidden].id), `${hidden} must not be listed`);
  }
  const open = classes.find((c) => c.id === inst.open.id);
  assert.equal(open.offering_name, 'Hitting Clinic');
  assert.equal(open.dollar_price, PRICE);
  assert.equal(open.spots_remaining, 10);
  assert.equal(policy.hold_minutes, 30);
  assert.ok(!('customer_email' in open));
});

test('booking holds a spot and opens a one-price Checkout', { skip }, async () => {
  const res = await book(inst.open.id);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.booking.status, 'pending_payment');
  assert.equal(body.booking.amount_due_cents, PRICE);
  assert.ok(new Date(body.booking.hold_expires_at) <= new Date(inst.open.start_time));
  assert.ok(body.checkout_url);

  const session = stripeFake.__getCheckoutSession(acct, body.session_id);
  assert.equal(session.line_items.length, 1, 'one line item, no fees');
  assert.equal(session.line_items[0].price_data.unit_amount, PRICE);
  assert.equal(session.metadata.courtside_type, 'class_booking');
  assert.equal(session.metadata.courtside_class_booking_id, body.booking.id);
  assert.match(session.success_url, new RegExp(`booking_id=${body.booking.id}`));

  const list = await (await pub('/api/customers/classes')).json();
  assert.equal(list.classes.find((c) => c.id === inst.open.id).spots_remaining, 9);
});

test('capacity: the spot after the last one gets class_full', { skip }, async () => {
  assert.equal((await book(inst.small.id)).status, 201);
  assert.equal((await book(inst.small.id)).status, 201);
  const full = await book(inst.small.id);
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'class_full');
});

test('one spot per email per class; other gates', { skip }, async () => {
  const email = `dup-${randomUUID()}@example.com`;
  assert.equal((await book(inst.dup.id, email)).status, 201);
  const again = await book(inst.dup.id, email.toUpperCase());
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'already_booked');

  assert.equal((await book(inst.membersOnly.id)).status, 403);
  assert.equal((await book(inst.cancelled.id)).status, 409);
  assert.equal((await book(inst.free.id)).status, 409);
  assert.equal((await book(inst.tooFar.id)).status, 409);
  assert.equal((await book(randomUUID())).status, 404);
});

test('webhook confirms the spot; success-page lookup finds it by id + email', { skip }, async () => {
  const email = `paid-${randomUUID()}@example.com`;
  const created = await (await book(inst.webhook.id, email)).json();
  const { event, payment_intent } = completedEvent(created.session_id);
  assert.equal((await postWebhook(event)).status, 200);

  const row = (
    await priv.query(
      `SELECT status, payment_status, amount_paid_cents, stripe_payment_intent_id
         FROM class_bookings WHERE id = $1`,
      [created.booking.id],
    )
  ).rows[0];
  assert.deepEqual(row, {
    status: 'confirmed',
    payment_status: 'paid',
    amount_paid_cents: PRICE,
    stripe_payment_intent_id: payment_intent,
  });

  const look = await pub('/api/customers/bookings/lookup', {
    method: 'POST',
    body: JSON.stringify({ booking_id: created.booking.id, email }),
  });
  assert.equal(look.status, 200);
  const { booking } = await look.json();
  assert.equal(booking.kind, 'class');
  assert.equal(booking.offering_name, 'Hitting Clinic');
  assert.equal(booking.status, 'confirmed');

  const wrong = await pub('/api/customers/bookings/lookup', {
    method: 'POST',
    body: JSON.stringify({ booking_id: created.booking.id, email: 'someone-else@example.com' }),
  });
  assert.equal(wrong.status, 404);
});

test('lapsed hold: janitor releases the spot; a late payment is refunded', { skip }, async () => {
  const created = await (await book(inst.lapsed.id)).json();
  await priv.query(
    `UPDATE class_bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [created.booking.id],
  );
  const [sweep] = await runCleanupSweep({ tenantId });
  assert.equal(sweep.class_bookings_cancelled, 1);

  const { event, payment_intent } = completedEvent(created.session_id);
  assert.equal((await postWebhook(event)).status, 200);

  const row = (
    await priv.query(
      `SELECT status, payment_status, amount_paid_cents, amount_refunded_cents
         FROM class_bookings WHERE id = $1`,
      [created.booking.id],
    )
  ).rows[0];
  assert.deepEqual(row, {
    status: 'cancelled',
    payment_status: 'refunded',
    amount_paid_cents: PRICE,
    amount_refunded_cents: PRICE,
  });
  assert.ok(
    stripeFake.__getRefundsForAccount(acct).some((r) => r.payment_intent === payment_intent),
    'refund issued on the connected account',
  );
  const list = await (await pub('/api/customers/classes')).json();
  assert.equal(list.classes.find((c) => c.id === inst.lapsed.id).spots_remaining, 10);
});
