// Catalog update + deactivate/reactivate tests — Tier-A
// sell-readiness slice.
//
// Covers the three PATCH endpoints:
//   * PATCH /api/admin/resources/:id
//   * PATCH /api/admin/offerings/:id  (incl. resource_ids reconcile)
//   * PATCH /api/admin/plans/:id      (incl. Stripe Price rotation)
//
// Deactivation semantics: hidden from member/public listings +
// availability; existing bookings keep their snapshotted cost;
// existing subscriptions keep their old Stripe Price.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-catalog-update';

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
let adminToken;
let memberToken;
let stripe_account_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Catalog Update Tests', 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

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

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) throw new Error(`admin login failed: HTTP ${loginRes.status}`);
  adminToken = (await loginRes.json()).token;

  const memberRes = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `member-${randomUUID()}@example.com`,
        password: 'correcthorsebatterystaple',
        first_name: 'Member',
        last_name: 'Tester',
      }),
    },
  );
  if (!memberRes.ok) throw new Error(`member register failed: HTTP ${memberRes.status}`);
  memberToken = (await memberRes.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM stripe_connections WHERE tenant_id = $1`,
      [tenant_id],
    );
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

function memberFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
      ...(init.headers ?? {}),
    },
  });
}

async function createResource(name = `Cage ${randomUUID().slice(0, 8)}`) {
  const r = await adminFetch('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (r.status !== 201) throw new Error(`createResource failed: HTTP ${r.status}`);
  return (await r.json()).resource;
}

async function createOffering(overrides = {}) {
  const r = await adminFetch('/api/admin/offerings', {
    method: 'POST',
    body: JSON.stringify({
      name: `Offering ${randomUUID().slice(0, 8)}`,
      category: 'cage-time',
      duration_minutes: 30,
      credit_cost: 3,
      dollar_price: 3000,
      allow_member_booking: true,
      allow_public_booking: true,
      ...overrides,
    }),
  });
  if (r.status !== 201) throw new Error(`createOffering failed: HTTP ${r.status}`);
  return (await r.json()).offering;
}

async function createPlan(overrides = {}) {
  const r = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: `Plan ${randomUUID().slice(0, 8)}`,
      monthly_price_cents: 26900,
      credits_per_week: 20,
      ...overrides,
    }),
  });
  if (r.status !== 201) throw new Error(`createPlan failed: HTTP ${r.status}`);
  return (await r.json()).plan;
}

async function linkOfferingResource(offeringId, resourceId) {
  const r = await adminFetch(`/api/admin/offerings/${offeringId}/resources`, {
    method: 'POST',
    body: JSON.stringify({ resource_id: resourceId }),
  });
  if (r.status !== 201) throw new Error(`link failed: HTTP ${r.status}`);
}

async function ensureChargesEnabledConnection() {
  stripeFake.__resetStripeFake();
  const accountId = `acct_test_${randomUUID().slice(0, 8)}`;
  stripeFake.__setAccountState(accountId, {
    id: accountId,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  await privilegedPool.query(
    `INSERT INTO stripe_connections (
       tenant_id, stripe_account_id,
       details_submitted, charges_enabled, payouts_enabled
     ) VALUES ($1, $2, true, true, true)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_account_id = EXCLUDED.stripe_account_id,
       details_submitted = true,
       charges_enabled    = true,
       payouts_enabled    = true`,
    [tenant_id, accountId],
  );
  stripe_account_id = accountId;
}

// Poll until fn() is truthy or ~2s elapse. Used for the post-commit
// (res 'finish') price archive, which fires after the response flushes.
async function eventually(fn, what) {
  for (let i = 0; i < 40; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ============================================================
// resources
// ============================================================

test('PATCH resource updates name + display_order', { skip }, async () => {
  const resource = await createResource();
  const newName = `Renamed ${randomUUID().slice(0, 8)}`;
  const res = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName, display_order: 7 }),
  });
  assert.equal(res.status, 200);
  const { resource: updated } = await res.json();
  assert.equal(updated.name, newName);
  assert.equal(updated.display_order, 7);
  assert.equal(updated.active, true, 'active untouched by a rename');
});

test('PATCH resource rename onto an existing name returns 409', { skip }, async () => {
  const taken = await createResource();
  const resource = await createResource();
  const res = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: taken.name }),
  });
  assert.equal(res.status, 409);
});

test('PATCH resource can deactivate and reactivate', { skip }, async () => {
  const resource = await createResource();

  const off = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).resource.active, false);

  const on = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: true }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).resource.active, true);
});

test('PATCH resource: unknown id 404, malformed id 404, empty body 400, blank name 400', { skip }, async () => {
  const unknown = await adminFetch(`/api/admin/resources/${randomUUID()}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'X' }),
  });
  assert.equal(unknown.status, 404);

  const malformed = await adminFetch('/api/admin/resources/not-a-uuid', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'X' }),
  });
  assert.equal(malformed.status, 404);

  const resource = await createResource();
  const empty = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  const blank = await adminFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(blank.status, 400);
});

