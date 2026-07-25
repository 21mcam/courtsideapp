// Liability waivers v1 tests — Tier-A sell-readiness slice.
//
// Covers:
//   * GET /api/waivers/current: hidden when waiver off, public text +
//     version when on
//   * Member rental + class booking: 409 with code
//     'waiver_signature_required' → POST /api/waivers/sign → retry
//     succeeds
//   * Version semantics: editing waiver_text bumps waiver_version and
//     invalidates every existing signature; saving identical text does
//     NOT bump; PUT booking-policies omitting waiver fields preserves
//     the stored waiver config
//   * Walk-in: 409 without inline waiver, signature recorded against
//     customer_email in the SAME transaction as the booking (rolled
//     back when the booking fails), repeat visits don't duplicate
//   * Guardian/minor validation (member modal + walk-in inline)
//   * Admin roster: GET /api/admin/waiver-signatures with
//     current_only filter, member vs walk-in join fields
//   * Append-only privilege: runtime role cannot UPDATE/DELETE
//     waiver_signatures (42501)
//   * RLS: signatures invisible and unwritable across tenants
//
// Policy state is shared tenant-wide, so every test that depends on
// waiver config sets it explicitly via the real admin PUT (which is
// also what exercises the server-side version bump).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const TENANT = 'verify-waivers';
const TZ = 'UTC';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_waivers';

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let runtimePool; // app_runtime role — for RLS / privilege assertions
let tenant_id;
let adminToken;
let stripe_account_id;
let resource_id;
let offering_id; // rental, capacity 1, member + public
let class_offering_id; // capacity 8
const CREDIT_COST = 3;
const CLASS_CREDIT_COST = 2;
const DURATION_MIN = 60;
const DOLLAR_PRICE = 4500;

