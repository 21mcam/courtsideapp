// Family accounts PR 1 — dependents (migration 034).
//
// API: a member manages their own household's kids (add / edit /
// remove = deactivate), capped at 10; other households and staff-only
// users can't; removal is refused while the kid has upcoming bookings;
// admin member detail lists the family.
// Schema: a booking can only name the paying member's own dependent;
// walk-ins can't name one; siblings can share a class, the same kid
// can't hold two spots.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { app } from '../src/app.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
const SUB = `fam-${randomUUID().slice(0, 8)}`;

let server;
let baseUrl;
let priv;
let tenantId;
const dana = {};
const other = {};
let adminToken;
let resourceId;
let offeringId;
let classOfferingId;
let instanceId;

const url = (p) => `${baseUrl}${p}${p.includes('?') ? '&' : '?'}tenant=${SUB}`;
const call = (token, method, path, body) =>
  fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function asTenant(sql, params) {
  const c = await priv.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function register(who, email) {
  const res = await fetch(url('/api/auth/register-member'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'family-pass-123', first_name: 'Dana', last_name: 'Rivera' }),
  });
  assert.equal(res.status, 201);
  const b = await res.json();
  Object.assign(who, { token: b.token, memberId: b.member_id, userId: b.user_id });
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Family Gym', 'America/New_York') RETURNING id`,
      [SUB],
    )
  ).rows[0].id;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  await register(dana, `dana-${randomUUID()}@example.com`);
  await register(other, `other-${randomUUID()}@example.com`);

  const adminId = (
    await asTenant(`INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`, [
      tenantId,
      other.userId,
    ])
  ).rows[0].id;
  adminToken = jwt.sign(
    { tenant_id: tenantId, user_id: other.userId, member_id: null, admin_id: adminId, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );

  resourceId = (await asTenant(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage') RETURNING id`, [tenantId])).rows[0].id;
  offeringId = (
    await asTenant(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price, capacity,
                              allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cage 60', 'cage-time', 60, 3, 4000, 1, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  classOfferingId = (
    await asTenant(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price, capacity,
                              allow_member_booking, allow_public_booking)
       VALUES ($1, 'Clinic', 'classes', 60, 2, 2500, 10, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  for (const o of [offeringId, classOfferingId]) {
    await asTenant(`INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`, [
      tenantId,
      o,
      resourceId,
    ]);
  }
  const start = new Date(Date.now() + 5 * 86400000);
  instanceId = (
    await asTenant(
      `INSERT INTO class_instances (tenant_id, class_schedule_id, offering_id, resource_id, start_time, end_time, capacity)
       VALUES ($1, NULL, $2, $3, $4, $5, 10) RETURNING id`,
      [tenantId, classOfferingId, resourceId, start, new Date(start.getTime() + 3600000)],
    )
  ).rows[0].id;
});

after(async () => {
  if (skip) return;
  for (const t of ['class_bookings', 'class_instances', 'bookings', 'dependents']) {
    await priv.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
  }
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('member adds, lists, edits and their family stays private', { skip }, async () => {
  let res = await call(dana.token, 'POST', '/api/me/dependents', { first_name: ' Leo ', last_name: 'Rivera', birth_year: 2014 });
  assert.equal(res.status, 201);
  const leo = (await res.json()).dependent;
  assert.equal(leo.first_name, 'Leo');
  dana.leo = leo.id;

  res = await call(dana.token, 'POST', '/api/me/dependents', { first_name: 'Ava', last_name: 'Rivera' });
  dana.ava = (await res.json()).dependent.id;

  const list = await (await call(dana.token, 'GET', '/api/me/dependents')).json();
  assert.deepEqual(list.dependents.map((d) => d.first_name), ['Leo', 'Ava']);
  assert.equal(list.max, 10);

  res = await call(dana.token, 'PATCH', `/api/me/dependents/${dana.ava}`, { birth_year: 2016 });
  assert.equal((await res.json()).dependent.birth_year, 2016);
  res = await call(dana.token, 'PATCH', `/api/me/dependents/${dana.ava}`, { birth_year: null });
  assert.equal((await res.json()).dependent.birth_year, null);
  assert.equal((await call(dana.token, 'PATCH', `/api/me/dependents/${dana.ava}`, { birth_year: 1800 })).status, 400);

  // Another household sees nothing and can't touch Dana's kids.
  assert.deepEqual((await (await call(other.token, 'GET', '/api/me/dependents')).json()).dependents, []);
  assert.equal((await call(other.token, 'PATCH', `/api/me/dependents/${dana.leo}`, { first_name: 'X' })).status, 404);
  assert.equal((await call(other.token, 'DELETE', `/api/me/dependents/${dana.leo}`)).status, 404);

  // Staff-only identity can't create.
  assert.equal(
    (await call(adminToken, 'POST', '/api/me/dependents', { first_name: 'A', last_name: 'B' })).status,
    403,
  );
});

test('cap of 10 active family members', { skip }, async () => {
  const have = (await (await call(dana.token, 'GET', '/api/me/dependents')).json()).dependents.length;
  for (let i = have; i < 10; i += 1) {
    assert.equal((await call(dana.token, 'POST', '/api/me/dependents', { first_name: `Kid${i}`, last_name: 'R' })).status, 201);
  }
  const res = await call(dana.token, 'POST', '/api/me/dependents', { first_name: 'Eleven', last_name: 'R' });
  assert.equal(res.status, 409);
  // Clean the extras back out (no bookings → removable).
  const all = (await (await call(dana.token, 'GET', '/api/me/dependents')).json()).dependents;
  for (const d of all.filter((x) => x.first_name.startsWith('Kid'))) {
    assert.equal((await call(dana.token, 'DELETE', `/api/me/dependents/${d.id}`)).status, 200);
  }
});

test('schema: a booking can only name the payer’s own kid; walk-ins can’t name one', { skip }, async () => {
  const start = new Date(Date.now() + 3 * 86400000);
  const end = new Date(start.getTime() + 3600000);
  const memberBooking = (memberId, dependentId, s = start) =>
    asTenant(
      `INSERT INTO bookings (tenant_id, offering_id, resource_id, member_id, dependent_id, start_time, end_time,
                             status, amount_due_cents, credit_cost_charged, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', 0, 3, 'not_required') RETURNING id`,
      [tenantId, offeringId, resourceId, memberId, dependentId, s, new Date(s.getTime() + 3600000)],
    );

  // Another member naming Dana's kid → FK violation.
  await assert.rejects(memberBooking(other.memberId, dana.leo), { code: '23503' });

  // Walk-in naming a dependent → CHECK violation.
  await assert.rejects(
    asTenant(
      `INSERT INTO bookings (tenant_id, offering_id, resource_id, dependent_id, customer_first_name,
                             customer_last_name, customer_email, start_time, end_time, status,
                             amount_due_cents, payment_status)
       VALUES ($1, $2, $3, $4, 'W', 'K', 'w@example.com', $5, $6, 'confirmed', 4000, 'pending')`,
      [tenantId, offeringId, resourceId, dana.leo, start, end],
    ),
    { code: '23514' },
  );

  // Dana booking for Leo works; then Leo can't be removed.
  const b = (await memberBooking(dana.memberId, dana.leo)).rows[0].id;
  const blocked = await call(dana.token, 'DELETE', `/api/me/dependents/${dana.leo}`);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'has_upcoming_bookings');
  await asTenant(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_type = 'member' WHERE id = $1`,
    [b],
  );
});

test('schema: siblings share a class; the same kid can’t take two spots', { skip }, async () => {
  const spot = (dependentId) =>
    asTenant(
      `INSERT INTO class_bookings (tenant_id, class_instance_id, member_id, dependent_id, status,
                                   amount_due_cents, credit_cost_charged, payment_status)
       VALUES ($1, $2, $3, $4, 'confirmed', 0, 2, 'not_required') RETURNING id`,
      [tenantId, instanceId, dana.memberId, dependentId],
    );
  await spot(null); // Dana herself
  await spot(dana.leo);
  await spot(dana.ava);
  await assert.rejects(spot(dana.leo), { code: '23505' });
  await assert.rejects(spot(null), { code: '23505' });
});

test('admin member detail lists the family', { skip }, async () => {
  const res = await call(adminToken, 'GET', `/api/admin/members/${dana.memberId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.dependents.map((d) => d.first_name).sort(), ['Ava', 'Leo']);
});
