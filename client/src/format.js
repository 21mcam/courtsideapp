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

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
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

// Map a booking's status enum to a (label, tailwind-class) pair for
// the badge component.
export function bookingStatusBadge(status) {
  switch (status) {
    case 'confirmed':
      return { label: 'confirmed', className: 'bg-emerald-100 text-emerald-900' };
    case 'completed':
      return { label: 'completed', className: 'bg-slate-100 text-slate-700' };
    case 'cancelled':
      return { label: 'cancelled', className: 'bg-rose-100 text-rose-900' };
    case 'no_show':
      return { label: 'no-show', className: 'bg-amber-100 text-amber-900' };
    case 'pending_payment':
      return { label: 'pending payment', className: 'bg-sky-100 text-sky-900' };
    default:
      return { label: status || '—', className: 'bg-slate-100 text-slate-700' };
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
