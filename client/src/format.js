// Display formatters for money, time-of-day, day-of-week, etc.
// Pure functions — kept separate from React so they're trivially
// reusable and testable later if we wire up frontend tests.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayOfWeekLabel(n) {
  return DAYS[n] ?? `?${n}`;
}

// `time` columns come back from pg as 'HH:MM:SS' strings. Render as
// 'HH:MM' for compactness; full seconds aren't useful in admin UI.
export function timeShort(t) {
  if (!t) return '';
  const m = /^(\d{2}:\d{2})/.exec(t);
  return m ? m[1] : t;
}

// All money in the schema is integer cents. Format as USD with two
// decimals; locale-aware grouping.
export function formatCents(cents) {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

// Calendar date of an instant, rendered in the tenant's timezone.
// Without `tz` this falls back to the viewer's zone — every call site
// should pass the tenant timezone (a member who joined at 11:30 PM
// tenant time shows the wrong "Joined" day to any viewer east of the
// tenant otherwise).
export function formatDate(iso, tz) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: tz || undefined,
  });
}

// allowed_categories is null (= all categories allowed) or an array.
export function formatAllowedCategories(arr) {
  if (arr == null) return 'all categories';
  if (Array.isArray(arr) && arr.length === 0) return 'none';
  return arr.join(', ');
}

// Render an ISO instant in the tenant's timezone — used by member &
// admin booking lists to show "Mon Apr 28, 2:00 PM" style dates.
// `tz` is an IANA name like "America/New_York"; if omitted falls
// back to the browser's local zone (best-effort).
export function formatSlotLocal(iso, tz) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: tz || undefined,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Just the time-of-day portion ("2:00 PM"). For slot picker buttons.
export function formatTimeLocal(iso, tz) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    timeZone: tz || undefined,
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Map a booking's status enum to a label + tone for <Badge>.
export function bookingStatusBadge(status) {
  switch (status) {
    case 'confirmed':
      return { label: 'confirmed', tone: 'success' };
    case 'completed':
      return { label: 'completed', tone: 'neutral' };
    case 'cancelled':
      return { label: 'cancelled', tone: 'danger' };
    case 'no_show':
      return { label: 'no-show', tone: 'warning' };
    case 'pending_payment':
      return { label: 'pending payment', tone: 'info' };
    default:
      return { label: status || '—', tone: 'neutral' };
  }
}

export function formatNoShowAction(action) {
  switch (action) {
    case 'none':
      return 'none';
    case 'forfeit_credits':
      return 'forfeit credits';
    case 'charge_fee':
      return 'charge fee';
    case 'block_member':
      return 'block member';
    default:
      return action || '—';
  }
}
