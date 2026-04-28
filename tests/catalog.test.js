// Catalog CRUD tests — Phase 2, slice 2.
//
// Six tests covering resource + offering + offering_resources surface:
//   1. Create resource → 201, list shows it
//   2. Create offering with proper fields → 201, list shows it
//   3. Link resource to offering → 201; offering's resources list
//      includes the linked one
//   4. Duplicate resource name → 409
//   5. Member token rejected on POST /resources → 403 (admin-gating)
//   6. Linking a non-existent resource → 400 (FK violation translated)
//
// Self-contained: own tenant + admin owner via privileged pool, own
// member via API for the gating test, full teardown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-catalog';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let adminToken;
let memberToken;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Catalog Tests', 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT],
  );
  const t = await privilegedPool.query(
    `SELECT id FROM tenants WHERE subdomain = $1`,
    [TENANT],
  );
  const tenant_id = t.rows[0].id;

  // Admin owner via privileged pool (no member row)
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

  // Login as admin
  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) {
    throw new Error(`admin login failed: HTTP ${loginRes.status}`);
  }
  adminToken = (await loginRes.json()).token;

  // Register a regular member for the admin-gating test
  const memberEmail = `member-${randomUUID()}@example.com`;
  const memberPassword = 'correcthorsebatterystaple';
  const memberRes = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: memberEmail,
        password: memberPassword,
        first_name: 'Member',
        last_name: 'Tester',
      }),
    },
  );
  if (!memberRes.ok) {
    throw new Error(`member register failed: HTTP ${memberRes.status}`);
  }
  memberToken = (await memberRes.json()).token;
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
  return fetch(`${baseUrl}${path}?tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {}),
    },
  });
}

test('admin can create a resource and the list reflects it', { skip }, async () => {
  const name = `Cage ${randomUUID().slice(0, 8)}`;
  const createRes = await adminFetch('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  assert.equal(createRes.status, 201);
  const { resource } = await createRes.json();
  assert.equal(resource.name, name);
  assert.equal(resource.active, true);

  const listRes = await adminFetch('/api/admin/resources');
  assert.equal(listRes.status, 200);
  const { resources } = await listRes.json();
  assert.ok(resources.some((r) => r.id === resource.id));
});

test('admin can create an offering with proper fields', { skip }, async () => {
  const createRes = await adminFetch('/api/admin/offerings', {
    method: 'POST',
    body: JSON.stringify({
      name: `30-min cage ${randomUUID().slice(0, 8)}`,
      category: 'cage-time',
      duration_minutes: 30,
      credit_cost: 3,
      dollar_price: 3000, // cents
      allow_member_booking: true,
      allow_public_booking: true,
    }),
  });
  assert.equal(createRes.status, 201);
  const { offering } = await createRes.json();
  assert.equal(offering.duration_minutes, 30);
  assert.equal(offering.credit_cost, 3);
  assert.equal(offering.dollar_price, 3000);
  assert.equal(offering.capacity, 1, 'capacity defaults to 1 (rental)');
  assert.equal(offering.active, true);

  const listRes = await adminFetch('/api/admin/offerings');
  const { offerings } = await listRes.json();
  assert.ok(offerings.some((o) => o.id === offering.id));
});

test('admin can link a resource to an offering; list reflects it', { skip }, async () => {
  // Create a fresh offering and resource for this test (avoids
  // depending on prior tests' state).
  const offeringRes = await adminFetch('/api/admin/offerings', {
    method: 'POST',
    body: JSON.stringify({
      name: `Linkable Offering ${randomUUID().slice(0, 8)}`,
      category: 'cage-time',
      duration_minutes: 60,
      credit_cost: 6,
      dollar_price: 6000,
      allow_member_booking: true,
    }),
  });
  const { offering } = await offeringRes.json();

  const resourceRes = await adminFetch('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify({ name: `Linkable Resource ${randomUUID().slice(0, 8)}` }),
  });
  const { resource } = await resourceRes.json();

  const linkRes = await adminFetch(
    `/api/admin/offerings/${offering.id}/resources`,
    {
      method: 'POST',
      body: JSON.stringify({ resource_id: resource.id }),
    },
  );
  assert.equal(linkRes.status, 201);

  const listRes = await adminFetch(
    `/api/admin/offerings/${offering.id}/resources`,
  );
  assert.equal(listRes.status, 200);
  const { resources } = await listRes.json();
  assert.ok(
    resources.some((r) => r.resource_id === resource.id),
    'linked resource should appear in offering resources list',
  );
  // Also assert join shape: resource_name comes from resources table
  const found = resources.find((r) => r.resource_id === resource.id);
  assert.ok(found.resource_name);
});

test('duplicate resource name returns 409', { skip }, async () => {
  const name = `Dupe ${randomUUID().slice(0, 8)}`;
  const first = await adminFetch('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  assert.equal(first.status, 201);

  const dupe = await adminFetch('/api/admin/resources', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  assert.equal(dupe.status, 409);
});

test('member token cannot POST /resources (requireAdmin)', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/resources?tenant=${TENANT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({ name: `Member Try ${randomUUID().slice(0, 8)}` }),
  });
  assert.equal(res.status, 403, 'requireAdmin must reject member tokens');
});

// ============================================================
// plans (slice 3)
// ============================================================

test('admin can create a plan with monthly price + weekly credits', { skip }, async () => {
  const createRes = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: `Pro ${randomUUID().slice(0, 8)}`,
      description: 'All categories, 20 credits/week',
      monthly_price_cents: 26900,
      credits_per_week: 20,
    }),
  });
  assert.equal(createRes.status, 201);
  const { plan } = await createRes.json();
  assert.equal(plan.monthly_price_cents, 26900);
  assert.equal(plan.credits_per_week, 20);
  assert.equal(plan.allowed_categories, null, 'null = all categories allowed');
  assert.equal(plan.active, true);

  const listRes = await adminFetch('/api/admin/plans');
  const { plans } = await listRes.json();
  assert.ok(plans.some((p) => p.id === plan.id));
});

test('plan with allowed_categories whitelist is accepted', { skip }, async () => {
  const createRes = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: `Class Pack ${randomUUID().slice(0, 8)}`,
      monthly_price_cents: 9900,
      credits_per_week: 4,
      allowed_categories: ['classes'],
    }),
  });
  assert.equal(createRes.status, 201);
  const { plan } = await createRes.json();
  assert.deepEqual(plan.allowed_categories, ['classes']);
});

test('plan with empty allowed_categories array rejected (zod 400)', { skip }, async () => {
  const createRes = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: `Empty ${randomUUID().slice(0, 8)}`,
      monthly_price_cents: 1000,
      credits_per_week: 1,
      allowed_categories: [],
    }),
  });
  assert.equal(createRes.status, 400);
});

test('duplicate active plan name returns 409 (case-insensitive)', { skip }, async () => {
  const name = `Dupe Plan ${randomUUID().slice(0, 8)}`;
  const first = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name,
      monthly_price_cents: 1000,
      credits_per_week: 1,
    }),
  });
  assert.equal(first.status, 201);

  const dupe = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: name.toUpperCase(), // partial unique index uses lower(name)
      monthly_price_cents: 2000,
      credits_per_week: 5,
    }),
  });
  assert.equal(dupe.status, 409);
});

// ============================================================

test('linking a non-existent resource returns 400 (FK violation translated)', { skip }, async () => {
  const offeringRes = await adminFetch('/api/admin/offerings', {
    method: 'POST',
    body: JSON.stringify({
      name: `FK Offering ${randomUUID().slice(0, 8)}`,
      category: 'cage-time',
      duration_minutes: 30,
      credit_cost: 1,
      dollar_price: 1000,
      allow_member_booking: true,
    }),
  });
  const { offering } = await offeringRes.json();

  const linkRes = await adminFetch(
    `/api/admin/offerings/${offering.id}/resources`,
    {
      method: 'POST',
      // Random UUID — guaranteed not to exist as a resource in this tenant.
      body: JSON.stringify({ resource_id: randomUUID() }),
    },
  );
  assert.equal(linkRes.status, 400, 'composite FK violation should return 400');
});
