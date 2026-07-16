// Tenant-timezone date math. Pure functions, no React — unit-tested
// from tests/tz.test.js (same pattern as lib/calendarLayout.js).
//
// THE RULE (CLAUDE.md gotcha #6): every wall-clock time in the product
// belongs to the TENANT's timezone, never the viewer's browser zone.
// `new Date('YYYY-MM-DDTHH:MM')`, `Date.prototype.setHours(0,...)`,
// and `toLocaleString()` without a timeZone all silently use the
// browser zone — which looks correct exactly when the developer's
// browser matches the tenant (how PR #40 shipped) and is wrong for
// everyone else.

// Offset (ms) of `tz` from UTC at the moment `utcDate`, via Intl.
function tzOffsetMs(tz, utcDate) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcDate.getTime();
}

// Interpret a wall-clock date + time as a moment in `tz` and return
// the corresponding Date (UTC instant). Two-pass so a first guess
// that lands on the wrong side of a DST transition self-corrects;
// for the nonexistent 02:00–03:00 spring-forward hour this resolves
// to the post-transition offset, which is the pragmatic choice for a
// booking tool.
//   zonedTimeToUtc('2026-07-18', '18:00', 'America/New_York')
//     → 2026-07-18T22:00:00.000Z
export function zonedTimeToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  let offset = tzOffsetMs(tz, new Date(wallAsUtc));
  offset = tzOffsetMs(tz, new Date(wallAsUtc - offset));
  return new Date(wallAsUtc - offset);
}

// ISO instant of midnight (start of day) in `tz` for a YYYY-MM-DD.
export function zonedDayStartIso(dateStr, tz) {
  return zonedTimeToUtc(dateStr, '00:00', tz).toISOString();
}

// YYYY-MM-DD of an instant, rendered in `tz`. (en-CA formats as
// YYYY-MM-DD directly.)
export function localDateString(isoOrDate, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoOrDate));
}

// "Today" in `tz`, as YYYY-MM-DD.
export function todayLocalString(tz) {
  return localDateString(new Date(), tz);
}

// YYYY-MM-DD that is `days` calendar days after the given YYYY-MM-DD.
// Pure calendar math — no timezones involved.
export function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}
