// Stripe plan→price sync tests — Phase 5 slice 3.
//
// Each tenant runs Connect Standard, so plan Products + Prices live
// on the tenant's connected account, not the platform's. The fake
// enforces that controller calls pass `{ stripeAccount }` and stores
// products/prices keyed by account so tests can verify per-account
// scoping.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-plan-sync';
const TZ = 'UTC';

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
let stripe_account_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Plan Sync Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
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
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
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

async function createPlan(name, monthly_price_cents = 26900) {
  const r = await adminFetch('/api/admin/plans', {
    method: 'POST',
    body: JSON.stringify({
      name,
      monthly_price_cents,
      credits_per_week: 20,
    }),
  });
  if (!r.ok) throw new Error(`createPlan failed: HTTP ${r.status}`);
  return (await r.json()).plan;
}

async function ensureChargesEnabledConnection() {
  // Reset the fake's accounts and seed an "fully onboarded" connection
  // so plan-sync calls succeed.
  stripeFake.__resetStripeFake();
  // Prime an account in the fake (mirrors what onboarding would have
  // created) and sync our DB to match.
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

// ============================================================
// gates
// ============================================================

test('sync without a stripe_connections row returns 409', { skip }, async () => {
  await privilegedPool.query(
    `DELETE FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  const plan = await createPlan(`No Conn Plan ${randomUUID().slice(0, 6)}`);
  try {
    const res = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /not connected a Stripe account/i);
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

test('sync with not-yet-charges-enabled connection returns 409', { skip }, async () => {
  await privilegedPool.query(
    `DELETE FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  await privilegedPool.query(
    `INSERT INTO stripe_connections (
       tenant_id, stripe_account_id,
       details_submitted, charges_enabled, payouts_enabled
     ) VALUES ($1, $2, false, false, false)`,
    [tenant_id, `acct_test_pending_${randomUUID().slice(0, 6)}`],
  );
  const plan = await createPlan(`Pending Plan ${randomUUID().slice(0, 6)}`);
  try {
    const res = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /not yet charges-enabled/i);
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

test('sync free plan (price 0) returns 409', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan(`Free Plan ${randomUUID().slice(0, 6)}`, 0);
  try {
    const res = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /free plan/i);
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

test('sync inactive plan returns 409', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan(`Inactive Plan ${randomUUID().slice(0, 6)}`);
  await privilegedPool.query(
    `UPDATE plans SET active = false WHERE id = $1`,
    [plan.id],
  );
  try {
    const res = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /inactive plan/i);
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

// ============================================================
// happy path
// ============================================================

test('happy path: sync creates Product + Price on the tenant\'s account; price_id stored', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan(`Pro ${randomUUID().slice(0, 6)}`);
  try {
    const res = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.synced, true);
    assert.match(body.plan.stripe_price_id, /^price_test_/);

    // DB has the price_id
    const r = await privilegedPool.query(
      `SELECT stripe_price_id FROM plans WHERE id = $1`,
      [plan.id],
    );
    assert.equal(r.rows[0].stripe_price_id, body.plan.stripe_price_id);

    // The fake recorded the Product + Price under the *connected*
    // account, not the platform.
    const products = stripeFake.__getProductsForAccount(stripe_account_id);
    assert.equal(products.length, 1);
    assert.equal(products[0].name, plan.name);
    assert.equal(products[0].metadata.courtside_plan_id, plan.id);
    assert.equal(products[0].metadata.courtside_tenant_id, tenant_id);

    const prices = stripeFake.__getPricesForAccount(stripe_account_id);
    assert.equal(prices.length, 1);
    assert.equal(prices[0].unit_amount, 26900);
    assert.equal(prices[0].currency, 'usd');
    assert.deepEqual(prices[0].recurring, { interval: 'month' });
    assert.equal(prices[0].product, products[0].id);
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

test('idempotent: second sync on same plan is a no-op', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const plan = await createPlan(`Idempotent Plan ${randomUUID().slice(0, 6)}`);
  try {
    const r1 = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    const body1 = await r1.json();
    assert.equal(body1.synced, true);
    const firstPriceId = body1.plan.stripe_price_id;

    const r2 = await adminFetch(
      `/api/admin/plans/${plan.id}/stripe-sync`,
      { method: 'POST' },
    );
    assert.equal(r2.status, 200);
    const body2 = await r2.json();
    assert.equal(body2.synced, false);
    assert.match(body2.reason ?? '', /already synced/i);
    assert.equal(body2.plan.stripe_price_id, firstPriceId);

    // No additional Product/Price should have been created.
    assert.equal(
      stripeFake.__getProductsForAccount(stripe_account_id).length,
      1,
    );
    assert.equal(
      stripeFake.__getPricesForAccount(stripe_account_id).length,
      1,
    );
  } finally {
    await privilegedPool.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
  }
});

test('unknown plan id returns 404', { skip }, async () => {
  await ensureChargesEnabledConnection();
  const res = await adminFetch(
    `/api/admin/plans/${randomUUID()}/stripe-sync`,
    { method: 'POST' },
  );
  assert.equal(res.status, 404);
});
