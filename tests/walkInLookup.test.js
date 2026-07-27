// Demo-hygiene slice: walk-in booking lookup for the success page.
//
// Covers POST /api/customers/bookings/lookup (public, no auth):
//   * 200 with reference + slot details when booking_id AND the
//     booking's email are both supplied
//   * email match is case-insensitive (stored lowercase)
//   * 404 for a wrong email (same shape as unknown id — the endpoint
//     can't be used to enumerate bookings or confirm emails)
//   * 404 for unknown and malformed booking ids
//   * 400 for a missing/invalid email
// Plus: createCustomerBooking appends booking_id to the Checkout
// success_url so the success page can find the booking on return.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';

const TENANT = 'verify-walkin-lookup';
const TZ = 'America/New_York';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';

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
let offering_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Walk-in Lookup Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Permissive max_advance_booking_days so 2027-dated fixture slots
  // pass the advance-window gate (now enforced on the public path).
  await privilegedPool.query(
    `INSERT INTO booking_policies (tenant_id, max_advance_booking_days)
     VALUES ($1, 730)
     ON CONFLICT (tenant_id) DO UPDATE SET
       max_advance_booking_days = EXCLUDED.max_advance_booking_days`,
    [tenant_id],
  );

  // Charges-enabled Stripe connection so walk-in creates succeed.
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

  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Lookup Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Lookup Cage 60min', 'cage-time', 60, 3, 4500, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offering_id, resource_id],
  );

  // Operating hours: Mondays 9-17 tenant-local.
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
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

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

// Create a walk-in booking at the given Monday slot. Each test uses a
// distinct slot so the GiST exclusion never collides.
async function createBooking(start_time, email) {
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time,
      customer: {
        full_name: 'Look Up',
        email,
        phone: '+15555550142',
      },
      success_url: 'https://app.example/walk-in/success',
      cancel_url: 'https://app.example/walk-in?cancelled=1',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    throw new Error(`booking create failed: ${res.status} ${body.error}`);
  }
  return body;
}

function lookup(booking_id, email) {
  return publicFetch('/api/customers/bookings/lookup', {
    method: 'POST',
    body: JSON.stringify({ booking_id, email }),
  });
}

// ============================================================
// happy path + reference
// ============================================================

test('lookup returns reference + slot details for matching id + email', { skip }, async () => {
  const email = `lookup-${randomUUID()}@example.com`;
  // 2027-04-05 is a Monday; 15:00 UTC = 11:00 EDT (inside 9-17).
  const created = await createBooking('2027-04-05T15:00:00.000Z', email);

  const res = await lookup(created.booking.id, email);
  assert.equal(res.status, 200);
  const { booking } = await res.json();

  assert.equal(booking.id, created.booking.id);
  assert.equal(
    booking.reference,
    created.booking.id.slice(0, 8).toUpperCase(),
  );
  assert.equal(booking.offering_name, 'Lookup Cage 60min');
  assert.equal(booking.resource_name, 'Lookup Cage');
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.amount_due_cents, 4500);
  assert.equal(
    new Date(booking.start_time).toISOString(),
    '2027-04-05T15:00:00.000Z',
  );
});

test('lookup email match is case-insensitive', { skip }, async () => {
  const email = `case-${randomUUID()}@example.com`;
  const created = await createBooking('2027-04-12T15:00:00.000Z', email);

  const res = await lookup(created.booking.id, email.toUpperCase());
  assert.equal(res.status, 200);
  const { booking } = await res.json();
  assert.equal(booking.id, created.booking.id);
});

// ============================================================
// enumeration resistance
// ============================================================

test('lookup with the wrong email 404s (no enumeration)', { skip }, async () => {
  const email = `owner-${randomUUID()}@example.com`;
  const created = await createBooking('2027-04-19T15:00:00.000Z', email);

  const res = await lookup(created.booking.id, `wrong-${randomUUID()}@example.com`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'booking not found');
});

test('lookup with unknown and malformed booking ids 404s identically', { skip }, async () => {
  const unknown = await lookup(randomUUID(), 'anyone@example.com');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'booking not found');

  const malformed = await lookup('not-a-uuid', 'anyone@example.com');
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json()).error, 'booking not found');
});

test('lookup with a missing or invalid email 400s', { skip }, async () => {
  const missing = await publicFetch('/api/customers/bookings/lookup', {
    method: 'POST',
    body: JSON.stringify({ booking_id: randomUUID() }),
  });
  assert.equal(missing.status, 400);

  const invalid = await lookup(randomUUID(), 'not-an-email');
  assert.equal(invalid.status, 400);
});

// ============================================================
// success_url carries the booking id
// ============================================================

test('checkout success_url gets booking_id appended', { skip }, async () => {
  const email = `surl-${randomUUID()}@example.com`;
  const created = await createBooking('2027-04-26T15:00:00.000Z', email);

  // The fake stores the session as created; completing it hands the
  // row back so we can inspect what the server passed to Stripe.
  const { session } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    created.session_id,
  );
  const url = new URL(session.success_url);
  assert.equal(url.searchParams.get('booking_id'), created.booking.id);
  assert.equal(url.origin + url.pathname, 'https://app.example/walk-in/success');
});
