// Operating hours + booking policies admin tests — Phase 3 prep.
//
// Six tests:
//   1. Create operating_hours row → 201, list reflects it
//   2. Overlapping hours on same (resource, day) → 409
//      (schema's GiST exclusion constraint)
//   3. Delete operating_hours row → list empty
//   4. GET booking_policies on a tenant with no row → returns
//      schema defaults with exists: false
//   5. PUT booking_policies — UPSERT inserts then updates
//   6. PUT with half-set partial_refund (one of hours/percent
//      provided, the other null) → 400 (schema CHECK)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-operations';
const OTHER_TENANT = 'verify-operations-other';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let adminToken;
let otherAdminToken;
let resource_id;
let offering_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Operations Tests', 'America/New_York'),
            ($2, 'Operations Other', 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, OTHER_TENANT],
  );
  const t = await privilegedPool.query(
    `SELECT subdomain, id FROM tenants WHERE subdomain IN ($1, $2)`,
    [TENANT, OTHER_TENANT],
  );
  const byId = Object.fromEntries(t.rows.map((r) => [r.subdomain, r.id]));
  const tenant_id = byId[TENANT];
  const other_tenant_id = byId[OTHER_TENANT];

  // Admin owner via privileged pool (no member row, no booking_policies
  // row — we want to test the GET-with-defaults path.)
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

  // Admin owner for the OTHER tenant — used for cross-tenant isolation
  // tests below.
  const otherAdminEmail = `admin-other-${randomUUID()}@example.com`;
  const otherAdminPassword = 'correcthorsebatterystaple';
  const ou = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Other', 'Admin') RETURNING id`,
    [other_tenant_id, otherAdminEmail, await bcrypt.hash(otherAdminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [other_tenant_id, ou.rows[0].id],
  );

  // Pre-create one resource via privileged pool — needed for
  // operating_hours / blackouts (resource_id) FK.
  const r = await privilegedPool.query(
    `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1')
     RETURNING id`,
    [tenant_id],
  );
  resource_id = r.rows[0].id;

  // Pre-create one offering — needed for blackouts (offering_id) FK
  // tests. Capacity 1 = rental shape, fine for these tests.
  const o = await privilegedPool.query(
    `INSERT INTO offerings
       (tenant_id, name, category, duration_minutes, credit_cost,
        dollar_price, allow_member_booking)
     VALUES ($1, 'Half hour', 'cage-time', 30, 1, 3000, true)
     RETURNING id`,
    [tenant_id],
  );
  offering_id = o.rows[0].id;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) throw new Error(`admin login failed: HTTP ${loginRes.status}`);
  adminToken = (await loginRes.json()).token;

  const otherLoginRes = await fetch(
    `${baseUrl}/api/auth/login?tenant=${OTHER_TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: otherAdminEmail, password: otherAdminPassword }),
    },
  );
  if (!otherLoginRes.ok) throw new Error(`other admin login failed: HTTP ${otherLoginRes.status}`);
  otherAdminToken = (await otherLoginRes.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain IN ($1, $2)`,
      [TENANT, OTHER_TENANT],
    );
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function adminFetch(path, init = {}) {
  // Paths may already contain a query string (e.g. `?resource_id=`).
  // Use `&` as the separator in that case so `tenant=` ends up as a
  // distinct query param, not a value on a prior one.
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
// operating_hours
// ============================================================

test('admin can create operating_hours; list reflects', { skip }, async () => {
  const createRes = await adminFetch('/api/admin/operating-hours', {
    method: 'POST',
    body: JSON.stringify({
      resource_id,
      day_of_week: 1, // Monday
      open_time: '09:00',
      close_time: '17:00',
    }),
  });
  assert.equal(createRes.status, 201);
  const { operating_hours } = await createRes.json();
  assert.equal(operating_hours.day_of_week, 1);
  // Postgres returns time as 'HH:MM:SS' even when input was 'HH:MM'.
  assert.match(operating_hours.open_time, /^09:00/);

  const listRes = await adminFetch(
    `/api/admin/operating-hours?resource_id=${resource_id}`,
  );
  const body = await listRes.json();
  assert.ok(body.operating_hours.some((r) => r.id === operating_hours.id));
});

test('overlapping hours on same (resource, day) → 409', { skip }, async () => {
  // Day 2 (Tuesday) — fresh slot to avoid colliding with Monday from
  // the prior test.
  await adminFetch('/api/admin/operating-hours', {
    method: 'POST',
    body: JSON.stringify({
      resource_id,
      day_of_week: 2,
      open_time: '10:00',
      close_time: '12:00',
    }),
  });
  const dupeRes = await adminFetch('/api/admin/operating-hours', {
    method: 'POST',
    body: JSON.stringify({
      resource_id,
      day_of_week: 2,
      open_time: '11:00',
      close_time: '13:00', // overlaps 10:00-12:00
    }),
  });
  assert.equal(dupeRes.status, 409);
});

test('admin can delete operating_hours', { skip }, async () => {
  // Create on a free day, then delete.
  const createRes = await adminFetch('/api/admin/operating-hours', {
    method: 'POST',
    body: JSON.stringify({
      resource_id,
      day_of_week: 3,
      open_time: '08:00',
      close_time: '20:00',
    }),
  });
  const { operating_hours: row } = await createRes.json();

  const delRes = await adminFetch(`/api/admin/operating-hours/${row.id}`, {
    method: 'DELETE',
  });
  assert.equal(delRes.status, 200);

  const listRes = await adminFetch(
    `/api/admin/operating-hours?resource_id=${resource_id}`,
  );
  const body = await listRes.json();
  assert.ok(!body.operating_hours.some((r) => r.id === row.id));
});

// ============================================================
// booking_policies
// ============================================================

test('GET booking_policies on tenant with no row returns defaults + exists:false', { skip }, async () => {
  const res = await adminFetch('/api/admin/booking-policies');
  assert.equal(res.status, 200);
  const { booking_policies } = await res.json();
  assert.equal(booking_policies.exists, false);
  // Schema defaults
  assert.equal(booking_policies.free_cancel_hours_before, 24);
  assert.equal(booking_policies.no_show_action, 'none');
  assert.equal(booking_policies.max_advance_booking_days, 30);
});

test('PUT booking_policies — INSERT then UPDATE on second call', { skip }, async () => {
  const insertRes = await adminFetch('/api/admin/booking-policies', {
    method: 'PUT',
    body: JSON.stringify({
      free_cancel_hours_before: 48,
      no_show_action: 'forfeit_credits',
      max_advance_booking_days: 60,
    }),
  });
  assert.equal(insertRes.status, 200);
  const { booking_policies: first } = await insertRes.json();
  assert.equal(first.exists, true);
  assert.equal(first.free_cancel_hours_before, 48);
  assert.equal(first.no_show_action, 'forfeit_credits');

  // GET reflects the inserted row
  const getRes = await adminFetch('/api/admin/booking-policies');
  const { booking_policies: viewed } = await getRes.json();
  assert.equal(viewed.exists, true);
  assert.equal(viewed.free_cancel_hours_before, 48);

  // Second PUT updates (UPSERT path)
  const updateRes = await adminFetch('/api/admin/booking-policies', {
    method: 'PUT',
    body: JSON.stringify({
      free_cancel_hours_before: 12,
      no_show_action: 'none',
    }),
  });
  const { booking_policies: second } = await updateRes.json();
  assert.equal(second.free_cancel_hours_before, 12);
  assert.equal(second.no_show_action, 'none');
});

test('PUT booking_policies with half-set partial_refund → 400', { skip }, async () => {
  // Schema CHECK: partial_refund_hours_before and partial_refund_percent
  // must both be set or both null.
  const res = await adminFetch('/api/admin/booking-policies', {
    method: 'PUT',
    body: JSON.stringify({
      partial_refund_hours_before: 12,
      // partial_refund_percent intentionally omitted
    }),
  });
  assert.equal(res.status, 400);
});

// ============================================================
// blackouts
// ============================================================

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 1 week out
const FUTURE_END = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000); // 1 week + 1 day

