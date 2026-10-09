// Family accounts PR 3 — per-kid waivers (only for facilities that
// require waivers). A member's own booking needs the member's own
// signature; booking for a kid needs that kid's — signed by the parent
// as guardian. Neither covers the other.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { app } from '../src/app.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
const SUB = `fwv-${randomUUID().slice(0, 8)}`;

let server;
let baseUrl;
let priv;
let tenantId;
let adminToken;
const ids = {};
const dana = {};
const omar = {};

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
  await asTenant(`SELECT apply_credit_change($1, $2, 60, 'admin_adjustment')`, [tenantId, b.member_id]);
}

async function addKid(who, first, birthYear) {
  const r = await call(who.token, 'POST', '/api/me/dependents', {
    first_name: first,
    last_name: 'Rivera',
    ...(birthYear ? { birth_year: birthYear } : {}),
  });
  return (await r.json()).dependent.id;
}

let hourCursor = 7;
function nextSlot() {
  const d = new Date(Date.now() + 2 * 86400000);
  d.setUTCHours(hourCursor, 0, 0, 0);
  hourCursor += 1;
  return d.toISOString();
}

const book = (who, dependentId) =>
  call(who.token, 'POST', '/api/bookings', {
    offering_id: ids.offering,
    resource_id: ids.cage,
    start_time: nextSlot(),
    ...(dependentId ? { dependent_id: dependentId } : {}),
  });

const sign = (who, body) => call(who.token, 'POST', '/api/waivers/sign', { waiver_version: 1, ...body });

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(`INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Waiver Gym', 'UTC') RETURNING id`, [
      SUB,
    ])
  ).rows[0].id;
  await asTenant(
    `INSERT INTO booking_policies (tenant_id, waiver_required, waiver_text, waiver_version)
     VALUES ($1, true, 'Batting is dangerous.', 1)`,
    [tenantId],
  );
  ids.cage = (await asTenant(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage') RETURNING id`, [tenantId])).rows[0].id;
  for (let d = 0; d < 7; d += 1) {
    await asTenant(
      `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
       VALUES ($1, $2, $3, '06:00', '23:00')`,
      [tenantId, ids.cage, d],
    );
  }
  ids.offering = (
    await asTenant(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price, capacity,
                              allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cage 60', 'cage-time', 60, 1, 4000, 1, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  await asTenant(`INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`, [
    tenantId,
    ids.offering,
    ids.cage,
  ]);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  await register(dana, 'Dana');
  await register(omar, 'Omar');
  dana.leo = await addKid(dana, 'Leo', 2014);
  dana.ava = await addKid(dana, 'Ava', null);
  dana.uncle = await addKid(dana, 'Sam', 1980);
  omar.zed = await addKid(omar, 'Zed', 2015);

  const adminId = (
    await asTenant(`INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`, [
      tenantId,
      omar.userId,
    ])
  ).rows[0].id;
  adminToken = jwt.sign(
    { tenant_id: tenantId, user_id: omar.userId, member_id: omar.memberId, admin_id: adminId, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM waiver_signatures WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test("parent's own signature covers the parent, not the kid", { skip }, async () => {
  assert.equal((await sign(dana, { signer_name: 'Dana Rivera' })).status, 201);
  assert.equal((await book(dana)).status, 201);

  const res = await book(dana, dana.leo);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'waiver_signature_required');
  assert.equal(body.dependent_id, dana.leo);
  assert.match(body.error, /Leo needs a signed liability waiver/);
});

test('signing for a kid: guardian required; participant name + minor flag from the record', { skip }, async () => {
  assert.equal((await sign(dana, { signer_name: 'Leo', dependent_id: dana.leo })).status, 400);

  const res = await sign(dana, {
    signer_name: 'Someone Else Entirely', // ignored — taken from the dependent record
    guardian_name: 'Dana Rivera',
    dependent_id: dana.leo,
  });
  assert.equal(res.status, 201);
  const sig = (await res.json()).signature;
  assert.equal(sig.dependent_id, dana.leo);
  assert.equal(sig.signer_name, 'Leo Rivera');
  assert.equal(sig.guardian_name, 'Dana Rivera');
  assert.equal(sig.is_minor, true);

  assert.equal((await book(dana, dana.leo)).status, 201, 'Leo covered now');
  assert.equal((await book(dana, dana.ava)).status, 409, 'Ava still needs her own');
});

test('minor flag: unknown birth year = minor, 18+ = not', { skip }, async () => {
  const ava = await (await sign(dana, { signer_name: 'x', guardian_name: 'Dana Rivera', dependent_id: dana.ava })).json();
  assert.equal(ava.signature.is_minor, true);
  const sam = await (await sign(dana, { signer_name: 'x', guardian_name: 'Dana Rivera', dependent_id: dana.uncle })).json();
  assert.equal(sam.signature.is_minor, false);
});

test("a kid's signature doesn't cover the parent", { skip }, async () => {
  // Omar signs only for Zed.
  assert.equal(
    (await sign(omar, { signer_name: 'x', guardian_name: 'Omar Rivera', dependent_id: omar.zed })).status,
    201,
  );
  assert.equal((await book(omar, omar.zed)).status, 201);
  assert.equal((await book(omar)).status, 409);
});

test("can't sign for another household's kid; garbage id is a 400", { skip }, async () => {
  assert.equal(
    (await sign(dana, { signer_name: 'x', guardian_name: 'Dana Rivera', dependent_id: omar.zed })).status,
    404,
  );
  assert.equal(
    (await sign(dana, { signer_name: 'x', guardian_name: 'Dana Rivera', dependent_id: 'not-a-uuid' })).status,
    400,
  );
});

test('a waiver text change re-prompts kids too', { skip }, async () => {
  await asTenant(`UPDATE booking_policies SET waiver_version = 2 WHERE tenant_id = $1`, [tenantId]);
  try {
    assert.equal((await book(dana, dana.leo)).status, 409);
  } finally {
    await asTenant(`UPDATE booking_policies SET waiver_version = 1 WHERE tenant_id = $1`, [tenantId]);
  }
});

test('admin signature list names the participant', { skip }, async () => {
  const res = await call(adminToken, 'GET', '/api/admin/waiver-signatures');
  assert.equal(res.status, 200);
  const { signatures } = await res.json();
  const leo = signatures.find((s) => s.dependent_id === dana.leo);
  assert.equal(leo.participant_first_name, 'Leo');
  assert.equal(leo.member_first_name, 'Dana');
});
