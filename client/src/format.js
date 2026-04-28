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
