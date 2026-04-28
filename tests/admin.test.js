// Admin views tests — Phase 1, slice 4.
//
// Three tests:
//   1. Admin token can GET /api/admin/members (200, returns array)
//   2. Admin token can GET /api/admin/admins (200, includes owner row)
//   3. Member token gets 403 on /api/admin/members (requireAdmin gate)
//
// Self-contained: tests create their own throwaway tenant + admin
// owner via the privileged pool, register a member via the API, and
// drop the tenant on teardown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-admin';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED is required to set up admin test users';

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
     VALUES ($1, $2, 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, 'Admin Tests'],
  );
  const tenantResult = await privilegedPool.query(
    `SELECT id FROM tenants WHERE subdomain = $1`,
    [TENANT],
  );
  const tenant_id = tenantResult.rows[0].id;

  // Create an admin user (no member row) directly via privileged pool.
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const adminHash = await bcrypt.hash(adminPassword, 10);
  const adminUser = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, adminHash],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, adminUser.rows[0].id],
  );

  // Boot the in-process app on a random port.
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  // Log in as admin to grab a token.
  const adminLogin = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!adminLogin.ok) {
    throw new Error(`admin login failed: HTTP ${adminLogin.status}`);
  }
  adminToken = (await adminLogin.json()).token;

  // Register a regular member via the API and grab their token.
  const memberEmail = `member-${randomUUID()}@example.com`;
  const memberPassword = 'correcthorsebatterystaple';
  const memberReg = await fetch(
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
  if (!memberReg.ok) {
    throw new Error(`member registration failed: HTTP ${memberReg.status}`);
  }
  memberToken = (await memberReg.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('admin can list members; response includes the registered member', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/members?tenant=${TENANT}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.members));
  assert.ok(body.members.length >= 1, 'should include at least the registered member');
  const m = body.members[0];
  assert.ok(m.id);
  assert.ok(m.email);
  assert.ok(m.first_name);
});

test('admin can list admins; response includes the owner', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/admins?tenant=${TENANT}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.admins));
  assert.ok(body.admins.length >= 1, 'should include at least the owner');
  const owner = body.admins.find((a) => a.role === 'owner');
  assert.ok(owner, 'owner row should be present');
  assert.equal(owner.first_name, 'Admin');
});

test('member is denied access to /api/admin/members (requireAdmin)', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/members?tenant=${TENANT}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  assert.equal(res.status, 403, 'requireAdmin must reject member-only tokens');
  const body = await res.json();
  assert.match(body.error, /admin/);
});
