// Platform console tests (migration 032).
//
// Proves:
//   * Login needs password AND a fresh TOTP code; codes are single-use;
//     failures are audited and throttled.
//   * Platform sessions and tenant tokens are not interchangeable.
//   * Deactivating a platform admin kills live sessions.
//   * Tenant list/detail read across tenants through the audited
//     functions; app_runtime still can't read the tables directly.
//   * Console tenant creation without a password invites the owner.
//   * Read-only support sessions: handoff → session as the owner,
//     reads work, every write is refused, everything is audited, and a
//     handoff can't be replayed on a different tenant.
//
// Skips cleanly without DATABASE_URL_PRIVILEGED + SUPER_ADMIN_TOKEN
// (CI sets both).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

import { app } from '../src/app.js';
import { loginThrottle } from '../src/controllers/platformConsole.js';
import { signSupportHandoff } from '../src/lib/supportSession.js';
import { currentStep, generateTotpSecret, hotp } from '../src/lib/totp.js';

const skip =
  (!process.env.DATABASE_URL_PRIVILEGED || !process.env.SUPER_ADMIN_TOKEN) &&
  'DATABASE_URL_PRIVILEGED and SUPER_ADMIN_TOKEN required';

const PASSWORD = 'platform-test-password-123';
let server;
let baseUrl;
let priv;
let runtime;
const admin = { id: null, email: null, secret: generateTotpSecret() };
const createdSubdomains = new Set();
const tenantA = { subdomain: null, id: null, ownerEmail: null, ownerToken: null };
const tenantB = { subdomain: null, id: null };

function uniqueSubdomain(prefix) {
  const sub = `${prefix}-${randomUUID().slice(0, 8)}`;
  createdSubdomains.add(sub);
  return sub;
}

async function signup(subdomain, extra = {}) {
  const ownerEmail = `owner-${randomUUID()}@example.com`;
  const res = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      subdomain,
      name: `Console Test ${subdomain}`,
      timezone: 'America/New_York',
      owner_email: ownerEmail,
      owner_password: 'correcthorsebatterystaple',
      owner_first_name: 'Olive',
      owner_last_name: 'Owner',
      ...extra,
    }),
  });
  assert.equal(res.status, 201);
  return { ...(await res.json()), ownerEmail };
}

function loginRequest({ email = admin.email, password = PASSWORD, code }) {
  return fetch(`${baseUrl}/api/platform/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  });
}

// Fresh session: clears the single-use step so each test can log in
// with the current code.
async function sessionToken() {
  await priv.query('UPDATE platform_admins SET totp_last_step = NULL WHERE id = $1', [admin.id]);
  const res = await loginRequest({ code: hotp(admin.secret, currentStep()) });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  admin.email = `platform-${randomUUID()}@example.com`;
  const ins = await priv.query(
    `INSERT INTO platform_admins (email, display_name, password_hash, totp_secret)
     VALUES ($1, 'Test Operator', $2, $3) RETURNING id`,
    [admin.email, await bcrypt.hash(PASSWORD, 4), admin.secret],
  );
  admin.id = ins.rows[0].id;

  tenantA.subdomain = uniqueSubdomain('pca');
  const a = await signup(tenantA.subdomain);
  tenantA.id = a.tenant_id;
  tenantA.ownerEmail = a.ownerEmail;
  const ownerLogin = await fetch(`${baseUrl}/api/auth/login?tenant=${tenantA.subdomain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.ownerEmail, password: 'correcthorsebatterystaple' }),
  });
  tenantA.ownerToken = (await ownerLogin.json()).token;

  tenantB.subdomain = uniqueSubdomain('pcb');
  tenantB.id = (await signup(tenantB.subdomain)).tenant_id;
});

beforeEach(() => {
  if (!skip) loginThrottle.clear([`ip:127.0.0.1`, `ip:::ffff:127.0.0.1`, `email:${admin.email}`]);
});

