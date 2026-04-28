// Auth slice tests — Phase 1, slice 1.
//
// Three tests:
//   1. Happy path — register, login, /api/me round-trip.
//   2. Cross-tenant attack, app-layer block — tenant A's JWT against
//      tenant B's URL must 403, AND no DB connection is checked out
//      (proves requireAuth's tenant cross-check fires before any
//      query).
//   3. Cross-tenant attack, DB-layer block — manually open a tx with
//      tenant B's GUC, query for tenant A's user_id, get zero rows
//      (proves RLS catches it even when the app layer is fully
//      bypassed).
//
// Setup creates two throwaway tenants via DATABASE_URL_PRIVILEGED
// (postgres role). The app itself connects via DATABASE_URL
// (app_runtime). Tests skip cleanly if DATABASE_URL_PRIVILEGED isn't
// set — that's how local devs without the privileged URL avoid noise.
// CI sets it as part of the workflow.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const TENANT_A = 'verify-auth-a';
const TENANT_B = 'verify-auth-b';

const skip = !process.env.DATABASE_URL_PRIVILEGED
  && 'DATABASE_URL_PRIVILEGED is required to set up auth test tenants';

let server;
let baseUrl;
let privilegedPool;
let tenantA_id;
let tenantB_id;

// Test helper — creates an admin user (and optionally a member) in
// the given tenant via the privileged pool (which bypasses RLS as
// table owner). Used by admin tests. Returns the user_id.
async function createUserWithRoles(
  tenant_id,
  { email, password, first_name, last_name, admin_role = null, also_member = false },
) {
  const password_hash = await bcrypt.hash(password, 10);
  const userResult = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenant_id, email, password_hash, first_name, last_name],
  );
  const user_id = userResult.rows[0].id;

  if (admin_role) {
    await privilegedPool.query(
      `INSERT INTO tenant_admins (tenant_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [tenant_id, user_id, admin_role],
    );
  }

  if (also_member) {
    await privilegedPool.query(
      `INSERT INTO members (tenant_id, user_id, email, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenant_id, user_id, email, first_name, last_name],
    );
  }

  return user_id;
}

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  // Idempotent setup — if a previous run left tenants behind, reuse them.
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, $2, 'America/New_York'),
            ($3, $4, 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT_A, 'Auth Test A', TENANT_B, 'Auth Test B'],
  );

  const tenantsResult = await privilegedPool.query(
    `SELECT subdomain, id FROM tenants WHERE subdomain IN ($1, $2)`,
    [TENANT_A, TENANT_B],
  );
  for (const row of tenantsResult.rows) {
    if (row.subdomain === TENANT_A) tenantA_id = row.id;
    if (row.subdomain === TENANT_B) tenantB_id = row.id;
  }

  // Bind the in-process app to a random port.
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

  // Drop test tenants. ON DELETE CASCADE on users/members handles the rest.
  await privilegedPool.query(
    `DELETE FROM tenants WHERE subdomain IN ($1, $2)`,
    [TENANT_A, TENANT_B],
  );

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
  await privilegedPool.end();
});

