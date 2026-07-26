// Pure-function tests for client/src/lib/availability.js — the "No
// preference" resource-selection logic shared by the member and
// walk-in booking flows. No DOM, no React; runs unconditionally in
// CI (same pattern as calendarLayout.test.js / tz.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANY_RESOURCE,
  isRetryableConflict,
  mergeAvailability,
} from '../client/src/lib/availability.js';

const T = (h) => `2027-01-04T${String(h).padStart(2, '0')}:00:00.000Z`;
const slot = (h) => ({ start: T(h), end: T(h + 1) });

// ============================================================
// mergeAvailability — union, dedupe, sort
// ============================================================

test('merges per-resource slot lists into a sorted, deduped union', () => {
  const { slots } = mergeAvailability(
    ['r1', 'r2'],
    [{ slots: [slot(14), slot(10)] }, { slots: [slot(12), slot(10)] }],
  );
  assert.deepEqual(
    slots.map((s) => s.start),
    [T(10), T(12), T(14)],
  );
  // end times ride along with the deduped start
  assert.equal(slots[0].end, T(11));
});

test('single-resource merge passes the list through unchanged', () => {
  const { slots, reason, resourceIdsBySlot } = mergeAvailability(
    ['r1'],
    [{ slots: [slot(9), slot(10)] }],
  );
  assert.deepEqual(slots, [slot(9), slot(10)]);
  assert.equal(reason, null);
  assert.deepEqual(resourceIdsBySlot[T(9)], ['r1']);
});

test('tolerates responses with a missing slots array', () => {
  const { slots } = mergeAvailability(['r1', 'r2'], [{}, { slots: [slot(8)] }]);
  assert.deepEqual(slots, [slot(8)]);
});

// ============================================================
// mergeAvailability — resourceIdsBySlot ordering (load spreading)
// ============================================================

test('orders slot candidates by most open slots first', () => {
  // r2 has more open time that day, so a no-preference booking
  // should land there first (spreads load).
  const { resourceIdsBySlot } = mergeAvailability(
    ['r1', 'r2'],
    [{ slots: [slot(10)] }, { slots: [slot(10), slot(11), slot(12)] }],
  );
  assert.deepEqual(resourceIdsBySlot[T(10)], ['r2', 'r1']);
  // Slots only r2 had list only r2.
  assert.deepEqual(resourceIdsBySlot[T(11)], ['r2']);
});

test('candidate ties keep catalog order', () => {
  const { resourceIdsBySlot } = mergeAvailability(
    ['r1', 'r2', 'r3'],
    [
      { slots: [slot(10), slot(11)] },
      { slots: [slot(10), slot(12)] },
      { slots: [slot(10), slot(13)] },
    ],
  );
  // All three have 2 open slots — stable sort preserves the catalog
  // (display_order) ordering the caller passed in.
  assert.deepEqual(resourceIdsBySlot[T(10)], ['r1', 'r2', 'r3']);
});

// ============================================================
// mergeAvailability — reason passthrough
// ============================================================

test('surfaces a no-slots reason only when the union is empty', () => {
  const empty = mergeAvailability(
    ['r1', 'r2'],
    [
      { slots: [], reason: 'offering inactive' },
      { slots: [], reason: 'offering inactive' },
    ],
  );
  assert.equal(empty.reason, 'offering inactive');
  assert.deepEqual(empty.slots, []);

  const partial = mergeAvailability(
    ['r1', 'r2'],
    [{ slots: [], reason: 'offering not offered on this resource' }, { slots: [slot(10)] }],
  );
  assert.equal(partial.reason, null);
});

// ============================================================
// isRetryableConflict — which failures may try the next resource
// ============================================================

test('uncoded 409s are retryable, coded and non-409 are not', () => {
  assert.equal(isRetryableConflict(409, { error: 'slot already booked' }), true);
  assert.equal(isRetryableConflict(409, {}), true);
  assert.equal(
    isRetryableConflict(409, { code: 'waiver_signature_required' }),
    false,
  );
  assert.equal(
    isRetryableConflict(409, { code: 'waiver_version_mismatch' }),
    false,
  );
  assert.equal(isRetryableConflict(400, { error: 'invalid input' }), false);
  assert.equal(isRetryableConflict(500, {}), false);
});

// ============================================================
// ANY_RESOURCE sentinel
// ============================================================

test('sentinel cannot collide with a resource UUID', () => {
  assert.equal(ANY_RESOURCE, 'any');
  assert.doesNotMatch(
    ANY_RESOURCE,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
