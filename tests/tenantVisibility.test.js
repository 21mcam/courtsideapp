// Tenant visibility (migration 035): private / unlisted / public.
//
// Proves: search engines are told to stay away from every non-public
// facility (robots.txt + X-Robots-Tag on HTML and API) and from the
// platform console; private facilities refuse public bookings and
// self-signup but still serve pages/data for staff preview; the
// platform console sets it, audited; new tenants start private.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

import { app } from '../src/app.js';
import { __clearCrawlerCache } from '../src/middleware/crawlerPolicy.js';
import { signPlatformSession } from '../src/middleware/platformAuth.js';
import { generateTotpSecret } from '../src/lib/totp.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
const SUB = `vis-${randomUUID().slice(0, 8)}`;

let server;
let baseUrl;
let priv;
let tenantId;
let adminId;
let platformToken;

const get = (path) => fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}tenant=${SUB}`);
const setVis = async (v) => {
  await priv.query('UPDATE tenants SET visibility = $1 WHERE id = $2', [v, tenantId]);
  __clearCrawlerCache();
};

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(`INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'Vis Gym', 'UTC') RETURNING id, visibility`, [
      SUB,
    ])
  ).rows[0].id;
  adminId = (
    await priv.query(
      `INSERT INTO platform_admins (email, display_name, password_hash, totp_secret)
       VALUES ($1, 'Vis Op', $2, $3) RETURNING id`,
      [`vis-${randomUUID()}@example.com`, await bcrypt.hash('x', 4), generateTotpSecret()],
    )
  ).rows[0].id;
  platformToken = signPlatformSession(adminId);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM platform_audit_log WHERE platform_admin_id = $1', [adminId]);
  await priv.query('DELETE FROM platform_admins WHERE id = $1', [adminId]);
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('platform-created facilities start private; raw inserts (seeds, fixtures) unlisted', { skip }, async () => {
  const r = await priv.query('SELECT visibility FROM tenants WHERE id = $1', [tenantId]);
  assert.equal(r.rows[0].visibility, 'unlisted');

  const sub = `visnew-${randomUUID().slice(0, 8)}`;
  const created = await priv.query(
    `SELECT tenant_id FROM create_tenant_with_owner($1, 'New Gym', 'UTC', $2, 'x', 'O', 'W')`,
    [sub, `o-${randomUUID()}@example.com`],
  );
  const v = await priv.query('SELECT visibility FROM tenants WHERE id = $1', [created.rows[0].tenant_id]);
  assert.equal(v.rows[0].visibility, 'private');
  await priv.query('DELETE FROM tenants WHERE subdomain = $1', [sub]);
});

test('robots.txt + noindex follow visibility; console and apex never indexed', { skip }, async () => {
  for (const v of ['private', 'unlisted']) {
    await setVis(v);
    const robots = await get('/robots.txt');
    assert.match(await robots.text(), /Disallow: \//, `${v} robots`);
    assert.equal((await get('/some/page')).headers.get('x-robots-tag'), 'noindex, nofollow', `${v} html`);
    assert.equal((await get('/api/tenant')).headers.get('x-robots-tag'), 'noindex, nofollow', `${v} api`);
  }

  await setVis('public');
  assert.match(await (await get('/robots.txt')).text(), /Allow: \//);
  assert.equal((await get('/some/page')).headers.get('x-robots-tag'), null);
  assert.equal((await get('/api/tenant')).headers.get('x-robots-tag'), null);

  // Bare host (apex) and the console host are never indexable.
  const apex = await fetch(`${baseUrl}/robots.txt`);
  assert.match(await apex.text(), /Disallow: \//);
  const consoleRobots = await fetch(`${baseUrl}/robots.txt?tenant=admin`);
  assert.match(await consoleRobots.text(), /Disallow: \//);
});

test('private: browsing works, public booking + self-signup refused', { skip }, async () => {
  await setVis('private');
  const t = await (await get('/api/tenant')).json();
  assert.equal(t.visibility, 'private');
  assert.equal((await get('/api/customers/offerings')).status, 200);
  assert.equal((await get('/api/customers/classes')).status, 200);

  const post = (path, body) =>
    fetch(`${baseUrl}${path}?tenant=${SUB}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const path of ['/api/customers/bookings', '/api/customers/class-bookings']) {
    const r = await post(path, {});
    assert.equal(r.status, 403, path);
    assert.equal((await r.json()).code, 'facility_not_open');
  }
  const reg = await post('/api/auth/register-member', {
    email: `x-${randomUUID()}@example.com`,
    password: 'password-123',
    first_name: 'X',
    last_name: 'Y',
  });
  assert.equal(reg.status, 403);

  // Unlisted opens them again (validation errors now, not 403).
  await setVis('unlisted');
  assert.equal((await post('/api/customers/bookings', {})).status, 400);
});

test('platform console sets visibility, audited; bad values refused', { skip }, async () => {
  const patch = (body) =>
    fetch(`${baseUrl}/api/platform/tenants/${tenantId}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformToken}` },
      body: JSON.stringify(body),
    });
  assert.equal((await patch({ visibility: 'secret' })).status, 400);
  const r = await patch({ visibility: 'private' });
  assert.equal(r.status, 200);

  const row = await priv.query('SELECT visibility FROM tenants WHERE id = $1', [tenantId]);
  assert.equal(row.rows[0].visibility, 'private');
  const audit = await priv.query(
    `SELECT detail FROM platform_audit_log WHERE tenant_id = $1 AND action = 'tenant.visibility_update'
      ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );
  assert.equal(audit.rows[0].detail.to, 'private');

  const list = await (
    await fetch(`${baseUrl}/api/platform/tenants`, { headers: { Authorization: `Bearer ${platformToken}` } })
  ).json();
  assert.equal(list.tenants.find((t) => t.id === tenantId).visibility, 'private');

  // No session → refused.
  const anon = await fetch(`${baseUrl}/api/platform/tenants/${tenantId}/visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility: 'public' }),
  });
  assert.equal(anon.status, 401);
});
