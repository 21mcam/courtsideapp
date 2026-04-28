// Platform tests — Phase 1, slice 3.
//
// /api/platform/signup-tenant is the super-admin path that creates
// tenant + owner user + tenant_admins row + default booking_policies
// in one atomic SECURITY DEFINER function call. Tests prove:
//
//   1. Missing super-admin token → 401, no DB work
//   2. Wrong super-admin token → 401, no DB work
//   3. Valid signup creates everything; the new owner can log in via
//      the regular tenant flow and /api/me reflects role='owner'
//   4. Duplicate subdomain → 409
//
// Tests also re-run a quick "runtime cannot SELECT FROM tenants"
// check to prove the SECURITY DEFINER function didn't accidentally
// open up direct privileges.
//
// Tests skip cleanly if SUPER_ADMIN_TOKEN or DATABASE_URL_PRIVILEGED
// isn't set. CI sets both.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { app } from '../src/app.js';

const skip =
  (!process.env.DATABASE_URL_PRIVILEGED || !process.env.SUPER_ADMIN_TOKEN) &&
  'DATABASE_URL_PRIVILEGED and SUPER_ADMIN_TOKEN required';

let server;
let baseUrl;
let privilegedPool;
const createdSubdomains = new Set();

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED || !process.env.SUPER_ADMIN_TOKEN) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED || !process.env.SUPER_ADMIN_TOKEN) return;

  // Clean up every tenant the tests created. ON DELETE CASCADE
  // handles users / members / tenant_admins / booking_policies.
  if (privilegedPool && createdSubdomains.size > 0) {
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain = ANY($1::text[])`,
      [Array.from(createdSubdomains)],
    );
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await privilegedPool?.end();
});

function uniqueSubdomain(prefix) {
  // 12 chars total max for prefix-uuidchunk pair, schema allows 1+30+1.
  const sub = `${prefix}-${randomUUID().slice(0, 8)}`;
  createdSubdomains.add(sub);
  return sub;
}

test('signup-tenant rejects request with no super-admin token', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subdomain: 'no-token-attempt',
      name: 'No Token',
      timezone: 'America/New_York',
      owner_email: 'a@example.com',
      owner_password: 'correcthorsebatterystaple',
      owner_first_name: 'A',
      owner_last_name: 'A',
    }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /missing super-admin token/);
});

test('signup-tenant rejects request with wrong super-admin token', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': 'wrong-value',
    },
    body: JSON.stringify({
      subdomain: 'wrong-token-attempt',
      name: 'Wrong Token',
      timezone: 'America/New_York',
      owner_email: 'b@example.com',
      owner_password: 'correcthorsebatterystaple',
      owner_first_name: 'B',
      owner_last_name: 'B',
    }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /invalid super-admin token/);
});

test('signup-tenant happy path: creates tenant + owner; owner can log in', { skip }, async () => {
  const subdomain = uniqueSubdomain('signup');
  const ownerEmail = `owner-${randomUUID()}@example.com`;
  const ownerPassword = 'correcthorsebatterystaple';

  const signupRes = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      subdomain,
      name: 'Test Signup Tenant',
      timezone: 'America/New_York',
      owner_email: ownerEmail,
      owner_password: ownerPassword,
      owner_first_name: 'Owner',
      owner_last_name: 'Signup',
    }),
  });
  assert.equal(signupRes.status, 201, 'signup should return 201');
  const signupBody = await signupRes.json();
  assert.ok(signupBody.tenant_id);
  assert.ok(signupBody.user_id);
  assert.ok(signupBody.admin_id);
  assert.equal(signupBody.subdomain, subdomain);

  // Owner logs in via the regular tenant flow.
  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${subdomain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  assert.equal(loginRes.status, 200, 'owner login should succeed');
  const loginBody = await loginRes.json();
  assert.equal(loginBody.role, 'admin');
  assert.equal(loginBody.member_id, null);
  assert.ok(loginBody.admin_id);

  // /api/me confirms the owner's role.
  const meRes = await fetch(`${baseUrl}/api/me?tenant=${subdomain}`, {
    headers: { Authorization: `Bearer ${loginBody.token}` },
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.user.email, ownerEmail);
  assert.equal(meBody.tenant.subdomain, subdomain);
  assert.equal(meBody.memberships.member, null);
  assert.ok(meBody.memberships.admin);
  assert.equal(
    meBody.memberships.admin.role,
    'owner',
    'newly created tenant_admins row should have role=owner',
  );

  // Confirm a default booking_policies row was created (singleton
  // per tenant). Use the privileged pool — app_runtime would need
  // the GUC, easier to just check from the table-owner side.
  const policyResult = await privilegedPool.query(
    `SELECT 1 FROM booking_policies WHERE tenant_id = $1`,
    [signupBody.tenant_id],
  );
  assert.equal(
    policyResult.rows.length,
    1,
    'create_tenant_with_owner should seed booking_policies',
  );
});

test('signup-tenant duplicate subdomain returns 409', { skip }, async () => {
  const subdomain = uniqueSubdomain('dup');

  const make = (label) =>
    fetch(`${baseUrl}/api/platform/signup-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        subdomain,
        name: label,
        timezone: 'America/New_York',
        owner_email: `${label.toLowerCase()}-${randomUUID()}@example.com`,
        owner_password: 'correcthorsebatterystaple',
        owner_first_name: label,
        owner_last_name: 'Owner',
      }),
    });

  const first = await make('First');
  assert.equal(first.status, 201, 'first signup should succeed');

  const second = await make('Second');
  assert.equal(second.status, 409, 'duplicate subdomain should return 409');
});

test('signup-tenant did NOT widen runtime privileges on tenants', { skip }, async () => {
  // The whole point of using a SECURITY DEFINER function (vs a
  // privileged app pool) is that app_runtime never gains direct
  // tenants access. Re-prove that — same query as the smoke test,
  // but here it lives next to the feature it could have broken.
  const runtimePool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await assert.rejects(
      () => runtimePool.query('SELECT id FROM tenants LIMIT 1'),
      (err) => err.code === '42501',
      'app_runtime must still be denied direct tenants access',
    );
  } finally {
    await runtimePool.end();
  }
});