test('facility-wide blackout (both targets null) → 201', { skip }, async () => {
  const res = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      starts_at: FUTURE.toISOString(),
      ends_at: FUTURE_END.toISOString(),
      reason: 'Facility closed for holiday',
    }),
  });
  assert.equal(res.status, 201);
  const { blackout } = await res.json();
  assert.ok(blackout.id);
  assert.equal(blackout.resource_id, null);
  assert.equal(blackout.offering_id, null);
  assert.equal(blackout.reason, 'Facility closed for holiday');

  const listRes = await adminFetch('/api/admin/blackouts');
  const body = await listRes.json();
  assert.ok(body.blackouts.some((b) => b.id === blackout.id));
});

test('resource-only blackout → 201, list filterable by resource_id', { skip }, async () => {
  const res = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      starts_at: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      resource_id,
      reason: 'Cage 1 maintenance',
    }),
  });
  assert.equal(res.status, 201);
  const { blackout } = await res.json();
  assert.equal(blackout.resource_id, resource_id);
  assert.equal(blackout.offering_id, null);

  // ?resource_id= filter returns the row
  const filtered = await adminFetch(
    `/api/admin/blackouts?resource_id=${resource_id}`,
  );
  const body = await filtered.json();
  assert.ok(body.blackouts.some((b) => b.id === blackout.id));
  // All filtered rows are for that resource
  for (const row of body.blackouts) {
    assert.equal(row.resource_id, resource_id);
  }
});

