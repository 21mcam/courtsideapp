// Account self-service: PATCH /api/me/profile, POST /api/me/password,
// GET /api/me/credits.
//
// Proves: name edits land on BOTH users and members; phone set/clear;
// password change needs the current password, invalidates outstanding
// reset links, and the old password stops working; credit history is
// the member's own, newest first, with no staff notes; staff-only
// users get an empty history; read-only support sessions can't write.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { app } from '../src/app.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let priv;
const sub = `acct-${randomUUID().slice(0, 8)}`;
const other = `acct-o-${randomUUID().slice(0, 8)}`;
let tenantId;
let otherTenantId;
const member = { email: null, password: 'original-pass-1', token: null, id: null, userId: null };

const url = (path, s = sub) => `${baseUrl}${path}${path.includes('?') ? '&' : '?'}tenant=${s}`;
const json = (token, method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function register(s, email, password) {
  const res = await fetch(url('/api/auth/register-member', s), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, first_name: 'Pat', last_name: 'Hitter', phone: '555-0100' }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function credit(tId, memberId, amount, reason, note = null) {
  const c = await priv.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tId]);
    await c.query('SELECT apply_credit_change($1, $2, $3, $4, $5)', [tId, memberId, amount, reason, note]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
  tenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Acct', 'America/New_York') RETURNING id`,
      [sub],
    )
  ).rows[0].id;
  otherTenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Acct Other', 'America/New_York') RETURNING id`,
      [other],
    )
  ).rows[0].id;

  member.email = `pat-${randomUUID()}@example.com`;
  const r = await register(sub, member.email, member.password);
  member.token = r.token;
  member.id = r.member_id;
  member.userId = r.user_id;
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM tenants WHERE subdomain = ANY($1::text[])', [[sub, other]]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('profile: name updates users + members; phone sets and clears', { skip }, async () => {
  let res = await fetch(
    url('/api/me/profile'),
    json(member.token, 'PATCH', { first_name: ' Patricia ', last_name: 'Slugger', phone: '718-555-0199' }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.first_name, 'Patricia');
  assert.equal(body.member.phone, '718-555-0199');

  const m = await priv.query('SELECT first_name, last_name, phone FROM members WHERE id = $1', [member.id]);
  assert.deepEqual(m.rows[0], { first_name: 'Patricia', last_name: 'Slugger', phone: '718-555-0199' });

  const me = await (await fetch(url('/api/me'), json(member.token, 'GET'))).json();
  assert.equal(me.user.first_name, 'Patricia');
  assert.equal(me.memberships.member.phone, '718-555-0199');

  // Omitting phone leaves it; '' clears it.
  res = await fetch(url('/api/me/profile'), json(member.token, 'PATCH', { first_name: 'Pat', last_name: 'Slugger' }));
  assert.equal((await res.json()).member.phone, '718-555-0199');
  res = await fetch(url('/api/me/profile'), json(member.token, 'PATCH', { first_name: 'Pat', last_name: 'Slugger', phone: '' }));
  assert.equal((await res.json()).member.phone, null);

  res = await fetch(url('/api/me/profile'), json(member.token, 'PATCH', { first_name: '  ', last_name: 'X' }));
  assert.equal(res.status, 400);
});

test('password: needs the current password; old stops working; reset links die', { skip }, async () => {
  // An outstanding reset token that must be invalidated by the change.
  await priv.query(
    `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [tenantId, member.userId, `hash-${randomUUID()}`],
  );

  let res = await fetch(
    url('/api/me/password'),
    json(member.token, 'POST', { current_password: 'wrong-wrong', new_password: 'brand-new-pass-2' }),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /current password/);

  res = await fetch(
    url('/api/me/password'),
    json(member.token, 'POST', { current_password: member.password, new_password: 'short' }),
  );
  assert.equal(res.status, 400);

  res = await fetch(
    url('/api/me/password'),
    json(member.token, 'POST', { current_password: member.password, new_password: 'brand-new-pass-2' }),
  );
  assert.equal(res.status, 200);

  const login = (password) =>
    fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: member.email, password }),
    });
  assert.equal((await login(member.password)).status, 401);
  assert.equal((await login('brand-new-pass-2')).status, 200);

  const live = await priv.query(
    'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
    [member.userId],
  );
  assert.equal(live.rows[0].n, 0);
  member.password = 'brand-new-pass-2';
});

test('credits: own history, newest first, no staff notes, tenant-isolated', { skip }, async () => {
  await credit(tenantId, member.id, 10, 'admin_adjustment', 'internal: comped after complaint');
  await credit(tenantId, member.id, -3, 'manual', null);

  // A same-email member in ANOTHER tenant with its own ledger.
  const o = await register(other, member.email, 'other-pass-123');
  await credit(otherTenantId, o.member_id, 99, 'admin_adjustment');

  const res = await fetch(url('/api/me/credits'), json(member.token, 'GET'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.deepEqual(
    body.entries.map((e) => [e.amount, e.balance_after, e.reason]),
    [
      [-3, 7, 'manual'],
      [10, 10, 'admin_adjustment'],
    ],
  );
  assert.ok(body.entries.every((e) => !('note' in e)), 'staff notes never reach members');
});

test('credits: a staff-only user gets an empty history, not an error', { skip }, async () => {
  const token = jwt.sign(
    { tenant_id: tenantId, user_id: member.userId, member_id: null, admin_id: randomUUID(), role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
  const res = await fetch(url('/api/me/credits'), json(token, 'GET'));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).entries, []);
});

test('read-only support sessions cannot change profile or password', { skip }, async () => {
  const token = jwt.sign(
    {
      tenant_id: tenantId,
      user_id: member.userId,
      member_id: member.id,
      admin_id: null,
      role: 'member',
      read_only: true,
      support_admin_id: randomUUID(),
    },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
  const p = await fetch(url('/api/me/profile'), json(token, 'PATCH', { first_name: 'Hack', last_name: 'Er' }));
  assert.equal(p.status, 403);
  const w = await fetch(
    url('/api/me/password'),
    json(token, 'POST', { current_password: member.password, new_password: 'nope-nope-nope' }),
  );
  assert.equal(w.status, 403);
  // Reads still work.
  assert.equal((await fetch(url('/api/me/credits'), json(token, 'GET'))).status, 200);
});
