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

const { __getSkippedEmails, __clearSkippedEmails } = await import(
  '../src/services/email.js'
);

const TENANT = 'verify-admin';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED is required to set up admin test users';

let server;
let baseUrl;
let privilegedPool;
let adminToken;
let memberToken;
let tenant_id;
let adminEmail;
let adminUserId;

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
  tenant_id = tenantResult.rows[0].id;

  // Create an admin user (no member row) directly via privileged pool.
  adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const adminHash = await bcrypt.hash(adminPassword, 10);
  const adminUser = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, adminHash],
  );
  adminUserId = adminUser.rows[0].id;
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, adminUserId],
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

// ============================================================
// Phase 2 slice 4: manual member create + credit adjustments
// ============================================================

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

test('admin-created member gets a linked passwordless user; set-password link works; member logs in', { skip }, async () => {
  __clearSkippedEmails();
  const email = `manual-${randomUUID()}@example.com`;
  const res = await adminFetch('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      email,
      first_name: 'Manual',
      last_name: 'Member',
    }),
  });
  assert.equal(res.status, 201);
  const { member } = await res.json();
  assert.equal(member.email, email);
  assert.ok(member.user_id, 'manual member should be linked to a users row');
  assert.equal(member.current_credits, 0);

  // The linked user exists with NO password yet (migration 021).
  const userRow = await privilegedPool.query(
    `SELECT id, password_hash FROM users WHERE tenant_id = $1 AND email = $2`,
    [tenant_id, email],
  );
  assert.equal(userRow.rows.length, 1);
  assert.equal(userRow.rows[0].id, member.user_id);
  assert.equal(userRow.rows[0].password_hash, null);

  // Confirm visible in list — linked but not yet activated, so the
  // list must say login_active=false (drives the 'invite sent' badge).
  const listRes = await adminFetch('/api/admin/members');
  const { members } = await listRes.json();
  const listed = members.find((m) => m.id === member.id);
  assert.ok(listed);
  assert.equal(listed.login_active, false);

  // Welcome email carries the set-password link; extract the token.
  const mail = await waitForEmail((e) => e.to === email);
  assert.ok(mail, 'welcome email was not queued');
  assert.equal(mail.subject, 'Welcome to Admin Tests');
  const match = mail.text.match(/\/reset\?token=([0-9a-f]+)&invite=1/);
  assert.ok(match, `set-password link missing from welcome text:\n${mail.text}`);

  // Consume the token through the normal reset endpoint, then log in
  // as the member — the whole point of linking the user at create.
  const set = await fetch(`${baseUrl}/api/auth/reset-password?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: match[1], new_password: 'membersetme1' }),
  });
  assert.equal(set.status, 200);

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'membersetme1' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.role, 'member');
});

test('admin adds a member with an existing user email → links that user, welcome has sign-in link', { skip }, async () => {
  __clearSkippedEmails();
  // The admin's own email already has a users row WITH a password.
  const res = await adminFetch('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      email: adminEmail,
      first_name: 'Admin',
      last_name: 'AsMember',
    }),
  });
  assert.equal(res.status, 201);
  const { member } = await res.json();
  assert.equal(
    member.user_id,
    adminUserId,
    'member should link the existing user, not create a duplicate',
  );

  // The admin already has a password → list shows an active login.
  const { members } = await (await adminFetch('/api/admin/members')).json();
  assert.equal(
    members.find((m) => m.id === member.id)?.login_active,
    true,
  );

  // Welcome email is the plain sign-in variant — no reset token,
  // which would have invalidated the admin's own password flow.
  const mail = await waitForEmail((e) => e.to === adminEmail);
  assert.ok(mail, 'welcome email was not queued');
  assert.ok(!mail.text.includes('/reset?token='), 'no set-password token for existing users');
  assert.ok(mail.text.includes('/login'), 'sign-in link expected');
});

test('admin grants credits via credit-adjustments; balance reflects', { skip }, async () => {
  // Create a fresh member for this test
  const email = `credit-${randomUUID()}@example.com`;
  const createRes = await adminFetch('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      email,
      first_name: 'Credit',
      last_name: 'Recipient',
    }),
  });
  const { member } = await createRes.json();

  const adjustRes = await adminFetch(
    `/api/admin/members/${member.id}/credit-adjustments`,
    {
      method: 'POST',
      body: JSON.stringify({ amount: 5, note: 'welcome bonus' }),
    },
  );
  assert.equal(adjustRes.status, 201);
  const { entry_id, balance_after } = await adjustRes.json();
  assert.ok(entry_id);
  assert.equal(balance_after, 5);

  // List reflects updated balance
  const listRes = await adminFetch('/api/admin/members');
  const { members } = await listRes.json();
  const found = members.find((m) => m.id === member.id);
  assert.equal(found.current_credits, 5);
});

test('admin deducting more than balance returns 400 (insufficient credits)', { skip }, async () => {
  // Create member with 3 credits
  const email = `insufficient-${randomUUID()}@example.com`;
  const { member } = await (
    await adminFetch('/api/admin/members', {
      method: 'POST',
      body: JSON.stringify({
        email,
        first_name: 'Insufficient',
        last_name: 'Credits',
      }),
    })
  ).json();
  await adminFetch(`/api/admin/members/${member.id}/credit-adjustments`, {
    method: 'POST',
    body: JSON.stringify({ amount: 3 }),
  });

  // Try to deduct 10 (only 3 available)
  const res = await adminFetch(
    `/api/admin/members/${member.id}/credit-adjustments`,
    {
      method: 'POST',
      body: JSON.stringify({ amount: -10 }),
    },
  );
  assert.equal(res.status, 400, 'apply_credit_change should reject insufficient credits as 400');
  const body = await res.json();
  assert.match(body.error, /insufficient credits/i);
});

test('member token gets 403 on credit-adjustments (requireAdmin)', { skip }, async () => {
  // Use existing member from before() — adminFetch but with member token
  const memberFetch = (path, init = {}) =>
    fetch(`${baseUrl}${path}?tenant=${TENANT}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${memberToken}`,
        ...(init.headers ?? {}),
      },
    });

  const res = await memberFetch(
    `/api/admin/members/${randomUUID()}/credit-adjustments`,
    {
      method: 'POST',
      body: JSON.stringify({ amount: 100 }),
    },
  );
  assert.equal(res.status, 403);
});

test('listMembers now exposes current_credits (LEFT JOIN with credit_balances)', { skip }, async () => {
  const listRes = await adminFetch('/api/admin/members');
  assert.equal(listRes.status, 200);
  const { members } = await listRes.json();
  // Every row must have a current_credits field, default 0 for
  // members without a balance row.
  for (const m of members) {
    assert.equal(
      typeof m.current_credits,
      'number',
      `member ${m.id} should have a numeric current_credits`,
    );
  }
});

// ============================================================
// admin bookings calendar — Phase 3 slice 6
// ============================================================

test('GET /api/admin/bookings rejects member tokens (requireAdmin)', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/admin/bookings?tenant=${TENANT}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  assert.equal(res.status, 403);
});

test('GET /api/admin/bookings returns rows joined with offering + resource + member', { skip }, async () => {
  // Build a fixture booking inline. We don't reuse the bookings test
  // file's fixtures because each suite owns its own tenant.
  const resourceId = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Calendar Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  const offeringId = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, 'calendar-cage-30', 'cage-time', 60, 1, 1000, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offeringId, resourceId],
  );
  const memberId = (
    await privilegedPool.query(
      `INSERT INTO members (tenant_id, email, first_name, last_name)
       VALUES ($1, $2, 'Calendar', 'Booker') RETURNING id`,
      [tenant_id, `calendar-${randomUUID()}@example.com`],
    )
  ).rows[0].id;

  // Future booking 2 hours from now (so the date window default
  // [today, today+60d) covers it).
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const bookingId = (
    await privilegedPool.query(
      `INSERT INTO bookings (
         tenant_id, offering_id, resource_id, member_id,
         start_time, end_time, status,
         amount_due_cents, credit_cost_charged, payment_status
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'confirmed', 0, 1, 'not_required'
       )
       RETURNING id`,
      [tenant_id, offeringId, resourceId, memberId, start, end],
    )
  ).rows[0].id;

  try {
    const res = await adminFetch('/api/admin/bookings');
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.bookings.find((b) => b.id === bookingId);
    assert.ok(row, 'fixture booking should appear in admin list');
    assert.equal(row.offering_name, 'calendar-cage-30');
    assert.equal(row.resource_name, 'Calendar Cage');
    assert.equal(row.member_first_name, 'Calendar');
    assert.equal(row.member_last_name, 'Booker');
    assert.equal(row.status, 'confirmed');
  } finally {
    // Cleanup so this booking doesn't leak.
    await privilegedPool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId]);
    await privilegedPool.query(`DELETE FROM members WHERE id = $1`, [memberId]);
    await privilegedPool.query(`DELETE FROM offerings WHERE id = $1`, [offeringId]);
    await privilegedPool.query(`DELETE FROM resources WHERE id = $1`, [resourceId]);
  }
});

test('GET /api/admin/bookings status filter narrows results', { skip }, async () => {
  // Pass a status the fixture booking doesn't match → expect 0 rows
  // (or at least: no rows with status != 'cancelled').
  const res = await adminFetch('/api/admin/bookings?status=cancelled');
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const b of body.bookings) {
    assert.equal(b.status, 'cancelled', 'filter should exclude non-cancelled');
  }
});

test('GET /api/admin/bookings rejects from >= to with 400', { skip }, async () => {
  const now = new Date().toISOString();
  const res = await adminFetch(
    `/api/admin/bookings?from=${encodeURIComponent(now)}&to=${encodeURIComponent(now)}`,
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /from must be before to/i);
});

test('cancelling a Stripe-paid walk-in reports the un-refunded amount; cash walk-in reports 0', { skip }, async () => {
  // Cancel never touches Stripe — the response must say how much of
  // the customer's money the tenant still holds so the admin UI can
  // prompt a manual dashboard refund.
  const resourceId = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Refund Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  const offeringId = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, 'refund-cage-30', 'cage-time', 30, 1, 3000, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offeringId, resourceId],
  );

  const mkWalkIn = async (startOffsetH, paymentFields) => {
    const start = new Date(Date.now() + startOffsetH * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return (
      await privilegedPool.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id,
           customer_first_name, customer_last_name, customer_email,
           start_time, end_time, status,
           amount_due_cents, amount_paid_cents, payment_status
         ) VALUES (
           $1, $2, $3, 'Walk', 'In', $4, $5, $6, 'confirmed',
           3000, $7, $8
         ) RETURNING id`,
        [
          tenant_id,
          offeringId,
          resourceId,
          `walkin-${randomUUID()}@example.com`,
          start,
          end,
          paymentFields.paid,
          paymentFields.status,
        ],
      )
    ).rows[0].id;
  };

  const paidId = await mkWalkIn(48, { paid: 3000, status: 'paid' });
  const cashId = await mkWalkIn(72, { paid: 0, status: 'pending' });

  try {
    const paidRes = await adminFetch(`/api/bookings/${paidId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(paidRes.status, 200);
    const paidBody = await paidRes.json();
    assert.equal(paidBody.status, 'cancelled');
    assert.equal(paidBody.payment_status, 'paid');
    assert.equal(
      paidBody.stripe_refund_due_cents,
      3000,
      'paid walk-in cancel must surface the un-refunded Stripe amount',
    );

    const cashRes = await adminFetch(`/api/bookings/${cashId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(cashRes.status, 200);
    const cashBody = await cashRes.json();
    assert.equal(
      cashBody.stripe_refund_due_cents,
      0,
      'cash-on-arrival cancel holds no Stripe money',
    );
  } finally {
    await privilegedPool.query(
      `DELETE FROM bookings WHERE id = ANY($1::uuid[])`,
      [[paidId, cashId]],
    );
    await privilegedPool.query(`DELETE FROM offerings WHERE id = $1`, [offeringId]);
    await privilegedPool.query(`DELETE FROM resources WHERE id = $1`, [resourceId]);
  }
});
