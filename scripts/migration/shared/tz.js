// Timezone-aware parsing for SOURCE timestamps. No dependency — the
// migration scripts must run from a bare `npm install` on cutover
// morning.
//
// The Setmore export writes NAIVE local wall-clock times in the
// facility's timezone; parsing those with bare Date.parse would shift
// every booking by the HOST machine's offset. parseSourceTimestamp
// interprets naive timestamps in an explicit IANA zone instead, and
// passes anything that already carries an offset ('Z' or ±hh[:mm])
// straight through Date.parse — those are absolute on any host.
//
// Fail-closed: only the two known Setmore layouts are accepted for
// naive values —
//
//   'YYYY-MM-DD[ T]HH:MM[:SS]'
//   'M/D/YYYY H:MM[:SS] AM|PM'   (case-insensitive, optional space
//                                 before AM/PM)
//
// — anything else throws with the raw value in the message. New
// export formats get added here deliberately, never guessed.
//
// DST caveat (deterministic either way): naive→UTC uses the standard
// two-pass Intl technique. Spring-forward NONEXISTENT wall times are
// read with the post-jump (DST) offset — e.g. New York '02:30' inside
// the gap resolves to the instant 02:30 EDT would name; fall-back
// AMBIGUOUS wall times resolve to the FIRST occurrence (the
// pre-transition offset).

// A timestamp that names its own offset. The time component must be
// present so a bare date like '2026-06-01' can't sneak through on the
// strength of its trailing '-01'.
const EXPLICIT_OFFSET_RE =
  /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

const ISO_NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const US_NAIVE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AP]M)$/i;

// One Intl.DateTimeFormat per zone — constructing them is expensive
// and mergeBookings calls this per booking row.
const dtfCache = new Map();

function getFormatter(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    // An unknown IANA zone throws RangeError here — fail closed.
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

// The zone's UTC offset in ms at instant `ts`: format the instant in
// the zone, read the wall-clock parts back as if they were UTC, and
// diff — (zone wall time − UTC time).
function offsetAt(ts, timeZone) {
  const parts = {};
  for (const { type, value } of getFormatter(timeZone).formatToParts(ts)) {
    parts[type] = value;
  }
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Some ICU builds render midnight as '24' under hour12:false.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return wallAsUtc - ts;
}

// Parse a source timestamp into epoch ms, or throw. `timeZone` is the
// IANA zone naive wall-clock values are interpreted in (the tenant's
// zone from momentum.map.json); explicit-offset values ignore it.
export function parseSourceTimestamp(raw, timeZone) {
  const value = String(raw ?? '').trim();

  if (EXPLICIT_OFFSET_RE.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw new Error(
        `unparseable timestamp ${JSON.stringify(raw)} — carries an offset suffix ` +
          `but Date.parse rejected it`,
      );
    }
    return ms;
  }

  let year;
  let month;
  let day;
  let hour;
  let minute;
  let second;
  const iso = ISO_NAIVE_RE.exec(value);
  const us = iso ? null : US_NAIVE_RE.exec(value);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
    hour = Number(iso[4]);
    minute = Number(iso[5]);
    second = iso[6] ? Number(iso[6]) : 0;
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
    hour = Number(us[4]);
    minute = Number(us[5]);
    second = us[6] ? Number(us[6]) : 0;
    if (hour < 1 || hour > 12) {
      throw new Error(
        `unparseable timestamp ${JSON.stringify(raw)} — hour ${hour} is out of ` +
          `range for a 12-hour clock`,
      );
    }
    hour = (hour % 12) + (us[7].toUpperCase() === 'PM' ? 12 : 0);
  } else {
    throw new Error(
      `unparseable timestamp ${JSON.stringify(raw)} — expected an explicit-offset ` +
        `timestamp, 'YYYY-MM-DD HH:MM[:SS]', or 'M/D/YYYY H:MM[:SS] AM|PM'; new ` +
        `export formats get added to shared/tz.js deliberately, never guessed`,
    );
  }

  // Round-trip through Date.UTC to reject impossible parts (month 13,
  // Feb 30, minute 75) that the shape regexes can't catch — Date.UTC
  // would silently roll them over into a neighboring day.
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new Error(
      `unparseable timestamp ${JSON.stringify(raw)} — date/time parts are out of range`,
    );
  }

  // Two-pass naive→UTC: first guess the offset at the wall-time-read-
  // as-UTC instant, then refine with the offset at the guessed
  // instant. Exact everywhere except inside DST transitions, where the
  // behavior is the documented (deterministic) caveat above.
  let ts = wall - offsetAt(wall, timeZone);
  ts = wall - offsetAt(ts, timeZone);
  return ts;
}
