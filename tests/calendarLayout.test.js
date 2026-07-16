// Pure-function tests for client/src/lib/calendarLayout.js — the
// admin calendar's lane/window math. No DOM, no React; runs
// unconditionally in CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLanes,
  effectiveEndMin,
  gridBounds,
  DEFAULT_DAY_START_MIN,
  DEFAULT_DAY_END_MIN,
} from '../client/src/lib/calendarLayout.js';

// ============================================================
// effectiveEndMin — cross-midnight normalization
// ============================================================

test('effectiveEndMin passes through normal intervals', () => {
  assert.equal(effectiveEndMin(600, 660), 660);
});

test('effectiveEndMin maps midnight-or-crossing ends to end of day', () => {
  // 23:30 → 00:30 next day: end (30) <= start (1410)
  assert.equal(effectiveEndMin(1410, 30), 1440);
  // 22:00 → 00:00 exactly: Intl reports 0 for the end
  assert.equal(effectiveEndMin(1320, 0), 1440);
  // degenerate equal times also clamp rather than yielding height 0
  assert.equal(effectiveEndMin(600, 600), 1440);
});

// ============================================================
// gridBounds — dynamic visible window
// ============================================================

test('gridBounds returns defaults when items fit inside them', () => {
  const b = gridBounds([{ startMin: 600, endMin: 660 }]);
  assert.equal(b.startMin, DEFAULT_DAY_START_MIN);
  assert.equal(b.endMin, DEFAULT_DAY_END_MIN);
});

test('gridBounds expands to whole hours around off-window items', () => {
  // 05:30 booking pulls the window down to 05:00
  const early = gridBounds([{ startMin: 330, endMin: 390 }]);
  assert.equal(early.startMin, 300);
  // 23:30–24:00 booking pushes the window up to 24:00
  const late = gridBounds([{ startMin: 1410, endMin: 1440 }]);
  assert.equal(late.endMin, 1440);
});

test('gridBounds clamps to [0, 24h] and handles empty days', () => {
  const b = gridBounds([]);
  assert.equal(b.startMin, DEFAULT_DAY_START_MIN);
  assert.equal(b.endMin, DEFAULT_DAY_END_MIN);
  const wild = gridBounds([{ startMin: 0, endMin: 1440 }]);
  assert.equal(wild.startMin, 0);
  assert.equal(wild.endMin, 1440);
});

// ============================================================
// assignLanes — overlap stacking
// ============================================================

test('non-overlapping and abutting items stay full width', () => {
  const lanes = assignLanes([
    { key: 'a', startMin: 600, endMin: 660 },
    { key: 'b', startMin: 660, endMin: 720 }, // abuts a — [start,end) means no overlap
    { key: 'c', startMin: 800, endMin: 860 },
  ]);
  for (const k of ['a', 'b', 'c']) {
    assert.deepEqual(lanes.get(k), { lane: 0, laneCount: 1 }, k);
  }
});

test('two overlapping items split into two lanes', () => {
  const lanes = assignLanes([
    { key: 'a', startMin: 600, endMin: 660 },
    { key: 'b', startMin: 615, endMin: 675 },
  ]);
  assert.deepEqual(lanes.get('a'), { lane: 0, laneCount: 2 });
  assert.deepEqual(lanes.get('b'), { lane: 1, laneCount: 2 });
});

test('identical intervals stack into distinct lanes', () => {
  const lanes = assignLanes([
    { key: 'a', startMin: 600, endMin: 660 },
    { key: 'b', startMin: 600, endMin: 660 },
    { key: 'c', startMin: 600, endMin: 660 },
  ]);
  const used = new Set(['a', 'b', 'c'].map((k) => lanes.get(k).lane));
  assert.deepEqual([...used].sort(), [0, 1, 2]);
  for (const k of ['a', 'b', 'c']) assert.equal(lanes.get(k).laneCount, 3);
});

test('chained overlaps share one cluster width; freed lanes are reused', () => {
  // a(10:00–12:00), b(11:00–13:00), c(12:00–14:00):
  // a↔b overlap, b↔c overlap, a↔c abut → one cluster, max 2 concurrent
  const lanes = assignLanes([
    { key: 'a', startMin: 600, endMin: 720 },
    { key: 'b', startMin: 660, endMin: 780 },
    { key: 'c', startMin: 720, endMin: 840 },
  ]);
  assert.deepEqual(lanes.get('a'), { lane: 0, laneCount: 2 });
  assert.deepEqual(lanes.get('b'), { lane: 1, laneCount: 2 });
  // c starts as a ends — lane 0 is free again, cluster width stays 2
  assert.deepEqual(lanes.get('c'), { lane: 0, laneCount: 2 });
});

test('separate clusters get independent widths', () => {
  const lanes = assignLanes([
    { key: 'a', startMin: 600, endMin: 660 },
    { key: 'b', startMin: 615, endMin: 675 }, // cluster 1: two lanes
    { key: 'c', startMin: 900, endMin: 960 }, // cluster 2: alone
  ]);
  assert.equal(lanes.get('a').laneCount, 2);
  assert.equal(lanes.get('b').laneCount, 2);
  assert.deepEqual(lanes.get('c'), { lane: 0, laneCount: 1 });
});

test('input order does not matter', () => {
  const shuffled = assignLanes([
    { key: 'b', startMin: 615, endMin: 675 },
    { key: 'a', startMin: 600, endMin: 660 },
  ]);
  assert.deepEqual(shuffled.get('a'), { lane: 0, laneCount: 2 });
  assert.deepEqual(shuffled.get('b'), { lane: 1, laneCount: 2 });
});
