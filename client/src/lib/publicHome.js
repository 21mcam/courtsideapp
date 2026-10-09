// Pure display helpers for the public facility home page. No React,
// no browser APIs — unit tested from tests/publicHome.test.js (same
// node --test pattern as lib/walkinParams.js).
//
// `hours` is GET /api/customers/home's array: index = day_of_week
// (0 = Sunday), each { day_of_week, intervals: [{ open, close }] } in
// tenant-local 'HH:MM'.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayName(dow) {
  return DAY_NAMES[dow] ?? '';
}

// '09:00' → '9 AM', '13:30' → '1:30 PM', '00:00' → '12 AM'
export function formatClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatIntervals(intervals) {
  if (!intervals?.length) return 'Closed';
  return intervals.map((i) => `${formatClock(i.open)} – ${formatClock(i.close)}`).join(', ');
}

// Monday-first, the way people read a week of opening hours.
export function mondayFirst(hours) {
  return [1, 2, 3, 4, 5, 6, 0].map((d) => hours[d] ?? { day_of_week: d, intervals: [] });
}

// Tenant-local weekday (0 = Sunday) and 'HH:MM' for an instant.
export function tenantClock(tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow, time: `${parts.hour}:${parts.minute}` };
}

// "Open now · until 9 PM" / "Closed · opens 9 AM" / "Closed · opens
// Monday 9 AM". Null when the facility has no hours at all (don't
// claim "closed" for a tenant that simply hasn't entered hours).
export function openStatus(hours, tz, now = new Date()) {
  if (!hours?.some((d) => d.intervals.length)) return null;
  const { dow, time } = tenantClock(tz, now);

  const today = hours[dow]?.intervals ?? [];
  const current = today.find((i) => i.open <= time && time < i.close);
  if (current) return { open: true, label: `Open now · until ${formatClock(current.close)}` };

  const laterToday = today.find((i) => i.open > time);
  if (laterToday) return { open: false, label: `Closed · opens ${formatClock(laterToday.open)}` };

  for (let k = 1; k <= 7; k += 1) {
    const d = (dow + k) % 7;
    const first = hours[d]?.intervals?.[0];
    if (first) {
      const when = k === 1 ? 'tomorrow' : dayName(d);
      return { open: false, label: `Closed · opens ${when} ${formatClock(first.open)}` };
    }
  }
  return null;
}
