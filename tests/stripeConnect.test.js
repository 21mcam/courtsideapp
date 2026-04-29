// Stripe Connect onboarding tests — Phase 5 slice 1.
//
// Runs in STRIPE_TEST_MODE=1, which swaps the real Stripe client for
// an in-memory fake. The fake doesn't hit the network; it stores
// account state in a Map and resolves immediately. Tests can drive
// state transitions via __setAccountState (e.g. simulate a tenant
// completing onboarding by flipping details_submitted).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

// Force test mode BEFORE importing the app. The service caches the
// real Stripe client lazily; setting this here means the cache never
// fires — getStripe() returns the fake every call.
process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';

const { app } = await import('../src/app.js');
const { __resetStripeFake, __setAccountState } = await import('../src/services/stripe.js');

const TENANT = 'verify-stripe-onboarding';
const TZ = 'America/New_York';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Stripe Tests', $2)
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

// ============================================================
// onboarding
// ============================================================

test('first onboarding call creates a Stripe account + DB row + returns hosted URL', { skip }, async () => {
  __resetStripeFake();
  // Clean any previous row from a flaky test run
  await privilegedPool.query(
    `DELETE FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );

  const res = await adminFetch('/api/admin/stripe/onboarding', {
    method: 'POST',
    body: JSON.stringify({
      return_url: 'https://app.example/admin/stripe?onboarded=1',
      refresh_url: 'https://app.example/admin/stripe',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.stripe_account_id, /^acct_test_/);
  assert.match(body.onboarding_url, /^https:\/\/stripe\.example\/onboard\//);
  assert.ok(body.expires_at > Math.floor(Date.now() / 1000));

  // DB has the row now, with all flags false (account.created hasn't
  // had submit yet).
  const r = await privilegedPool.query(
    `SELECT stripe_account_id, details_submitted, charges_enabled, payouts_enabled
       FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].stripe_account_id, body.stripe_account_id);
  assert.equal(r.rows[0].details_submitted, false);
  assert.equal(r.rows[0].charges_enabled, false);
});

test('subsequent onboarding call reuses existing account; only mints a fresh URL', { skip }, async () => {
  // Whatever was created above is still there
  const before = await privilegedPool.query(
    `SELECT stripe_account_id FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  const existing_id = before.rows[0].stripe_account_id;

  const res = await adminFetch('/api/admin/stripe/onboarding', {
    method: 'POST',
    body: JSON.stringify({
      return_url: 'https://app.example/admin/stripe',
      refresh_url: 'https://app.example/admin/stripe',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stripe_account_id, existing_id, 'should reuse existing account');

  // Still only one row
  const after_ = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  assert.equal(after_.rows[0].n, 1);
});

test('non-admin cannot start onboarding (403)', { skip }, async () => {
  // Create a member-only user (no tenant_admins row).
  const email = `member-only-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        first_name: 'Mem',
        last_name: 'Ber',
      }),
    },
  );
  const memberToken = (await reg.json()).token;

  const res = await fetch(`${baseUrl}/api/admin/stripe/onboarding?tenant=${TENANT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({
      return_url: 'https://app.example/admin/stripe',
      refresh_url: 'https://app.example/admin/stripe',
    }),
  });
  assert.equal(res.status, 403);
});

// ============================================================
// connection (status + refresh)
// ============================================================

test('GET /api/admin/stripe/connection returns the row; ?refresh=true syncs state from Stripe', { skip }, async () => {
  // Without refresh, returns whatever's in DB.
  const r1 = await adminFetch('/api/admin/stripe/connection');
  assert.equal(r1.status, 200);
  const body1 = await r1.json();
  assert.ok(body1.connection);
  assert.equal(body1.connection.details_submitted, false);

  // Simulate Stripe-side "tenant completed onboarding" — flip flags
  // in the fake, then call with refresh=true.
  __setAccountState(body1.connection.stripe_account_id, {
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });

  const r2 = await adminFetch('/api/admin/stripe/connection?refresh=true');
  assert.equal(r2.status, 200);
  const body2 = await r2.json();
  assert.equal(body2.connection.details_submitted, true);
  assert.equal(body2.connection.charges_enabled, true);
  assert.equal(body2.connection.payouts_enabled, true);
  assert.ok(body2.connection.fully_onboarded_at, 'fully_onboarded_at should stamp');

  // Calling again — fully_onboarded_at preserved, not overwritten.
  const stamp1 = body2.connection.fully_onboarded_at;
  const r3 = await adminFetch('/api/admin/stripe/connection?refresh=true');
  const body3 = await r3.json();
  assert.equal(body3.connection.fully_onboarded_at, stamp1);
});

test('GET connection returns null connection when none exists', { skip }, async () => {
  // Use a fresh tenant
  const altSubdomain = `verify-stripe-empty-${randomUUID().slice(0, 8)}`;
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Empty', $2)`,
    [altSubdomain, TZ],
  );
  const t = await privilegedPool.query(
    `SELECT id FROM tenants WHERE subdomain = $1`,
    [altSubdomain],
  );
  const altId = t.rows[0].id;
  const altEmail = `admin-${randomUUID()}@example.com`;
  const altPass = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Empty', 'Admin') RETURNING id`,
    [altId, altEmail, await bcrypt.hash(altPass, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [altId, u.rows[0].id],
  );
  try {
    const login = await fetch(`${baseUrl}/api/auth/login?tenant=${altSubdomain}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: altEmail, password: altPass }),
    });
    const tok = (await login.json()).token;
    const res = await fetch(
      `${baseUrl}/api/admin/stripe/connection?tenant=${altSubdomain}`,
      {
        headers: { Authorization: `Bearer ${tok}` },
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connection, null);
  } finally {
    await privilegedPool.query(`DELETE FROM tenants WHERE id = $1`, [altId]);
  }
});