test('member token cannot PATCH a resource (requireAdmin)', { skip }, async () => {
  const resource = await createResource();
  const res = await memberFetch(`/api/admin/resources/${resource.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Member Rename' }),
  });
  assert.equal(res.status, 403);
});

// ============================================================
// offerings
// ============================================================

test('PATCH offering updates pricing + duration fields', { skip }, async () => {
  const offering = await createOffering();
  const res = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      credit_cost: 5,
      dollar_price: 4500,
      duration_minutes: 45,
      name: `Updated ${randomUUID().slice(0, 8)}`,
      category: 'hittrax',
    }),
  });
  assert.equal(res.status, 200);
  const { offering: updated } = await res.json();
  assert.equal(updated.credit_cost, 5);
  assert.equal(updated.dollar_price, 4500);
  assert.equal(updated.duration_minutes, 45);
  assert.equal(updated.category, 'hittrax');
});

test('offering price change leaves an existing booking\'s snapshot untouched', { skip }, async () => {
  const offering = await createOffering({ dollar_price: 3000, credit_cost: 3 });
  const resource = await createResource();
  await linkOfferingResource(offering.id, resource.id);

  // Insert a confirmed customer booking directly with the snapshotted
  // at-booking-time price (what the booking flow writes).
  const b = await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id,
       customer_first_name, customer_last_name, customer_email,
       start_time, end_time, status, amount_due_cents, credit_cost_charged,
       amount_paid_cents, payment_status
     ) VALUES ($1, $2, $3, 'Walk', 'In', 'walkin@example.com',
               now() + interval '1 day', now() + interval '1 day 30 minutes',
               'confirmed', 3000, 0, 3000, 'paid')
     RETURNING id`,
    [tenant_id, offering.id, resource.id],
  );
  const bookingId = b.rows[0].id;

  const res = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ dollar_price: 9900, credit_cost: 9 }),
  });
  assert.equal(res.status, 200);

  const after = await privilegedPool.query(
    `SELECT amount_due_cents, credit_cost_charged FROM bookings WHERE id = $1`,
    [bookingId],
  );
  assert.equal(after.rows[0].amount_due_cents, 3000, 'booking keeps its snapshot');
  assert.equal(after.rows[0].credit_cost_charged, 0);
});

test('PATCH offering rejects an active offering with no booking audience', { skip }, async () => {
  const offering = await createOffering();
  const res = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      allow_member_booking: false,
      allow_public_booking: false,
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /at least one of member or public/i);
});

test('deactivated offering disappears from member + public listings and availability', { skip }, async () => {
  const offering = await createOffering();
  const resource = await createResource();
  await linkOfferingResource(offering.id, resource.id);

  const deact = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
  assert.equal(deact.status, 200);
  assert.equal((await deact.json()).offering.active, false);

  // Member listing (GET /api/bookings/offerings) excludes it.
  const memberList = await memberFetch('/api/bookings/offerings');
  assert.equal(memberList.status, 200);
  const { offerings: memberOfferings } = await memberList.json();
  assert.ok(
    !memberOfferings.some((o) => o.id === offering.id),
    'deactivated offering must not appear in member listing',
  );

  // Public walk-in listing excludes it.
  const publicList = await fetch(
    `${baseUrl}/api/customers/offerings?tenant=${TENANT}`,
  );
  assert.equal(publicList.status, 200);
  const { offerings: publicOfferings } = await publicList.json();
  assert.ok(
    !publicOfferings.some((o) => o.id === offering.id),
    'deactivated offering must not appear in public listing',
  );

  // Availability short-circuits with a reason.
  const avail = await fetch(
    `${baseUrl}/api/availability?tenant=${TENANT}&resource_id=${resource.id}&offering_id=${offering.id}&date=2026-08-01`,
  );
  assert.equal(avail.status, 200);
  const availBody = await avail.json();
  assert.deepEqual(availBody.slots, []);
  assert.equal(availBody.reason, 'offering inactive');

  // Reactivate → back in the member listing.
  const react = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: true }),
  });
  assert.equal(react.status, 200);
  const memberList2 = await memberFetch('/api/bookings/offerings');
  const { offerings: memberOfferings2 } = await memberList2.json();
  assert.ok(memberOfferings2.some((o) => o.id === offering.id));
});