test('happy path: register-member → login → /api/me', { skip }, async () => {
  const email = `alice-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';

  // Register
  const regRes = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      first_name: 'Alice',
      last_name: 'Tester',
    }),
  });
  assert.equal(regRes.status, 201, 'register-member should return 201');
  const regBody = await regRes.json();
  assert.ok(regBody.token, 'should issue a JWT');
  assert.ok(regBody.user_id, 'should return user_id');
  assert.ok(regBody.member_id, 'should return member_id');

  // Login (with the same credentials)
  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200, 'login should return 200');
  const loginBody = await loginRes.json();
  assert.ok(loginBody.token, 'should issue a JWT on login');
  assert.equal(loginBody.user_id, regBody.user_id);
  assert.equal(loginBody.member_id, regBody.member_id);

  // /api/me
  const meRes = await fetch(`${baseUrl}/api/me?tenant=${TENANT_A}`, {
    headers: { Authorization: `Bearer ${loginBody.token}` },
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.user.email, email);
  assert.equal(meBody.user.first_name, 'Alice');
  assert.equal(meBody.user.last_name, 'Tester');
  assert.equal(meBody.tenant.subdomain, TENANT_A);
  assert.equal(meBody.memberships.admin, null, 'should have no admin membership');
  assert.ok(meBody.memberships.member, 'should have member membership');
  assert.equal(meBody.memberships.member.id, regBody.member_id);
});

test('app-layer block: tenant A token against tenant B → 403, NO DB connection', { skip }, async () => {
  // Register a fresh member in tenant A and grab a valid token.
  const email = `bob-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';

  const regRes = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      first_name: 'Bob',
      last_name: 'Tester',
    }),
  });
  assert.equal(regRes.status, 201);
  const { token } = await regRes.json();

  // Spy on pool.connect to count checkouts during the cross-tenant
  // request. Expected: exactly 1 — resolveTenant's tenant_lookup
  // query is unavoidable (we need to know which tenant the request
  // is FOR before requireAuth can compare it to the JWT). What we
  // want to prove: withTenantContext does NOT additionally check out
  // a client (which would mean a transaction was opened). So the
  // assertion is "exactly 1 connect, not 2."
  const origConnect = pool.connect.bind(pool);
  let connectCount = 0;
  pool.connect = (...args) => {
    connectCount++;
    return origConnect(...args);
  };

  try {
    const res = await fetch(`${baseUrl}/api/me?tenant=${TENANT_B}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403, 'cross-tenant token must be rejected with 403');
    assert.equal(
      connectCount,
      1,
      'pool.connect should fire exactly once (resolveTenant). A second connect would mean withTenantContext opened a transaction, which means requireAuth failed to block.',
    );
  } finally {
    pool.connect = origConnect;
  }
});

test('admin-only user can log in; JWT carries admin_id and role=admin', { skip }, async () => {
  // Admin-only user: tenant_admins row, no members row. This is the
  // bootstrap shape that tenant signup will eventually create
  // automatically; for now we set it up via the privileged pool.
  const email = `admin-only-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';

  const adminUserId = await createUserWithRoles(tenantA_id, {
    email,
    password,
    first_name: 'Admin',
    last_name: 'Solo',
    admin_role: 'owner',
    also_member: false,
  });

  // Slice 1's login refused users without a member row. Slice 2
  // accepts admins.
  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200, 'admin-only login should succeed');
  const loginBody = await loginRes.json();
  assert.equal(loginBody.user_id, adminUserId);
  assert.equal(loginBody.member_id, null, 'admin-only user has no member_id');
  assert.ok(loginBody.admin_id, 'admin-only user should get admin_id');
  assert.equal(loginBody.role, 'admin');

  // /api/me reflects: admin populated, member null
  const meRes = await fetch(`${baseUrl}/api/me?tenant=${TENANT_A}`, {
    headers: { Authorization: `Bearer ${loginBody.token}` },
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.equal(meBody.user.email, email);
  assert.ok(meBody.memberships.admin, 'admin row should be present');
  assert.equal(meBody.memberships.admin.role, 'owner');
  assert.equal(meBody.memberships.member, null);
});

test('admin+member user gets role=admin precedence; JWT carries both ids', { skip }, async () => {
  const email = `admin-and-member-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';

  await createUserWithRoles(tenantA_id, {
    email,
    password,
    first_name: 'Owner',
    last_name: 'Member',
    admin_role: 'admin',
    also_member: true,
  });

  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.ok(loginBody.member_id, 'member_id should be set');
  assert.ok(loginBody.admin_id, 'admin_id should be set');
  assert.equal(loginBody.role, 'admin', 'admin takes precedence when both roles exist');

  // /api/me reflects: both populated
  const meRes = await fetch(`${baseUrl}/api/me?tenant=${TENANT_A}`, {
    headers: { Authorization: `Bearer ${loginBody.token}` },
  });
  assert.equal(meRes.status, 200);
  const meBody = await meRes.json();
  assert.ok(meBody.memberships.admin);
  assert.ok(meBody.memberships.member);
  assert.equal(meBody.memberships.admin.role, 'admin');
});

test('DB-layer block: tenant B GUC, tenant A user invisible via RLS', { skip }, async () => {
  // Register a member in tenant A.
  const email = `carol-${randomUUID()}@example.com`;
  const password = 'correcthorsebatterystaple';

  const regRes = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT_A}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      first_name: 'Carol',
      last_name: 'Tester',
    }),
  });
  assert.equal(regRes.status, 201);
  const { user_id } = await regRes.json();

  // Manually open a runtime transaction with tenant B's GUC and try
  // to read tenant A's user. RLS should filter to zero rows even
  // though we have a valid user_id in hand.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      tenantB_id,
    ]);
    const result = await client.query(`SELECT id FROM users WHERE id = $1`, [
      user_id,
    ]);
    assert.equal(
      result.rows.length,
      0,
      'RLS must hide tenant A user when GUC is tenant B',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