const WAIVER_TEXT_A = 'I accept all risks of batted balls. Version A.';
const WAIVER_TEXT_B = 'I accept all risks of batted balls. Version B.';

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  runtimePool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Waiver Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ])
  ).rows[0].id;

  // Admin owner — sets policies, grants credits, reads the roster.
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Waivers') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // Stripe connection (walk-in flow requires charges_enabled).
  stripeFake.__resetStripeFake();
  stripe_account_id = `acct_test_${randomUUID().slice(0, 8)}`;
  stripeFake.__setAccountState(stripe_account_id, {
    id: stripe_account_id,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  await privilegedPool.query(
    `INSERT INTO stripe_connections (tenant_id, stripe_account_id,
       details_submitted, charges_enabled, payouts_enabled)
     VALUES ($1, $2, true, true, true)`,
    [tenant_id, stripe_account_id],
  );

  // One resource, a rental offering, a class offering, hours all week
  // (UTC tenant, so fixed ISO slots need no DST math).
  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Waiver Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Waiver Cage 60min', 'cage-time', $2, $3, $4, 1, true, true)
       RETURNING id`,
      [tenant_id, DURATION_MIN, CREDIT_COST, DOLLAR_PRICE],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Waiver Class', 'classes', $2, $3, $4, 8, true, true)
       RETURNING id`,
      [tenant_id, DURATION_MIN, CLASS_CREDIT_COST, DOLLAR_PRICE],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $4, $3)`,
    [tenant_id, offering_id, resource_id, class_offering_id],
  );
  for (let dow = 0; dow < 7; dow++) {
    await privilegedPool.query(
      `INSERT INTO operating_hours
         (tenant_id, resource_id, day_of_week, open_time, close_time)
       VALUES ($1, $2, $3, '00:00', '23:59:59')`,
      [tenant_id, resource_id, dow],
    );
  }

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!login.ok) throw new Error('admin login failed');
  adminToken = (await login.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    // waiver_signatures.member_id is ON DELETE RESTRICT, but the
    // tenant_id FK cascades — deleting the tenant removes everything.
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
    await privilegedPool.end();
  }
  await runtimePool?.end();
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
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

function memberFetch(token, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

function publicFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

// PUT booking-policies through the real admin endpoint (exercises the
// server-side waiver_version bump). Non-waiver fields are pinned to
// permissive values so 2027-dated slots pass the advance-window gate.
async function setPolicies(waiverFields = {}) {
  const res = await adminFetch('/api/admin/booking-policies', {
    method: 'PUT',
    body: JSON.stringify({
      min_advance_booking_minutes: 0,
      max_advance_booking_days: 730,
      ...waiverFields,
    }),
  });
  assert.equal(res.status, 200, 'setPolicies must succeed');
  return (await res.json()).booking_policies;
}

async function newMember() {
  const email = `member-${randomUUID()}@example.com`;
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'correcthorsebatterystaple',
        first_name: 'Waiver',
        last_name: 'Member',
      }),
    },
  );
  if (!reg.ok) throw new Error(`register-member failed: HTTP ${reg.status}`);
  const body = await reg.json();
  return { ...body, email };
}

async function grantCredits(member_id, amount) {
  const res = await adminFetch(
    `/api/admin/members/${member_id}/credit-adjustments`,
    {
      method: 'POST',
      body: JSON.stringify({ amount, note: 'waiver test grant' }),
    },
  );
  if (!res.ok) throw new Error(`grant credits failed: HTTP ${res.status}`);
}

function bookSlot(token, start_time) {
  return memberFetch(token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ offering_id, resource_id, start_time }),
  });
}

function signWaiver(token, body) {
  return memberFetch(token, '/api/waivers/sign', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function newClassInstance(start_time) {
  const start = new Date(start_time);
  const end = new Date(start.getTime() + DURATION_MIN * 60 * 1000);
  const r = await privilegedPool.query(
    `INSERT INTO class_instances
       (tenant_id, class_schedule_id, offering_id, resource_id,
        start_time, end_time, capacity)
     VALUES ($1, NULL, $2, $3, $4, $5, 8)
     RETURNING id`,
    [tenant_id, class_offering_id, resource_id, start, end],
  );
  return r.rows[0].id;
}

function walkInBody(start_time, { email, waiver } = {}) {
  return {
    offering_id,
    resource_id,
    start_time,
    customer: {
      first_name: 'Walk',
      last_name: 'In',
      email: email ?? `walkin-${randomUUID()}@example.com`,
      phone: '+15555550100',
    },
    ...(waiver ? { waiver } : {}),
    success_url: 'https://app.example/walk-in/success',
    cancel_url: 'https://app.example/walk-in?cancelled=1',
  };
}

// ============================================================
// GET /api/waivers/current
// ============================================================

test('GET /api/waivers/current hides the text when waiver is off', { skip }, async () => {
  await setPolicies({ waiver_required: false });
  const res = await publicFetch('/api/waivers/current');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.waiver_required, false);
  assert.ok(!('waiver_text' in body), 'text must not leak when waiver off');
});

test('GET /api/waivers/current is public and returns text + version when required', { skip }, async () => {
  const policies = await setPolicies({
    waiver_required: true,
    waiver_text: WAIVER_TEXT_A,
  });
  assert.equal(policies.waiver_required, true);
  assert.equal(policies.waiver_text, WAIVER_TEXT_A);

  const res = await publicFetch('/api/waivers/current'); // no auth header
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.waiver_required, true);
  assert.equal(body.waiver_text, WAIVER_TEXT_A);
  assert.equal(body.waiver_version, policies.waiver_version);
});

// ============================================================
// member enforcement: 409 → sign → retry succeeds
// ============================================================

test('member rental booking: 409 with waiver code → sign → retry succeeds', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const m = await newMember();
  await grantCredits(m.member_id, 10);

  const blocked = await bookSlot(m.token, '2027-03-02T15:00:00.000Z');
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, 'waiver_signature_required');
  assert.equal(blockedBody.waiver_version, policies.waiver_version);

  const signed = await signWaiver(m.token, {
    signer_name: 'Waiver Member',
    waiver_version: policies.waiver_version,
  });
  assert.equal(signed.status, 201);
  const { signature } = await signed.json();
  assert.equal(signature.member_id, m.member_id);
  assert.equal(signature.waiver_version, policies.waiver_version);
  assert.equal(signature.is_minor, false);

  const retry = await bookSlot(m.token, '2027-03-02T15:00:00.000Z');
  assert.equal(retry.status, 201, 'booking must succeed after signing');

  // DB row: member signature at the current version.
  const r = await privilegedPool.query(
    `SELECT member_id, customer_email, waiver_version FROM waiver_signatures
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, m.member_id],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].customer_email, null);
  assert.equal(r.rows[0].waiver_version, policies.waiver_version);
});

