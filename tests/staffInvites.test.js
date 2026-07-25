// POST /api/admin/admins — staff invites (people-flows slice).
//
// Covers:
//   1. Invite a brand-new email → user row with NULL password_hash +
//      tenant_admins row; invite email carries a set-password link
//      whose token (password-reset infrastructure) lets the invitee
//      set a password and log in as an admin. Until then, login 401s.
//   2. Invite an existing member's email → role attach on the same
//      user identity (one user, many roles); invite email carries a
//      sign-in link, NOT a token (their password still works).
//   3. Inviting an email that's already an admin → 409.
//   4. Validation 400 + requireAdmin 403.
//
// Emails are asserted through the keyless skip log (RESEND_API_KEY
// unset → recorded no-ops). Request-path sends fire on res 'finish',
// so we poll briefly (same pattern as email.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-staff-invites';

// Keyless email BEFORE the app (and the email service) load.
delete process.env.RESEND_API_KEY;

const { app } = await import('../src/app.js');
const { __getSkippedEmails, __clearSkippedEmails } = await import(
  '../src/services/email.js'
);

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED is required to set up staff invite fixtures';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let memberToken;
let ownerEmail;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
    TENANT,
  ]);
  tenant_id = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Staff Invite Tests', 'America/New_York')
       RETURNING id`,
      [TENANT],
    )
  ).rows[0].id;

  ownerEmail = `owner-${randomUUID()}@example.com`;
  const ownerHash = await bcrypt.hash('correcthorsebatterystaple', 10);
  const ownerUser = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Owner', 'Tester') RETURNING id`,
    [tenant_id, ownerEmail, ownerHash],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, ownerUser.rows[0].id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ownerEmail,
      password: 'correcthorsebatterystaple',
    }),
  });
  adminToken = (await login.json()).token;

  const reg = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `member-${randomUUID()}@example.com`,
      password: 'password123',
      first_name: 'Plain',
      last_name: 'Member',
    }),
  });
  assert.equal(reg.status, 201);
  memberToken = (await reg.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
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

function authFetch(path, body) {
  return fetch(`${baseUrl}${path}?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Request-path emails fire on res 'finish' — poll briefly.
async function waitForEmail(pred, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = __getSkippedEmails().find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('invite new email → passwordless user; token sets password; invitee logs in as admin', { skip }, async () => {
  __clearSkippedEmails();
  const email = `newstaff-${randomUUID()}@example.com`;

  const res = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({ email, first_name: 'Newly', last_name: 'Invited' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.existing_user, false);
  assert.equal(body.admin.role, 'admin');
  assert.equal(body.admin.email, email);

  // User row exists with NO password (migration 021).
  const userRow = await privilegedPool.query(
    `SELECT id, password_hash FROM users WHERE tenant_id = $1 AND email = $2`,
    [tenant_id, email],
  );
  assert.equal(userRow.rows.length, 1);
  assert.equal(userRow.rows[0].password_hash, null);

  // Roster includes the invitee.
  const roster = await (await adminFetch('/api/admin/admins')).json();
  assert.ok(roster.admins.some((a) => a.email === email));

  // Can't log in before setting a password — same 401 as a bad
  // password, no enumeration signal.
  const early = await authFetch('/api/auth/login', {
    email,
    password: 'anything-at-all',
  });
  assert.equal(early.status, 401);

  // Invite email carries the set-password link; extract the token.
  const mail = await waitForEmail((e) => e.to === email);
  assert.ok(mail, 'invite email was not queued');
  assert.equal(
    mail.subject,
    "You've been invited to help manage Staff Invite Tests",
  );
  const match = mail.text.match(/\/reset\?token=([0-9a-f]+)&invite=1/);
  assert.ok(match, `set-password link missing from invite text:\n${mail.text}`);
  const token = match[1];

  // Consume the token through the normal reset endpoint.
  const set = await authFetch('/api/auth/reset-password', {
    token,
    new_password: 'brandnewpassword1',
  });
  assert.equal(set.status, 200);

  // Token is single-use.
  const reuse = await authFetch('/api/auth/reset-password', {
    token,
    new_password: 'anotherpassword1',
  });
  assert.equal(reuse.status, 400);

  // The invitee now logs in as an admin and can hit admin routes.
  const login = await authFetch('/api/auth/login', {
    email,
    password: 'brandnewpassword1',
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.role, 'admin');
  assert.ok(loginBody.admin_id);

  const adminHit = await fetch(`${baseUrl}/api/admin/members?tenant=${TENANT}`, {
    headers: { Authorization: `Bearer ${loginBody.token}` },
  });
  assert.equal(adminHit.status, 200);
});

test('invite existing member email → role attach on same user; sign-in link, no token', { skip }, async () => {
  __clearSkippedEmails();

  // Register a member with a working password.
  const email = `promoted-${randomUUID()}@example.com`;
  const reg = await authFetch('/api/auth/register-member', {
    email,
    password: 'memberpassword1',
    first_name: 'Promo',
    last_name: 'Ted',
  });
  assert.equal(reg.status, 201);
  const { user_id } = await reg.json();
  __clearSkippedEmails(); // drop the signup welcome email

  const res = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({ email, first_name: 'Ignored', last_name: 'Names' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.existing_user, true);
  // Existing user keeps their real names, not the form's.
  assert.equal(body.admin.first_name, 'Promo');
  assert.equal(body.admin.user_id, user_id);

  // Same login now carries both roles, admin takes precedence.
  const login = await authFetch('/api/auth/login', {
    email,
    password: 'memberpassword1',
  });
  const loginBody = await login.json();
  assert.equal(loginBody.role, 'admin');
  assert.ok(loginBody.admin_id);
  assert.ok(loginBody.member_id, 'member role should be preserved');

  // Invite email links to sign-in, not a set-password token.
  const mail = await waitForEmail((e) => e.to === email);
  assert.ok(mail, 'invite email was not queued');
  assert.ok(mail.text.includes('/login'), 'expected a sign-in link');
  assert.ok(!mail.text.includes('/reset?token='), 'no token for existing users');
});

test('inviting an email that is already an admin → 409', { skip }, async () => {
  // The owner from before() is already an admin.
  const res = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({
      email: ownerEmail,
      first_name: 'Dup',
      last_name: 'Licate',
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /already an admin/i);

  // Double-inviting a fresh invitee also 409s.
  const email = `twice-${randomUUID()}@example.com`;
  const first = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({ email, first_name: 'In', last_name: 'Vited' }),
  });
  assert.equal(first.status, 201);
  const second = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({ email, first_name: 'In', last_name: 'Vited' }),
  });
  assert.equal(second.status, 409);
});

test('invalid input → 400; member token → 403', { skip }, async () => {
  const bad = await adminFetch('/api/admin/admins', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-an-email', first_name: 'X' }),
  });
  assert.equal(bad.status, 400);

  const forbidden = await fetch(`${baseUrl}/api/admin/admins?tenant=${TENANT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({
      email: `x-${randomUUID()}@example.com`,
      first_name: 'X',
      last_name: 'Y',
    }),
  });
  assert.equal(forbidden.status, 403);
});
