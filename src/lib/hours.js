// Facility-wide opening hours for the public home page.
//
// operating_hours is per resource (Cage 1 9–21, Cage 2 12–21, a split
// shift on Saturday...). Customers want one answer per day: "when is
// the place open?" — the UNION of every active resource's windows.
// Overlapping and touching windows merge (9–12 + 12–17 → 9–17); a real
// gap stays a gap (9–12, 14–17 shows both).
//
// Pure, no DB — unit tested from tests/hours.test.js.

// 'HH:MM:SS' (pg time) → 'HH:MM'
function hhmm(t) {
  return String(t).slice(0, 5);
}

// rows: [{ day_of_week, open_time, close_time }] in any order.
// Returns 7 entries, index = day_of_week (0 = Sunday), each
// { day_of_week, intervals: [{ open: 'HH:MM', close: 'HH:MM' }] } —
// empty intervals = closed.
export function mergeWeeklyHours(rows) {
  const byDay = Array.from({ length: 7 }, () => []);
  for (const r of rows) {
    const d = Number(r.day_of_week);
    if (d >= 0 && d <= 6) byDay[d].push({ open: hhmm(r.open_time), close: hhmm(r.close_time) });
  }
  return byDay.map((windows, day_of_week) => {
    // 'HH:MM' strings compare correctly lexicographically.
    windows.sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0));
    const intervals = [];
    for (const w of windows) {
      const last = intervals[intervals.length - 1];
      if (last && w.open <= last.close) {
        if (w.close > last.close) last.close = w.close;
      } else {
        intervals.push({ ...w });
      }
    }
    return { day_of_week, intervals };
  });
}