after(async () => {
  if (skip) return;
  if (createdSubdomains.size > 0) {
    await priv.query('DELETE FROM tenants WHERE subdomain = ANY($1::text[])', [
      Array.from(createdSubdomains),
    ]);
  }
  if (admin.id) {
    await priv.query('DELETE FROM platform_audit_log WHERE platform_admin_id = $1', [admin.id]);
    await priv.query('DELETE FROM platform_admins WHERE id = $1', [admin.id]);
  }
  await priv.query(
    `DELETE FROM platform_audit_log
      WHERE platform_admin_id IS NULL
        AND (detail->>'email' = $1 OR detail->>'email' LIKE 'nobody-%@example.com'
             OR detail->>'subdomain' = ANY($2::text[]))`,
    [admin.email, Array.from(createdSubdomains)],
  );
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv?.end();
  await runtime?.end();
});

// ---------- login ----------

test('login rejects a wrong password, a wrong code, and a missing code', { skip }, async () => {
  const good = hotp(admin.secret, currentStep());
  assert.equal((await loginRequest({ password: 'nope-nope-nope', code: good })).status, 401);
  const wrong = good === '000000' ? '111111' : '000000';
  assert.equal((await loginRequest({ code: wrong })).status, 401);
  assert.equal((await loginRequest({ code: '' })).status, 400);
  assert.equal(
    (await loginRequest({ email: `nobody-${randomUUID()}@example.com`, code: good })).status,
    401,
  );

  const audit = await priv.query(
    `SELECT detail->>'reason' AS reason FROM platform_audit_log
      WHERE action = 'auth.login_failed' AND detail->>'email' = $1
      ORDER BY id`,
    [admin.email],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.reason),
    ['bad_password', 'bad_code'],
  );
});

test('a TOTP code works once; replay is refused', { skip }, async () => {
  await priv.query('UPDATE platform_admins SET totp_last_step = NULL WHERE id = $1', [admin.id]);
  const code = hotp(admin.secret, currentStep());
  const first = await loginRequest({ code });
  assert.equal(first.status, 200);
  assert.ok((await first.json()).token);
  const replay = await loginRequest({ code });
  assert.equal(replay.status, 401);

  const ok = await priv.query(
    `SELECT count(*)::int AS n FROM platform_audit_log
      WHERE platform_admin_id = $1 AND action = 'auth.login'`,
    [admin.id],
  );
  assert.ok(ok.rows[0].n >= 1);
});

test('login is throttled after repeated failures', { skip }, async () => {
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await loginRequest({ password: 'wrong-wrong-wrong', code: '123456' });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  // Even the right credentials are refused while throttled.
  const blocked = await loginRequest({ code: hotp(admin.secret, currentStep()) });
  assert.equal(blocked.status, 429);
});

// ---------- session boundaries ----------

test('platform session works on /me; tenant tokens and garbage do not', { skip }, async () => {
  const token = await sessionToken();
  const me = await fetch(`${baseUrl}/api/platform/me`, { headers: authed(token) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).admin.email, admin.email);

  const withTenantToken = await fetch(`${baseUrl}/api/platform/tenants`, {
    headers: authed(tenantA.ownerToken),
  });
  assert.equal(withTenantToken.status, 401);
  const none = await fetch(`${baseUrl}/api/platform/tenants`);
  assert.equal(none.status, 401);
});

test('a platform session is not a tenant credential', { skip }, async () => {
  const token = await sessionToken();
  const res = await fetch(`${baseUrl}/api/me?tenant=${tenantA.subdomain}`, {
    headers: authed(token),
  });
  assert.equal(res.status, 401);
});

test('deactivating a platform admin revokes live sessions', { skip }, async () => {
  const token = await sessionToken();
  await priv.query('UPDATE platform_admins SET active = false WHERE id = $1', [admin.id]);
  try {
    const res = await fetch(`${baseUrl}/api/platform/me`, { headers: authed(token) });
    assert.equal(res.status, 401);
  } finally {
    await priv.query('UPDATE platform_admins SET active = true WHERE id = $1', [admin.id]);
  }
});

// ---------- cross-tenant reads ----------

