// Pure interval arithmetic. Inputs and outputs are { start: Date,
// end: Date } objects with end > start (half-open [start, end)).
//
// All operations work in UTC milliseconds. Callers convert
// local-tenant-time → UTC at the SQL boundary (Postgres `AT TIME
// ZONE`) before arriving here, so DST transitions are pre-resolved
// — a "9am-5pm Mon" operating_hours row on a spring-forward day
// arrives here as a 7-hour UTC range, not 8, which is correct.
//
// No timezone awareness is needed in this module. That's the point.

// Sort + merge overlapping or touching intervals. Touching (end ===
// next.start) is treated as a single contiguous block.
export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      // overlap or touch
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

// Subtract `occupied` (any list of intervals — overlaps fine, will
// be merged) from each interval in `open`. Returns a flat list of
// remaining free intervals, sorted by start. Free intervals shorter
// than zero ms are dropped.
export function subtractIntervals(open, occupied) {
  const merged = mergeIntervals(occupied);
  const free = [];

  for (const window of open) {
    let cursor = window.start.getTime();
    const end = window.end.getTime();

    for (const occ of merged) {
      const occStart = occ.start.getTime();
      const occEnd = occ.end.getTime();
      if (occEnd <= cursor) continue; // occupied entirely before cursor
      if (occStart >= end) break;     // occupied is past this window
      if (occStart > cursor) {
        free.push({ start: new Date(cursor), end: new Date(Math.min(occStart, end)) });
      }
      cursor = Math.max(cursor, occEnd);
      if (cursor >= end) break;
    }

    if (cursor < end) {
      free.push({ start: new Date(cursor), end: new Date(end) });
    }
  }

  return free;
}

// Cut each free interval into back-to-back slots of `durationMs`
// starting at the interval's start. Trailing remainder shorter than
// duration is discarded — we don't offer "you have 12 minutes" slots.
//
// `stepMs` controls the cadence of slot starts. Default = duration
// (non-overlapping grid). Pass a smaller step to offer overlapping
// start times (e.g. 30-min step on a 60-min duration gives starts
// at :00 and :30 with each slot 60min long).
export function sliceIntoSlots(intervals, durationMs, stepMs = null) {
  const step = stepMs ?? durationMs;
  if (durationMs <= 0 || step <= 0) {
    throw new Error('durationMs and stepMs must be positive');
  }
  const slots = [];
  for (const iv of intervals) {
    let s = iv.start.getTime();
    const end = iv.end.getTime();
    while (s + durationMs <= end) {
      slots.push({ start: new Date(s), end: new Date(s + durationMs) });
      s += step;
    }
  }
  return slots;
}