test('PATCH offering resource_ids reconciles links (add, soft-remove, clear)', { skip }, async () => {
  const offering = await createOffering();
  const r1 = await createResource();
  const r2 = await createResource();
  await linkOfferingResource(offering.id, r1.id);

  // Swap r1 → r2.
  const swap = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resource_ids: [r2.id] }),
  });
  assert.equal(swap.status, 200);

  const list1 = await adminFetch(`/api/admin/offerings/${offering.id}/resources`);
  const { resources: links1 } = await list1.json();
  const l1 = links1.find((l) => l.resource_id === r1.id);
  const l2 = links1.find((l) => l.resource_id === r2.id);
  assert.equal(l1.link_active, false, 'r1 soft-unlinked (row kept for history)');
  assert.equal(l2.link_active, true, 'r2 linked');

  // Re-add r1 alongside r2 (reactivates the existing row).
  const both = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resource_ids: [r1.id, r2.id] }),
  });
  assert.equal(both.status, 200);
  const list2 = await adminFetch(`/api/admin/offerings/${offering.id}/resources`);
  const { resources: links2 } = await list2.json();
  assert.ok(links2.every((l) => l.link_active === true));

  // Clear all links.
  const clear = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resource_ids: [] }),
  });
  assert.equal(clear.status, 200);
  const list3 = await adminFetch(`/api/admin/offerings/${offering.id}/resources`);
  const { resources: links3 } = await list3.json();
  assert.ok(links3.every((l) => l.link_active === false));
});

