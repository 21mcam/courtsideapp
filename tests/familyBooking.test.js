// Family accounts PR 2 — booking FOR a family member through the real
// endpoints (member rentals, member classes, front desk), and the
// participant showing up where staff and parents look.
//
// Credits always come off the PARENT (member) — the money path is
// unchanged; dependent_id only records who attends.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { app } from '../src/app.js';
import { __clearSkippedEmails, __getSkippedEmails } from '../src/services/email.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
const SUB = `fbk-${randomUUID().slice(0, 8)}`;

let server;
let baseUrl;
let priv;
let tenantId;
let adminToken;
const ids = {};
const dana = {};
const other = {};

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

async function register(who, first) {
  const res = await fetch(url('/api/auth/register-member'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `${first.toLowerCase()}-${randomUUID()}@example.com`,
      password: 'family-pass-123',
      first_name: first,
      last_name: 'Rivera',
    }),
  });
  const b = await res.json();
  Object.assign(who, { token: b.token, memberId: b.member_id, userId: b.user_id });
  await asTenant(`SELECT apply_credit_change($1, $2, 50, 'admin_adjustment')`, [tenantId, b.member_id]);
}

// Tomorrow at a tenant-local hour, as UTC ISO (tenant is UTC here).
function slot(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Family Booking Gym', 'UTC') RETURNING id`,
      [SUB],
    )
  ).rows[0].id;
  await asTenant(`INSERT INTO booking_policies (tenant_id) VALUES ($1)`, [tenantId]);
  ids.cage = (await asTenant(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1') RETURNING id`, [tenantId])).rows[0].id;
  ids.field = (await asTenant(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Field') RETURNING id`, [tenantId])).rows[0].id;
  for (const r of [ids.cage, ids.field]) {
    for (let d = 0; d < 7; d += 1) {
      await asTenant(
        `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
         VALUES ($1, $2, $3, '06:00', '23:00')`,
        [tenantId, r, d],
      );
    }
  }
  ids.cageOffering = (
    await asTenant(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price, capacity,
                              allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cage 60', 'cage-time', 60, 3, 4000, 1, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  ids.classOffering = (
    await asTenant(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price, capacity,
                              allow_member_booking, allow_public_booking)
       VALUES ($1, 'Clinic', 'classes', 60, 2, 2500, 10, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  await asTenant(`INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`, [
    tenantId,
    ids.cageOffering,
    ids.cage,
  ]);
  await asTenant(`INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`, [
    tenantId,
    ids.classOffering,
    ids.field,
  ]);
  ids.instance = (
    await asTenant(
      `INSERT INTO class_instances (tenant_id, class_schedule_id, offering_id, resource_id, start_time, end_time, capacity)
       VALUES ($1, NULL, $2, $3, $4, $5, 10) RETURNING id`,
      [tenantId, ids.classOffering, ids.field, slot(3, 15), slot(3, 16)],
    )
  ).rows[0].id;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  await register(dana, 'Dana');
  await register(other, 'Omar');
  for (const [key, first] of [['leo', 'Leo'], ['ava', 'Ava']]) {
    const r = await call(dana.token, 'POST', '/api/me/dependents', { first_name: first, last_name: 'Rivera' });
    dana[key] = (await r.json()).dependent.id;
  }
  const r = await call(other.token, 'POST', '/api/me/dependents', { first_name: 'Zed', last_name: 'Other' });
  other.zed = (await r.json()).dependent.id;

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
});

after(async () => {
  if (skip) return;
  // Ledger rows reference bookings; the tenant cascade handles them.
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

const balance = async (memberId) =>
  (await priv.query(`SELECT current_credits FROM credit_balances WHERE member_id = $1`, [memberId])).rows[0]
    .current_credits;

test('member books a cage FOR a kid: parent pays, kid recorded, email says who', { skip }, async () => {
  __clearSkippedEmails();
  const before = await balance(dana.memberId);
  const res = await call(dana.token, 'POST', '/api/bookings', {
    offering_id: ids.cageOffering,
    resource_id: ids.cage,
    start_time: slot(2, 10),
    dependent_id: dana.leo,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.booking.dependent_id, dana.leo);
  assert.equal(body.booking.member_id, dana.memberId);
  assert.equal(await balance(dana.memberId), before - 3, 'credits come off the parent');

  await new Promise((r) => setTimeout(r, 50));
  const email = __getSkippedEmails().find((e) => /Booking confirmed/.test(e.subject));
  assert.match(email.text, /Who\s*:?\s*Leo Rivera/);

  const mine = await (await call(dana.token, 'GET', '/api/bookings/me')).json();
  assert.equal(mine.bookings.find((b) => b.id === body.booking.id).participant_first_name, 'Leo');
});

test('another household’s kid, or a removed kid, is refused', { skip }, async () => {
  const res = await call(dana.token, 'POST', '/api/bookings', {
    offering_id: ids.cageOffering,
    resource_id: ids.cage,
    start_time: slot(2, 12),
    dependent_id: other.zed,
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'family member not found');

  const tmp = (await (await call(dana.token, 'POST', '/api/me/dependents', { first_name: 'Tmp', last_name: 'R' })).json())
    .dependent.id;
  await call(dana.token, 'DELETE', `/api/me/dependents/${tmp}`);
  const gone = await call(dana.token, 'POST', '/api/bookings', {
    offering_id: ids.cageOffering,
    resource_id: ids.cage,
    start_time: slot(2, 13),
    dependent_id: tmp,
  });
  assert.equal(gone.status, 404);
});

test('class: parent + both kids get spots; a kid can’t take two', { skip }, async () => {
  for (const dep of [null, dana.leo, dana.ava]) {
    const res = await call(dana.token, 'POST', '/api/class-bookings', {
      class_instance_id: ids.instance,
      ...(dep ? { dependent_id: dep } : {}),
    });
    assert.equal(res.status, 201, `spot for ${dep ?? 'Dana'}`);
  }
  const dup = await call(dana.token, 'POST', '/api/class-bookings', {
    class_instance_id: ids.instance,
    dependent_id: dana.leo,
  });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'Leo already has a spot in this class');

  const mine = await (await call(dana.token, 'GET', '/api/class-bookings/me')).json();
  assert.deepEqual(
    mine.class_bookings.map((c) => c.participant_first_name).sort(),
    ['Ava', 'Leo', null].sort(),
  );

  const roster = await (await call(adminToken, 'GET', `/api/admin/class-instances/${ids.instance}/roster`)).json();
  assert.deepEqual(
    roster.roster.map((r) => r.participant_first_name ?? r.member_first_name).sort(),
    ['Ava', 'Dana', 'Leo'],
  );
});

test('front desk books a member’s kid; admin list carries the participant', { skip }, async () => {
  const start = slot(4, 9);
  const end = slot(4, 10);
  const res = await call(adminToken, 'POST', '/api/admin/bookings', {
    offering_id: ids.cageOffering,
    resource_id: ids.cage,
    start_time: start,
    end_time: end,
    member_id: dana.memberId,
    dependent_id: dana.ava,
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).booking.dependent_id, dana.ava);

  const bad = await call(adminToken, 'POST', '/api/admin/bookings', {
    offering_id: ids.cageOffering,
    resource_id: ids.cage,
    start_time: slot(4, 12),
    end_time: slot(4, 13),
    member_id: dana.memberId,
    dependent_id: other.zed,
  });
  assert.equal(bad.status, 404);

  const list = await (
    await call(adminToken, 'GET', `/api/admin/bookings?from=${encodeURIComponent(slot(4, 0))}&to=${encodeURIComponent(slot(5, 0))}`)
  ).json();
  const row = list.bookings.find((b) => b.start_time === start);
  assert.equal(row.participant_first_name, 'Ava');
  assert.equal(row.member_first_name, 'Dana');
});
