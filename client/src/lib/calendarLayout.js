// Pure layout math for the admin day calendar. No React, no DOM —
// node-testable (tests/calendarLayout.test.js).
//
// All times are minutes since the TENANT-local midnight of the
// selected day. Intervals are half-open [start, end): a booking
// ending 11:00 and one starting 11:00 abut, they don't overlap —
// matching the DB's tstzrange(start, end, '[)') semantics.

// Default visible window: 06:00–23:00. gridBounds() expands beyond
// this when the day's data demands it, so off-hours bookings are
// never silently invisible.
export const DEFAULT_DAY_START_MIN = 6 * 60;
export const DEFAULT_DAY_END_MIN = 23 * 60;

const MIN_PER_DAY = 24 * 60;

// A booking that crosses local midnight (or lands exactly on it)
// reports an end-minutes <= start-minutes for the day it STARTED on.
// Render it to the end of that day instead of culling it or giving
// it negative height.
export function effectiveEndMin(startMin, endMin) {
  if (endMin <= startMin) return MIN_PER_DAY;
  return endMin;
}

// Visible window for the day: the defaults, expanded (to whole hours)
// to fit every item, clamped to [0, 24h]. items: [{ startMin, endMin }]
// with endMin already effective.
export function gridBounds(items, {
  defaultStartMin = DEFAULT_DAY_START_MIN,
  defaultEndMin = DEFAULT_DAY_END_MIN,
} = {}) {
  let startMin = defaultStartMin;
  let endMin = defaultEndMin;
  for (const it of items) {
    startMin = Math.min(startMin, Math.floor(it.startMin / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(it.endMin / 60) * 60);
  }
  return {
    startMin: Math.max(0, startMin),
    endMin: Math.min(MIN_PER_DAY, endMin),
  };
}

// Assign overlapping items to side-by-side lanes within one resource
// column. Returns a Map key → { lane, laneCount } where laneCount is
// the width of the item's overlap cluster (so non-overlapping items
// stay full-width and a pair of double-booked slots split 50/50).
//
// items: [{ key, startMin, endMin }], endMin effective (> startMin).
export function assignLanes(items) {
  const result = new Map();
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin || String(a.key).localeCompare(String(b.key)),
  );

  let active = []; // [{ key, endMin, lane }]
  let cluster = []; // keys in the current overlap cluster
  let clusterLanes = 0;

  const flushCluster = () => {
    for (const key of cluster) {
      result.get(key).laneCount = clusterLanes;
    }
    cluster = [];
    clusterLanes = 0;
  };

  for (const it of sorted) {
    active = active.filter((a) => a.endMin > it.startMin); // [start,end): abutting frees the lane
    if (active.length === 0 && cluster.length > 0) flushCluster();

    const taken = new Set(active.map((a) => a.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;

    active.push({ key: it.key, endMin: it.endMin, lane });
    cluster.push(it.key);
    clusterLanes = Math.max(clusterLanes, lane + 1);
    result.set(it.key, { lane, laneCount: 1 });
  }
  if (cluster.length > 0) flushCluster();

  return result;
}