test('tenant list covers every tenant with billing + activity fields', { skip }, async () => {
  const token = await sessionToken();
  const res = await fetch(`${baseUrl}/api/platform/tenants`, { headers: authed(token) });
  assert.equal(res.status, 200);
  const { tenants } = await res.json();
  const a = tenants.find((t) => t.id === tenantA.id);
  const b = tenants.find((t) => t.id === tenantB.id);
  assert.ok(a && b, 'both test tenants listed');
  assert.equal(a.owner_email, tenantA.ownerEmail);
  assert.equal(a.billing_status, 'trial');
  assert.equal(a.member_count, 0);
  assert.equal(a.bookings_last_30d, 0);
  assert.equal(a.stripe_charges_enabled, null);
  assert.match(a.booking_url, new RegExp(`${tenantA.subdomain}\\.`));
});

test('tenant detail returns the full picture and is audited', { skip }, async () => {
  const token = await sessionToken();
  const res = await fetch(`${baseUrl}/api/platform/tenants/${tenantA.id}`, {
    headers: authed(token),
  });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.tenant.subdomain, tenantA.subdomain);
  assert.equal(doc.staff.length, 1);
  assert.equal(doc.staff[0].role, 'owner');
  assert.equal(doc.staff[0].has_password, true);
  assert.equal(doc.setup.resources, 0);
  assert.equal(doc.stripe_connection, null);
  assert.ok(doc.audit.some((e) => e.action === 'tenant.view'));

  const missing = await fetch(`${baseUrl}/api/platform/tenants/${randomUUID()}`, {
    headers: authed(token),
  });
  assert.equal(missing.status, 404);
  const garbage = await fetch(`${baseUrl}/api/platform/tenants/not-a-uuid`, {
    headers: authed(token),
  });
  assert.equal(garbage.status, 404);
});

test('runtime role cannot read platform tables or call functions as a non-admin', { skip }, async () => {
  await assert.rejects(runtime.query('SELECT * FROM platform_admins'), { code: '42501' });
  await assert.rejects(runtime.query('SELECT * FROM platform_audit_log'), { code: '42501' });
  await assert.rejects(
    runtime.query('SELECT * FROM platform_list_tenants($1)', [randomUUID()]),
    /not an active platform admin/,
  );
  // And never inside a tenant transaction, where the per-tenant loop
  // would clobber the request's GUC.
  const c = await runtime.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA.id]);
    await assert.rejects(
      c.query('SELECT * FROM platform_list_tenants($1)', [admin.id]),
      /must not run inside a tenant context/,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

// ---------- tenant creation + billing via console session ----------

test('console signup without a password invites the owner; both writes audited', { skip }, async () => {
  const token = await sessionToken();
  const subdomain = uniqueSubdomain('pcc');
  const ownerEmail = `invited-${randomUUID()}@example.com`;
  const res = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authed(token) },
    body: JSON.stringify({
      subdomain,
      name: 'Invited Owner Gym',
      timezone: 'America/New_York',
      owner_email: ownerEmail,
      owner_first_name: 'Ivy',
      owner_last_name: 'Invited',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.owner_invite_sent, true);

  const u = await priv.query('SELECT password_hash FROM users WHERE id = $1', [body.user_id]);
  assert.equal(u.rows[0].password_hash, null);
  const tok = await priv.query(
    'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
    [body.user_id],
  );
  assert.equal(tok.rows[0].n, 1);

  const billing = await fetch(`${baseUrl}/api/platform/tenants/${subdomain}/billing`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authed(token) },
    body: JSON.stringify({ status: 'trial', trial_ends_at: null }),
  });
  assert.equal(billing.status, 200);

  const audit = await priv.query(
    `SELECT action, platform_admin_id FROM platform_audit_log
      WHERE tenant_id = $1 ORDER BY id`,
    [body.tenant_id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ['tenant.create', 'tenant.billing_update'],
  );
  assert.ok(audit.rows.every((r) => r.platform_admin_id === admin.id));
});

test('signup rejects an unknown timezone', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      subdomain: uniqueSubdomain('pctz'),
      name: 'Bad TZ',
      timezone: 'America/Brooklyn',
      owner_email: `tz-${randomUUID()}@example.com`,
      owner_first_name: 'T',
      owner_last_name: 'Z',
    }),
  });
  assert.equal(res.status, 400);
});