test('member class booking: gated by the same waiver code', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const m = await newMember();
  await grantCredits(m.member_id, 10);
  const ci = await newClassInstance('2027-03-03T15:00:00.000Z');

  const blocked = await memberFetch(m.token, '/api/class-bookings', {
    method: 'POST',
    body: JSON.stringify({ class_instance_id: ci }),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'waiver_signature_required');

  const signed = await signWaiver(m.token, {
    signer_name: 'Class Member',
    waiver_version: policies.waiver_version,
  });
  assert.equal(signed.status, 201);

  const retry = await memberFetch(m.token, '/api/class-bookings', {
    method: 'POST',
    body: JSON.stringify({ class_instance_id: ci }),
  });
  assert.equal(retry.status, 201, 'class booking must succeed after signing');
});

// ============================================================
// signing validation
// ============================================================

test('signing for a minor requires guardian_name; records both when given', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const m = await newMember();

  const missing = await signWaiver(m.token, {
    signer_name: 'Junior Member',
    is_minor: true,
    waiver_version: policies.waiver_version,
  });
  assert.equal(missing.status, 400);

  const ok = await signWaiver(m.token, {
    signer_name: 'Junior Member',
    is_minor: true,
    guardian_name: 'Guardian Adult',
    waiver_version: policies.waiver_version,
  });
  assert.equal(ok.status, 201);
  const { signature } = await ok.json();
  assert.equal(signature.is_minor, true);
  assert.equal(signature.guardian_name, 'Guardian Adult');
});

test('signing when the waiver is not required → 409', { skip }, async () => {
  await setPolicies({ waiver_required: false });
  const m = await newMember();
  const res = await signWaiver(m.token, {
    signer_name: 'Eager Signer',
    waiver_version: 1,
  });
  assert.equal(res.status, 409);
});

test('signing with a stale waiver_version → 409 waiver_version_mismatch', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const m = await newMember();

  // Client rendered version N, admin bumped to N+1 before the POST.
  const res = await signWaiver(m.token, {
    signer_name: 'Stale Signer',
    waiver_version: policies.waiver_version + 1,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'waiver_version_mismatch');
  assert.equal(body.waiver_version, policies.waiver_version);

  // No signature row was recorded for the mismatched attempt.
  const r = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM waiver_signatures
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, m.member_id],
  );
  assert.equal(r.rows[0].n, 0);
});

test('signing without waiver_version → 400 (version echo is required)', { skip }, async () => {
  await setPolicies({ waiver_required: true });
  const m = await newMember();
  const res = await signWaiver(m.token, { signer_name: 'No Version' });
  assert.equal(res.status, 400);
});

test('admin-only token (no member_id) cannot sign → 403', { skip }, async () => {
  await setPolicies({ waiver_required: true });
  const res = await adminFetch('/api/waivers/sign', {
    method: 'POST',
    body: JSON.stringify({ signer_name: 'Not A Member' }),
  });
  assert.equal(res.status, 403);
});

// ============================================================
// version semantics
// ============================================================

test('editing waiver_text bumps the version and invalidates existing signatures', { skip }, async () => {
  const p1 = await setPolicies({
    waiver_required: true,
    waiver_text: WAIVER_TEXT_A,
  });
  const m = await newMember();
  await grantCredits(m.member_id, 10);

  await signWaiver(m.token, {
    signer_name: 'Re-signer',
    waiver_version: p1.waiver_version,
  });
  const first = await bookSlot(m.token, '2027-03-04T15:00:00.000Z');
  assert.equal(first.status, 201);

  // Change the text (waiver_required omitted → stays on). Version bumps.
  const p2 = await setPolicies({ waiver_text: WAIVER_TEXT_B });
  assert.equal(p2.waiver_version, p1.waiver_version + 1);
  assert.equal(p2.waiver_required, true, 'omitted waiver_required must persist');

  // The old signature no longer satisfies enforcement.
  const blocked = await bookSlot(m.token, '2027-03-05T15:00:00.000Z');
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, 'waiver_signature_required');
  assert.equal(blockedBody.waiver_version, p2.waiver_version);

  // Saving IDENTICAL text is not a bump.
  const p3 = await setPolicies({ waiver_text: WAIVER_TEXT_B });
  assert.equal(p3.waiver_version, p2.waiver_version);

  // Re-sign at the new version → booking flows again.
  const reSigned = await signWaiver(m.token, {
    signer_name: 'Re-signer',
    waiver_version: p2.waiver_version,
  });
  assert.equal(reSigned.status, 201);
  assert.equal((await reSigned.json()).signature.waiver_version, p2.waiver_version);
  const retry = await bookSlot(m.token, '2027-03-05T15:00:00.000Z');
  assert.equal(retry.status, 201);
});

