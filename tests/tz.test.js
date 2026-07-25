// Unit tests for client/src/lib/tz.js — the tenant-timezone helpers
// behind AdminBookings' query window and AdminClasses' one-off form.
//
// Regression context: the admin UI used to interpret wall-clock input
// in the BROWSER's timezone (new Date('...T00:00'), setHours(0)),
// which is invisible when the viewer's zone matches the tenant's and
// silently wrong otherwise (verified live: a Tokyo browser created a
// "6:00 PM" class instance at 5:00 AM tenant time). These helpers are
// pure Intl math — process TZ must not affect them, so we exercise
// them against fixed expected instants.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zonedTimeToUtc,
  zonedDayStartIso,
  localDateString,
  addDays,
} from '../client/src/lib/tz.js';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

test('NY summer (EDT, UTC-4): 18:00 wall clock → 22:00Z', () => {
  assert.equal(
    zonedTimeToUtc('2026-07-18', '18:00', NY).toISOString(),
    '2026-07-18T22:00:00.000Z',
  );
});

test('NY winter (EST, UTC-5): 18:00 wall clock → 23:00Z', () => {
  assert.equal(
    zonedTimeToUtc('2026-01-15', '18:00', NY).toISOString(),
    '2026-01-15T23:00:00.000Z',
  );
});

test('Tokyo (UTC+9, no DST): 09:00 wall clock → 00:00Z', () => {
  assert.equal(
    zonedTimeToUtc('2026-07-18', '09:00', TOKYO).toISOString(),
    '2026-07-18T00:00:00.000Z',
  );
});

test('tenant-local midnight, not viewer-local midnight', () => {
  // The exact bug: AdminBookings' default "from" was browser-local
  // midnight. Tenant-local midnight for NY on 2026-07-16 is 04:00Z —
  // a Tokyo viewer's local midnight would be 15:00Z the day before.
  assert.equal(zonedDayStartIso('2026-07-16', NY), '2026-07-16T04:00:00.000Z');
  assert.equal(zonedDayStartIso('2026-07-16', TOKYO), '2026-07-15T15:00:00.000Z');
});

test('DST spring-forward day: day start stays midnight, 2:30 resolves post-transition', () => {
  // 2026-03-08 America/New_York: clocks jump 02:00 → 03:00.
  assert.equal(zonedDayStartIso('2026-03-08', NY), '2026-03-08T05:00:00.000Z');
  // 02:30 does not exist; resolve with the post-transition offset.
  assert.equal(
    zonedTimeToUtc('2026-03-08', '02:30', NY).toISOString(),
    '2026-03-08T06:30:00.000Z',
  );
});

test('DST fall-back day: day start uses pre-transition (EDT) offset', () => {
  // 2026-11-01 America/New_York: clocks fall back 02:00 → 01:00.
  assert.equal(zonedDayStartIso('2026-11-01', NY), '2026-11-01T04:00:00.000Z');
});

test('localDateString renders the tenant-local calendar day', () => {
  // 2026-07-16T02:00Z is Jul 15 in NY, Jul 16 in Tokyo.
  assert.equal(localDateString('2026-07-16T02:00:00.000Z', NY), '2026-07-15');
  assert.equal(localDateString('2026-07-16T02:00:00.000Z', TOKYO), '2026-07-16');
});

test('addDays is pure calendar math (month/year rollover)', () => {
  assert.equal(addDays('2026-07-16', 7), '2026-07-23');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('round trip: instant → tenant date → tenant day start contains the instant', () => {
  const instant = new Date('2026-07-16T03:59:00.000Z'); // 11:59 PM Jul 15 NY
  const day = localDateString(instant, NY);
  assert.equal(day, '2026-07-15');
  const start = new Date(zonedDayStartIso(day, NY)).getTime();
  const end = new Date(zonedDayStartIso(addDays(day, 1), NY)).getTime();
  assert.ok(start <= instant.getTime() && instant.getTime() < end);
});

// ============================================================
// client/server parity
// ============================================================
//
// src/lib/tz.js is a deliberate backend duplicate of the client
// helpers (the server must never import from client/src — a client
// refactor would crash the API at module load). These checks fail
// loudly if the two copies drift.

import * as serverTz from '../src/lib/tz.js';

test('server copy of tz helpers agrees with the client copy', () => {
  const cases = [
    ['2026-07-18', '18:00', NY],
    ['2026-01-15', '18:00', NY],
    ['2026-03-08', '02:30', NY], // spring-forward gap
    ['2026-11-01', '01:30', NY], // fall-back overlap
    ['2026-07-18', '09:00', TOKYO],
  ];
  for (const [d, t, tz] of cases) {
    assert.equal(
      serverTz.zonedTimeToUtc(d, t, tz).toISOString(),
      zonedTimeToUtc(d, t, tz).toISOString(),
      `zonedTimeToUtc(${d}, ${t}, ${tz})`,
    );
  }
  const instants = [
    '2026-07-18T22:00:00.000Z',
    '2026-01-16T04:59:00.000Z',
    '2026-12-31T23:30:00.000Z',
  ];
  for (const iso of instants) {
    for (const tz of [NY, TOKYO]) {
      assert.equal(
        serverTz.localDateString(iso, tz),
        localDateString(iso, tz),
        `localDateString(${iso}, ${tz})`,
      );
    }
  }
  for (const [d, n] of [
    ['2026-02-28', 1],
    ['2026-12-31', 1],
    ['2026-01-31', -31],
    ['2026-03-15', -90],
  ]) {
    assert.equal(serverTz.addDays(d, n), addDays(d, n), `addDays(${d}, ${n})`);
  }
});