// ---------- read-only support sessions ----------

async function openSupportSession(platformToken, tenant) {
  const issue = await fetch(`${baseUrl}/api/platform/tenants/${tenant.id}/support-session`, {
    method: 'POST',
    headers: authed(platformToken),
  });
  assert.equal(issue.status, 200);
  const { url } = await issue.json();
  assert.match(url, new RegExp(`//${tenant.subdomain}\\..*/support-session#token=`));
  const handoff = decodeURIComponent(url.split('#token=')[1]);
  return handoff;
}

test('support session: reads as the owner, refuses writes, audited', { skip }, async () => {
  const platformToken = await sessionToken();
  const handoff = await openSupportSession(platformToken, tenantA);

  const ex = await fetch(`${baseUrl}/api/auth/support-session?tenant=${tenantA.subdomain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: handoff }),
  });
  assert.equal(ex.status, 200);
  const { token } = await ex.json();

  const me = await fetch(`${baseUrl}/api/me?tenant=${tenantA.subdomain}`, {
    headers: authed(token),
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.user.email, tenantA.ownerEmail);
  assert.equal(meBody.memberships.admin.role, 'owner');
  assert.equal(meBody.support_session.read_only, true);

  const members = await fetch(`${baseUrl}/api/admin/members?tenant=${tenantA.subdomain}`, {
    headers: authed(token),
  });
  assert.equal(members.status, 200);

  const write = await fetch(`${baseUrl}/api/admin/members?tenant=${tenantA.subdomain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authed(token) },
    body: JSON.stringify({
      email: `rw-${randomUUID()}@example.com`,
      first_name: 'Should',
      last_name: 'Fail',
    }),
  });
  assert.equal(write.status, 403);
  assert.match((await write.json()).error, /read-only/);
  const count = await priv.query('SELECT count(*)::int AS n FROM members WHERE tenant_id = $1', [
    tenantA.id,
  ]);
  assert.equal(count.rows[0].n, 0, 'the refused write left no row');

  // An ordinary owner session is unaffected.
  const ownerMe = await fetch(`${baseUrl}/api/me?tenant=${tenantA.subdomain}`, {
    headers: authed(tenantA.ownerToken),
  });
  assert.equal((await ownerMe.json()).support_session, null);

  const audit = await priv.query(
    `SELECT action FROM platform_audit_log
      WHERE tenant_id = $1 AND action LIKE 'support_session.%' ORDER BY id`,
    [tenantA.id],
  );
  assert.deepEqual(
    audit.rows.map((r) => r.action),
    ['support_session.issue', 'support_session.open'],
  );
});

test('support handoff is bound to its tenant, its audience, and an active operator', { skip }, async () => {
  const platformToken = await sessionToken();
  const handoff = await openSupportSession(platformToken, tenantA);

  // Redeemed on tenant B → refused.
  const wrongTenant = await fetch(
    `${baseUrl}/api/auth/support-session?tenant=${tenantB.subdomain}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: handoff }),
    },
  );
  assert.equal(wrongTenant.status, 401);

  // The handoff itself is not a tenant session.
  const asBearer = await fetch(`${baseUrl}/api/me?tenant=${tenantA.subdomain}`, {
    headers: authed(handoff),
  });
  assert.equal(asBearer.status, 401);

  // A platform session token is not a handoff.
  const platformAsHandoff = await fetch(
    `${baseUrl}/api/auth/support-session?tenant=${tenantA.subdomain}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: platformToken }),
    },
  );
  assert.equal(platformAsHandoff.status, 401);

  // A handoff for an unknown operator id → refused.
  const forged = signSupportHandoff({ adminId: randomUUID(), tenantId: tenantA.id });
  const forgedRes = await fetch(
    `${baseUrl}/api/auth/support-session?tenant=${tenantA.subdomain}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: forged }),
    },
  );
  assert.equal(forgedRes.status, 401);
});