test('PUT booking-policies omitting waiver fields preserves the stored config', { skip }, async () => {
  const before_ = await setPolicies({
    waiver_required: true,
    waiver_text: WAIVER_TEXT_B,
  });

  // A pre-waiver client PUTs only the classic fields.
  const res = await adminFetch('/api/admin/booking-policies', {
    method: 'PUT',
    body: JSON.stringify({
      free_cancel_hours_before: 48,
      min_advance_booking_minutes: 0,
      max_advance_booking_days: 730,
    }),
  });
  assert.equal(res.status, 200);
  const { booking_policies: after_ } = await res.json();
  assert.equal(after_.waiver_required, true);
  assert.equal(after_.waiver_text, WAIVER_TEXT_B);
  assert.equal(after_.waiver_version, before_.waiver_version);
});

// ============================================================
// walk-in inline capture
// ============================================================

test('walk-in booking without inline waiver → 409 with waiver code', { skip }, async () => {
  await setPolicies({ waiver_required: true });
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(walkInBody('2027-03-09T15:00:00.000Z')),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'waiver_signature_required');
});

test('walk-in inline waiver records the signature with the booking; repeats dedupe it', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const email = `walkin-${randomUUID()}@example.com`;

  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody('2027-03-10T15:00:00.000Z', {
        email,
        waiver: {
          signer_name: 'Walkin Signer',
          waiver_version: policies.waiver_version,
        },
      }),
    ),
  });
  assert.equal(res.status, 201);

  const r = await privilegedPool.query(
    `SELECT member_id, signer_name, waiver_version FROM waiver_signatures
      WHERE tenant_id = $1 AND customer_email = $2`,
    [tenant_id, email],
  );
  assert.equal(r.rows.length, 1, 'exactly one signature for the walk-in email');
  assert.equal(r.rows[0].member_id, null);
  assert.equal(r.rows[0].signer_name, 'Walkin Signer');
  assert.equal(r.rows[0].waiver_version, policies.waiver_version);

  // Second visit, same email, NO waiver payload — still 409. The gate
  // keys on config alone, NOT on prior-signature existence: branching
  // on "already signed" would let an unauthenticated caller probe
  // arbitrary emails for visit history (enumeration oracle).
  const resNoWaiver = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(walkInBody('2027-03-11T15:00:00.000Z', { email })),
  });
  assert.equal(resNoWaiver.status, 409);
  assert.equal((await resNoWaiver.json()).code, 'waiver_signature_required');

  // Second visit WITH the waiver payload again (the form always
  // renders it): booking succeeds, but no duplicate signature row.
  const res2 = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody('2027-03-11T15:00:00.000Z', {
        email,
        waiver: {
          signer_name: 'Walkin Signer',
          waiver_version: policies.waiver_version,
        },
      }),
    ),
  });
  assert.equal(res2.status, 201);
  const r2 = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM waiver_signatures
      WHERE tenant_id = $1 AND customer_email = $2`,
    [tenant_id, email],
  );
  assert.equal(r2.rows[0].n, 1, 'no duplicate signature on repeat visit');

  // Stale version echo (admin edited the waiver after the form
  // rendered) → 409 mismatch, nothing recorded.
  const resStale = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody('2027-03-12T15:00:00.000Z', {
        email,
        waiver: {
          signer_name: 'Walkin Signer',
          waiver_version: policies.waiver_version + 1,
        },
      }),
    ),
  });
  assert.equal(resStale.status, 409);
  assert.equal((await resStale.json()).code, 'waiver_version_mismatch');
});

test('failed walk-in booking rolls back the inline signature (same transaction)', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const slot = '2027-03-14T15:00:00.000Z';

  const first = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody(slot, {
        waiver: {
          signer_name: 'Slot Holder',
          waiver_version: policies.waiver_version,
        },
      }),
    ),
  });
  assert.equal(first.status, 201);

  // Same slot, different customer: booking fails, so the signature
  // must not survive (withTenantContext rolls back on >= 400).
  const loserEmail = `walkin-${randomUUID()}@example.com`;
  const second = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody(slot, {
        email: loserEmail,
        waiver: {
          signer_name: 'Slot Loser',
          waiver_version: policies.waiver_version,
        },
      }),
    ),
  });
  assert.equal(second.status, 409);

  const r = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM waiver_signatures
      WHERE tenant_id = $1 AND customer_email = $2`,
    [tenant_id, loserEmail],
  );
  assert.equal(r.rows[0].n, 0, 'signature must roll back with the failed booking');
});

