// Shareable booking-page links — pure unit tests across BOTH halves
// of the feature. No DB, no browser.
//
// The point of testing them together: the server builds the absolute
// base (src/lib/publicUrl.js) and the admin UI appends the per-service
// query string (client/src/lib/bookingLinks.js). If those two ever
// disagree — different path, different param name — tenants would be
// handing out links that dump customers back on the service list. The
// param name is also the same one parseWalkInParams reads back out,
// which tests/walkinParams.test.js covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { buildBookingUrl, tenantUrl } from '../src/lib/publicUrl.js';
import tenantRouter from '../src/routes/tenant.js';
import {
  bookingPageUrl,
  displayUrl,
  serviceBookingUrl,
} from '../client/src/lib/bookingLinks.js';
import { parseWalkInParams } from '../client/src/lib/walkinParams.js';

const OFFERING_ID = '33333333-3333-4333-8333-333333333333';
const TZ = 'America/New_York';

// Restore key-by-key rather than reassigning process.env — replacing
// the object drops its special copy-to-child-process behavior.
function withEnv(env, fn) {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('buildBookingUrl matches the hostname shape resolveTenant parses', () => {
  withEnv({ NODE_ENV: 'production', APP_HOSTNAME: 'courtside.app' }, () => {
    assert.equal(
      buildBookingUrl('momentum'),
      'https://momentum.courtside.app/walk-in',
    );
    // Same base as every other tenant link.
    assert.equal(
      buildBookingUrl('momentum'),
      tenantUrl('momentum', '/walk-in'),
    );
  });
});

test('buildBookingUrl keeps the Vite dev port in local dev', () => {
  withEnv({ NODE_ENV: 'development', APP_HOSTNAME: 'localhost' }, () => {
    assert.equal(
      buildBookingUrl('momentum'),
      'http://momentum.localhost:5173/walk-in',
    );
  });
});

test('buildBookingUrl deep-links a single service', () => {
  withEnv({ NODE_ENV: 'production', APP_HOSTNAME: 'courtside.app' }, () => {
    assert.equal(
      buildBookingUrl('momentum', OFFERING_ID),
      `https://momentum.courtside.app/walk-in?service=${OFFERING_ID}`,
    );
  });
});

test('client serviceBookingUrl agrees with the server constructor', () => {
  withEnv({ NODE_ENV: 'production', APP_HOSTNAME: 'courtside.app' }, () => {
    const tenant = { booking_url: buildBookingUrl('momentum') };
    assert.equal(
      serviceBookingUrl(tenant, OFFERING_ID),
      buildBookingUrl('momentum', OFFERING_ID),
    );
  });
});

test('a shared service link parses back to the time step', () => {
  const tenant = { booking_url: 'https://momentum.courtside.app/walk-in' };
  const url = new URL(serviceBookingUrl(tenant, OFFERING_ID));
  const offerings = [
    {
      id: OFFERING_ID,
      category: 'cage-time',
      resources: [{ id: '11111111-1111-4111-8111-111111111111' }],
    },
  ];
  const parsed = parseWalkInParams(url.searchParams, offerings, TZ);
  // The whole point of the link: customer lands on the time picker for
  // that service, not back on the service list.
  assert.equal(parsed.step, 'time');
  assert.equal(parsed.offering.id, OFFERING_ID);
});

test('no offering id degrades to the plain booking page', () => {
  const tenant = { booking_url: 'https://momentum.courtside.app/walk-in' };
  assert.equal(serviceBookingUrl(tenant, null), tenant.booking_url);
  assert.equal(serviceBookingUrl(tenant, undefined), tenant.booking_url);
});

test('bookingPageUrl falls back to a relative path with no server value and no window', () => {
  // Node has no window — the browser fallback (location.origin) can't
  // apply, so it degrades to the path rather than throwing or
  // fabricating a host.
  assert.equal(bookingPageUrl({}), '/walk-in');
  assert.equal(bookingPageUrl(null), '/walk-in');
});

// GET /api/tenant needs no DB (resolveTenant already populated
// req.tenant), so the real router can be mounted behind a stub
// middleware and driven over HTTP — no Supabase, no fixtures.
test('GET /api/tenant serves booking_url to the admin UI', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.tenant = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      subdomain: 'momentum',
      name: 'Momentum Baseball',
      timezone: TZ,
    };
    next();
  });
  app.use('/api/tenant', tenantRouter);

  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/tenant`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.booking_url, buildBookingUrl('momentum'));
    // Absolute — the whole point is that it's pasteable.
    assert.match(body.booking_url, /^https?:\/\/momentum\./);
    assert.ok(body.booking_url.endsWith('/walk-in'));
  } finally {
    server.close();
  }
});

test('displayUrl strips only the scheme', () => {
  assert.equal(
    displayUrl('https://momentum.courtside.app/walk-in'),
    'momentum.courtside.app/walk-in',
  );
  assert.equal(
    displayUrl('http://momentum.localhost:5173/walk-in'),
    'momentum.localhost:5173/walk-in',
  );
  assert.equal(displayUrl(null), '');
});
