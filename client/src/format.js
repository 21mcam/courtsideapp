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
// Renders raw category keys — admin surfaces only, where the keys are
// the admin's own configuration language. Member surfaces use
// formatCategoryLabel instead.
export function formatAllowedCategories(arr) {
  if (arr == null) return 'all categories';
  if (Array.isArray(arr) && arr.length === 0) return 'none';
  return arr.join(', ');
}

// Human label for an internal category key: 'cage-time' → 'Cage Time'.
// Member/customer surfaces must never show the raw key.
export function formatCategoryLabel(key) {
  if (!key) return '';
  return String(key)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Short human timezone label for member/customer copy — "ET" instead
// of "America/New_York". 'shortGeneric' gives the generic zone name
// ("ET"); some environments/zones don't support it, so fall back to
// 'short' ("EDT") and finally to the raw IANA name.
//
// Cached per tz for the session: this runs in render paths that are
// hot on desktop (AdminCalendar's grid re-renders on every mousemove
// during drag-to-create), and Intl.DateTimeFormat construction is
// expensive. The 'shortGeneric' label is DST-agnostic; only the rare
// 'short' fallback ("EDT") could drift across a DST switch mid-
// session, which is an acceptable trade for a per-frame hot path.
const tzLabelCache = new Map();

export function formatTimezoneLabel(tz) {
  if (!tz) return '';
  // Intl renders UTC as "GMT+0", which reads like a glitch in member
  // copy ("Times shown in GMT+0") — say "UTC" outright.
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  const cached = tzLabelCache.get(tz);
  if (cached) return cached;
  let label = tz;
  for (const timeZoneName of ['shortGeneric', 'short']) {
    try {
      const part = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName,
      })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName');
      if (part?.value) {
        label = part.value;
        break;
      }
    } catch {
      // Unsupported option or bad tz — try the next fallback.
    }
  }
  tzLabelCache.set(tz, label);
  return label;
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

// Map a subscription's status enum to a label + tone for <Badge>.
// Statuses are internal Stripe-mapped enums — never render them raw
// in member-facing UI (past_due would show its underscore).
export function subscriptionStatusBadge(status) {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'success' };
    case 'past_due':
      return { label: 'Past due', tone: 'warning' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'pending':
      return { label: 'Pending', tone: 'info' };
    case 'incomplete':
      return { label: 'Payment incomplete', tone: 'warning' };
    default:
      return { label: status || '—', tone: 'neutral' };
  }
}

// /api/availability returns a machine `reason` string alongside an
// empty slot list. Map the known reasons to member/customer-friendly
// copy; anything unrecognized renders nothing rather than leaking
// backend phrasing into the UI.
export function formatNoSlotsReason(reason) {
  switch (reason) {
    case 'offering inactive':
      return "This session type isn't currently offered.";
    case 'offering not offered on this resource':
      return "This session type isn't offered here right now.";
    case 'class offerings use pre-generated instances, not slot availability':
      return 'This session runs as a scheduled class — book a spot from the class schedule instead.';
    default:
      return null;
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