test('PATCH offering resource_ids with an unknown resource returns 400', { skip }, async () => {
  const offering = await createOffering();
  const res = await adminFetch(`/api/admin/offerings/${offering.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resource_ids: [randomUUID()] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /resources not found/i);
});

// ============================================================
// plans — plain updates
// ============================================================

test('PATCH plan updates name, credits, description; allowed_categories set + clear', { skip }, async () => {
  const plan = await createPlan();
  const newName = `Pro Updated ${randomUUID().slice(0, 8)}`;

  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: newName,
      description: 'now with classes only',
      credits_per_week: 12,
      allowed_categories: ['classes'],
    }),
  });
  assert.equal(res.status, 200);
  const { plan: updated, stripe_price_rotated } = await res.json();
  assert.equal(updated.name, newName);
  assert.equal(updated.description, 'now with classes only');
  assert.equal(updated.credits_per_week, 12);
  assert.deepEqual(updated.allowed_categories, ['classes']);
  assert.equal(stripe_price_rotated, false);

  // null clears the whitelist back to "all categories".
  const clear = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ allowed_categories: null }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).plan.allowed_categories, null);
});

test('PATCH plan price change on an unsynced plan is a plain DB update', { skip }, async () => {
  const plan = await createPlan({ monthly_price_cents: 10000 });
  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ monthly_price_cents: 12000 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan.monthly_price_cents, 12000);
  assert.equal(body.plan.stripe_price_id, null);
  assert.equal(body.stripe_price_rotated, false);
});

test('PATCH plan rename onto an existing active plan name returns 409', { skip }, async () => {
  const taken = await createPlan();
  const plan = await createPlan();
  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: taken.name.toUpperCase() }),
  });
  assert.equal(res.status, 409);
});

test('PATCH plan: empty allowed_categories 400, empty body 400, unknown id 404', { skip }, async () => {
  const plan = await createPlan();

  const emptyCats = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ allowed_categories: [] }),
  });
  assert.equal(emptyCats.status, 400);

  const emptyBody = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assert.equal(emptyBody.status, 400);

  const unknown = await adminFetch(`/api/admin/plans/${randomUUID()}`, {
    method: 'PATCH',
    body: JSON.stringify({ credits_per_week: 1 }),
  });
  assert.equal(unknown.status, 404);
});

test('deactivated plan disappears from the member plans listing', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan();
  const sync = await adminFetch(`/api/admin/plans/${plan.id}/stripe-sync`, {
    method: 'POST',
  });
  assert.equal(sync.status, 200);

  const before = await memberFetch('/api/me/plans');
  const { plans: plansBefore } = await before.json();
  assert.ok(plansBefore.some((p) => p.id === plan.id), 'synced active plan listed');

  const deact = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
  assert.equal(deact.status, 200);
  assert.equal((await deact.json()).plan.active, false);

  const afterList = await memberFetch('/api/me/plans');
  const { plans: plansAfter } = await afterList.json();
  assert.ok(
    !plansAfter.some((p) => p.id === plan.id),
    'deactivated plan must not be purchasable',
  );
});

// ============================================================
// plans — Stripe Price rotation
// ============================================================

test('price change on a synced plan rotates the Stripe Price; old one is archived', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan({ monthly_price_cents: 26900 });
  const sync = await adminFetch(`/api/admin/plans/${plan.id}/stripe-sync`, {
    method: 'POST',
  });
  assert.equal(sync.status, 200);
  const oldPriceId = (await sync.json()).plan.stripe_price_id;

  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ monthly_price_cents: 29900 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stripe_price_rotated, true);
  assert.equal(body.previous_stripe_price_id, oldPriceId);
  assert.equal(body.plan.monthly_price_cents, 29900);
  assert.notEqual(body.plan.stripe_price_id, oldPriceId);

  // New Price: correct amount, same Product, recurring monthly.
  const oldPrice = stripeFake.__getPrice(stripe_account_id, oldPriceId);
  const newPrice = stripeFake.__getPrice(stripe_account_id, body.plan.stripe_price_id);
  assert.ok(newPrice, 'new price exists on the connected account');
  assert.equal(newPrice.unit_amount, 29900);
  assert.equal(newPrice.product, oldPrice.product, 'same Product, new Price');
  assert.deepEqual(newPrice.recurring, { interval: 'month' });
  assert.equal(newPrice.active, true);

  // Old Price is archived post-commit (res 'finish') — poll briefly.
  await eventually(
    () => stripeFake.__getPrice(stripe_account_id, oldPriceId).active === false,
    'old price to be archived',
  );

  // DB points at the new price.
  const dbRow = await privilegedPool.query(
    `SELECT stripe_price_id FROM plans WHERE id = $1`,
    [plan.id],
  );
  assert.equal(dbRow.rows[0].stripe_price_id, body.plan.stripe_price_id);
});

test('name change on a synced plan updates the Stripe Product, not the Price', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan();
  const sync = await adminFetch(`/api/admin/plans/${plan.id}/stripe-sync`, {
    method: 'POST',
  });
  assert.equal(sync.status, 200);
  const priceId = (await sync.json()).plan.stripe_price_id;

  const newName = `Rebranded ${randomUUID().slice(0, 8)}`;
  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan.name, newName);
  assert.equal(body.stripe_price_rotated, false);
  assert.equal(body.plan.stripe_price_id, priceId, 'price untouched by a rename');

  const price = stripeFake.__getPrice(stripe_account_id, priceId);
  const product = stripeFake.__getProduct(stripe_account_id, price.product);
  assert.equal(product.name, newName, 'Stripe Product renamed');
  assert.equal(price.active, true, 'price not archived by a rename');
});

test('re-pricing a synced plan to free returns 409', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan();
  const sync = await adminFetch(`/api/admin/plans/${plan.id}/stripe-sync`, {
    method: 'POST',
  });
  assert.equal(sync.status, 200);

  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ monthly_price_cents: 0 }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /cannot re-price/i);
});

test('same-price PATCH on a synced plan does not rotate the Price', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan({ monthly_price_cents: 5000 });
  const sync = await adminFetch(`/api/admin/plans/${plan.id}/stripe-sync`, {
    method: 'POST',
  });
  assert.equal(sync.status, 200);
  const priceId = (await sync.json()).plan.stripe_price_id;

  const res = await adminFetch(`/api/admin/plans/${plan.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ monthly_price_cents: 5000, credits_per_week: 8 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stripe_price_rotated, false);
  assert.equal(body.plan.stripe_price_id, priceId);
  assert.equal(body.plan.credits_per_week, 8);
  assert.equal(
    stripeFake.__getPricesForAccount(stripe_account_id).length,
    1,
    'no extra price created',
  );
});
