// "Add to Home Screen": per-tenant manifest + icon.
// Unit (pure builders) + HTTP (served per tenant, survives a billing
// lapse, right content types).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';

import { app } from '../src/app.js';
import { buildIconSvg, buildManifest, shortName } from '../src/lib/webManifest.js';

test('shortName keeps whole words within 12 chars', () => {
  assert.equal(shortName('Momentum'), 'Momentum');
  assert.equal(shortName('Sunset Park Baseball'), 'Sunset Park');
  assert.equal(shortName('Supercalifragilistic Gym'), 'Supercalifra');
  assert.equal(shortName('  Bay Ridge  '), 'Bay Ridge');
});

test('manifest installs as the facility, in its accent', () => {
  const m = buildManifest({ name: 'Sunset Park Baseball', theme_accent: 'court' });
  assert.equal(m.name, 'Sunset Park Baseball');
  assert.equal(m.short_name, 'Sunset Park');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#16a34a');
  assert.deepEqual(
    m.icons.map((i) => i.purpose),
    ['any', 'maskable'],
  );
  // Unknown/absent accent falls back to the default, never undefined.
  assert.equal(buildManifest({ name: 'X', theme_accent: null }).theme_color, '#4f46e5');
});

test('icon is the escaped initial on the accent color', () => {
  const svg = buildIconSvg({ name: 'sunset park', theme_accent: 'rose' });
  assert.match(svg, /fill="#e11d48"/);
  assert.match(svg, />S<\/text>/);
  // Leading punctuation skipped; markup can't be injected via the name.
  assert.match(buildIconSvg({ name: '<b>&co', theme_accent: 'indigo' }), />B<\/text>/);
  assert.match(buildIconSvg({ name: '★★★', theme_accent: 'indigo' }), />•<\/text>/);
});

// ---------- HTTP ----------

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
let server;
let baseUrl;
let priv;
const sub = `pwa-${randomUUID().slice(0, 8)}`;

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  // Lapsed trial: everything else on this tenant 402s.
  await priv.query(
    `INSERT INTO tenants (subdomain, name, timezone, theme_accent, trial_ends_at)
     VALUES ($1, 'Pwa Test Facility', 'America/New_York', 'emerald', now() - interval '1 day')`,
    [sub],
  );
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM tenants WHERE subdomain = $1', [sub]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('manifest + icon are served per tenant, even during a billing hold', { skip }, async () => {
  const blocked = await fetch(`${baseUrl}/api/customers/offerings?tenant=${sub}`);
  assert.equal(blocked.status, 402, 'precondition: tenant is on billing hold');

  const m = await fetch(`${baseUrl}/api/tenant/manifest.webmanifest?tenant=${sub}`);
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  const body = await m.json();
  assert.equal(body.name, 'Pwa Test Facility');
  assert.equal(body.theme_color, '#059669');

  const i = await fetch(`${baseUrl}/api/tenant/icon.svg?tenant=${sub}`);
  assert.equal(i.status, 200);
  assert.match(i.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await i.text(), />P<\/text>/);
});
