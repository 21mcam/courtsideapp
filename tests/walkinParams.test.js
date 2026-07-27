// Pure unit tests for the walk-in flow's URL-state helpers
// (client/src/lib/walkinParams.js) — same node --test pattern as
// availabilityMerge.test.js. No DB, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSections,
  buildWalkInParams,
  dayStripDates,
  normalizeFullName,
  parseWalkInParams,
  tenantLocalDate,
} from '../client/src/lib/walkinParams.js';
import { ANY_RESOURCE } from '../client/src/lib/availability.js';

const TZ = 'America/New_York';

const CAGE_A = '11111111-1111-4111-8111-111111111111';
const CAGE_B = '22222222-2222-4222-8222-222222222222';
const OFFER_MULTI = '33333333-3333-4333-8333-333333333333';
const OFFER_SINGLE = '44444444-4444-4444-8444-444444444444';

const OFFERINGS = [
  {
    id: OFFER_MULTI,
    name: '60-min Cage',
    category: 'cage-time',
    dollar_price: 6000,
    duration_minutes: 60,
    resources: [
      { id: CAGE_A, name: 'Cage A' },
      { id: CAGE_B, name: 'Cage B' },
    ],
  },
  {
    id: OFFER_SINGLE,
    name: 'HitTrax Session',
    category: 'hittrax',
    dollar_price: 9000,
    duration_minutes: 60,
    resources: [{ id: CAGE_B, name: 'Cage B' }],
  },
];

function params(obj) {
  return new URLSearchParams(obj);
}

// ---------- normalizeFullName ----------

test('normalizeFullName trims and collapses whitespace', () => {
  assert.equal(normalizeFullName('  Mia   Lopez '), 'Mia Lopez');
  assert.equal(normalizeFullName(''), '');
  assert.equal(normalizeFullName(null), '');
});

// ---------- parseWalkInParams ----------

test('no params → services step', () => {
  const s = parseWalkInParams(params({}), OFFERINGS, TZ);
  assert.equal(s.step, 'services');
  assert.equal(s.offering, null);
  assert.equal(s.slotStart, null);
});

test('valid service → time step with defaults', () => {
  const s = parseWalkInParams(params({ service: OFFER_MULTI }), OFFERINGS, TZ);
  assert.equal(s.step, 'time');
  assert.equal(s.offering.id, OFFER_MULTI);
  assert.equal(s.date, tenantLocalDate(TZ));
  // Multi-resource offering defaults to "No preference".
  assert.equal(s.resourceId, ANY_RESOURCE);
});

test('single-resource offering defaults to its lone resource', () => {
  const s = parseWalkInParams(params({ service: OFFER_SINGLE }), OFFERINGS, TZ);
  assert.equal(s.resourceId, CAGE_B);
});

test('unknown service id restarts at services', () => {
  const s = parseWalkInParams(
    params({ service: randomUuidLike(), slot: '2027-08-02T15:00:00.000Z' }),
    OFFERINGS,
    TZ,
  );
  assert.equal(s.step, 'services');
  assert.equal(s.slotStart, null);
});

test('malformed / past date falls back to tenant-today', () => {
  for (const bad of ['not-a-date', '2020-01-01', '2027-13-99']) {
    const s = parseWalkInParams(
      params({ service: OFFER_MULTI, date: bad }),
      OFFERINGS,
      TZ,
    );
    assert.equal(s.date, tenantLocalDate(TZ));
  }
});

test('resource param must belong to the offering', () => {
  const s = parseWalkInParams(
    params({ service: OFFER_SINGLE, res: CAGE_A }),
    OFFERINGS,
    TZ,
  );
  // Cage A doesn't run the single offering → default (Cage B).
  assert.equal(s.resourceId, CAGE_B);
  // 'any' is only meaningful with a real choice.
  const s2 = parseWalkInParams(
    params({ service: OFFER_SINGLE, res: 'any' }),
    OFFERINGS,
    TZ,
  );
  assert.equal(s2.resourceId, CAGE_B);
});

test('valid slot → details step; garbage slot → time step', () => {
  const good = parseWalkInParams(
    params({ service: OFFER_MULTI, slot: '2027-08-02T15:00:00.000Z' }),
    OFFERINGS,
    TZ,
  );
  assert.equal(good.step, 'details');
  assert.equal(good.slotStart, '2027-08-02T15:00:00.000Z');

  const bad = parseWalkInParams(
    params({ service: OFFER_MULTI, slot: 'yesterday-ish' }),
    OFFERINGS,
    TZ,
  );
  assert.equal(bad.step, 'time');
  assert.equal(bad.slotStart, null);
});

test('build → parse round-trips a full selection', () => {
  const built = buildWalkInParams({
    offeringId: OFFER_MULTI,
    date: '2027-08-02',
    resourceId: ANY_RESOURCE,
    slotStart: '2027-08-02T15:00:00.000Z',
  });
  const s = parseWalkInParams(built, OFFERINGS, TZ);
  assert.equal(s.step, 'details');
  assert.equal(s.offering.id, OFFER_MULTI);
  assert.equal(s.date, '2027-08-02');
  assert.equal(s.resourceId, ANY_RESOURCE);
  assert.equal(s.slotStart, '2027-08-02T15:00:00.000Z');
});

test('buildWalkInParams omits everything without an offering', () => {
  assert.equal(buildWalkInParams({}).toString(), '');
  assert.equal(
    buildWalkInParams({ date: '2027-08-02', slotStart: 'x' }).toString(),
    '',
  );
});

// ---------- buildSections ----------

test('sections: overlay labels + order first, derived alphabetical after', () => {
  const categories = [
    { category: 'hittrax', label: 'HitTrax – See Your Hitting Stats', display_order: 0 },
  ];
  const sections = buildSections(OFFERINGS, categories);
  // Labeled section first (order 0), unlabeled after, alphabetical.
  assert.deepEqual(
    sections.map((s) => s.key),
    ['hittrax', 'cage-time'],
  );
  assert.equal(sections[0].label, 'HitTrax – See Your Hitting Stats');
  // Derived fallback label for unlabeled keys.
  assert.equal(sections[1].label, 'Cage Time');
  assert.deepEqual(
    sections[1].offerings.map((o) => o.name),
    ['60-min Cage'],
  );
});

test('sections: no overlay → alphabetical keys, derived labels', () => {
  const sections = buildSections(OFFERINGS, []);
  assert.deepEqual(
    sections.map((s) => s.key),
    ['cage-time', 'hittrax'],
  );
});

// ---------- dayStripDates ----------

test('dayStripDates spans the advance window, capped, starting today', () => {
  const days = dayStripDates(TZ, 5);
  assert.equal(days.length, 5);
  assert.equal(days[0], tenantLocalDate(TZ));
  assert.equal(days[4], tenantLocalDate(TZ, 4));
  // Cap + garbage handling.
  assert.equal(dayStripDates(TZ, 500).length, 60);
  assert.equal(dayStripDates(TZ, 0).length, 1);
  assert.equal(dayStripDates(TZ, undefined).length, 30);
});

function randomUuidLike() {
  return '99999999-9999-4999-8999-999999999999';
}