test('walk-in inline waiver for a minor without guardian_name → 400', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });
  const res = await publicFetch('/api/customers/bookings', {
    method: 'POST',
    body: JSON.stringify(
      walkInBody('2027-03-13T15:00:00.000Z', {
        waiver: {
          signer_name: 'Junior Walkin',
          is_minor: true,
          waiver_version: policies.waiver_version,
        },
      }),
    ),
  });
  assert.equal(res.status, 400);
});

// ============================================================
// admin roster
// ============================================================

test('admin signatures list: member + walk-in rows, current_only filter', { skip }, async () => {
  const policies = await setPolicies({ waiver_required: true });

  const all = await adminFetch('/api/admin/waiver-signatures');
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.equal(allBody.waiver.required, true);
  assert.equal(allBody.waiver.version, policies.waiver_version);

  const memberRow = allBody.signatures.find((s) => s.member_id !== null);
  assert.ok(memberRow, 'expected at least one member signature');
  assert.equal(memberRow.member_first_name, 'Waiver');
  assert.equal(memberRow.member_last_name, 'Member');
  assert.ok(memberRow.member_email, 'member email joined onto the row');

  const walkInRow = allBody.signatures.find((s) => s.member_id === null);
  assert.ok(walkInRow, 'expected at least one walk-in signature');
  assert.ok(walkInRow.customer_email);

  // The version-bump test above left old-version rows behind, so the
  // unfiltered list must be strictly longer than current-only.
  assert.ok(
    allBody.signatures.some((s) => s.waiver_version !== policies.waiver_version),
    'expected old-version rows in the unfiltered list',
  );
  const current = await adminFetch('/api/admin/waiver-signatures?current_only=true');
  const currentBody = await current.json();
  assert.ok(currentBody.signatures.length > 0);
  assert.ok(currentBody.signatures.length < allBody.signatures.length);
  for (const s of currentBody.signatures) {
    assert.equal(s.waiver_version, policies.waiver_version);
  }
});

// ============================================================
// append-only privileges + RLS
// ============================================================

test('runtime role cannot UPDATE or DELETE waiver_signatures (append-only)', { skip }, async () => {
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenant_id],
    );
    // Sanity: SELECT works under the tenant GUC (signatures exist
    // from the tests above).
    const sel = await client.query(
      `SELECT count(*)::int AS n FROM waiver_signatures`,
    );
    assert.ok(sel.rows[0].n > 0, 'runtime role should be able to SELECT');

    await assert.rejects(
      () => client.query(`UPDATE waiver_signatures SET signer_name = 'Tampered'`),
      (err) => {
        assert.equal(err.code, '42501', `expected 42501, got ${err.code}`);
        return true;
      },
      'UPDATE must be denied — signatures are append-only',
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenant_id],
    );
    await assert.rejects(
      () => client.query(`DELETE FROM waiver_signatures`),
      (err) => {
        assert.equal(err.code, '42501', `expected 42501, got ${err.code}`);
        return true;
      },
      'DELETE must be denied — signatures are append-only',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('RLS: signatures are invisible and unwritable from another tenant context', { skip }, async () => {
  const otherSubdomain = `verify-waivers-other-${randomUUID().slice(0, 6)}`;
  const otherTid = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Other', 'UTC') RETURNING id`,
      [otherSubdomain],
    )
  ).rows[0].id;

  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [otherTid],
    );
    // Tenant A's signatures exist, but under tenant B's GUC the table
    // reads empty.
    const sel = await client.query(
      `SELECT count(*)::int AS n FROM waiver_signatures`,
    );
    assert.equal(sel.rows[0].n, 0, 'cross-tenant signatures must be invisible');

    // Writing a row stamped with tenant A's id under tenant B's GUC
    // violates the policy's WITH CHECK.
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO waiver_signatures
             (tenant_id, customer_email, signer_name, waiver_version)
           VALUES ($1, 'sneak@example.com', 'Sneaky', 1)`,
          [tenant_id],
        ),
      (err) => {
        assert.equal(err.code, '42501', `expected 42501, got ${err.code}`);
        return true;
      },
      'cross-tenant INSERT must be rejected by RLS',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await privilegedPool.query(`DELETE FROM tenants WHERE id = $1`, [otherTid]);
  }
});