test('offering-only blackout → 201, list filterable by offering_id', { skip }, async () => {
  const res = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      starts_at: new Date(Date.now() + 11 * 24 * 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
      offering_id,
      reason: 'Pause this offering',
    }),
  });
  assert.equal(res.status, 201);
  const { blackout } = await res.json();
  assert.equal(blackout.resource_id, null);
  assert.equal(blackout.offering_id, offering_id);

  const filtered = await adminFetch(
    `/api/admin/blackouts?offering_id=${offering_id}`,
  );
  const body = await filtered.json();
  assert.ok(body.blackouts.some((b) => b.id === blackout.id));
});

test('blackout with both resource_id and offering_id → 400', { skip }, async () => {
  const res = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      starts_at: FUTURE.toISOString(),
      ends_at: FUTURE_END.toISOString(),
      resource_id,
      offering_id,
      reason: 'invalid combo',
    }),
  });
  assert.equal(res.status, 400);
});

test('tenant isolation: blackouts in tenant A are invisible from tenant B', { skip }, async () => {
  // Create a uniquely-tagged blackout in tenant A.
  const reason = `isolation-marker-${randomUUID()}`;
  const createRes = await adminFetch('/api/admin/blackouts', {
    method: 'POST',
    body: JSON.stringify({
      starts_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      reason,
    }),
  });
  assert.equal(createRes.status, 201);
  const { blackout } = await createRes.json();

  // List from tenant B's admin must NOT see it.
  const otherList = await fetch(
    `${baseUrl}/api/admin/blackouts?tenant=${OTHER_TENANT}`,
    { headers: { Authorization: `Bearer ${otherAdminToken}` } },
  );
  assert.equal(otherList.status, 200);
  const otherBody = await otherList.json();
  assert.ok(
    !otherBody.blackouts.some((b) => b.id === blackout.id),
    'blackout from tenant A must not appear in tenant B list',
  );
  assert.ok(
    !otherBody.blackouts.some((b) => b.reason === reason),
    'no row with the unique marker reason should be visible cross-tenant',
  );

  // DELETE from tenant B's admin must 404 (RLS hides the row, so it
  // doesn't exist from tenant B's perspective).
  const otherDelete = await fetch(
    `${baseUrl}/api/admin/blackouts/${blackout.id}?tenant=${OTHER_TENANT}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${otherAdminToken}` },
    },
  );
  assert.equal(otherDelete.status, 404, 'cross-tenant DELETE must 404, not 200');

  // Sanity: tenant A can still see + delete its own row.
  const sameTenantDelete = await adminFetch(`/api/admin/blackouts/${blackout.id}`, {
    method: 'DELETE',
  });
  assert.equal(sameTenantDelete.status, 200);
});
