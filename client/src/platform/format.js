// Display helpers for the platform console. Humanize everything —
// raw status keys never reach the screen (same bar as the tenant UI).

const DAY_MS = 24 * 60 * 60 * 1000;

// One label + badge tone for a tenant's platform billing state.
export function billingLabel({ status, trial_ends_at, is_billing_ok }) {
  if (status === 'trial') {
    if (!trial_ends_at) return { label: 'Free (no trial end)', tone: 'info' };
    const days = Math.ceil((new Date(trial_ends_at) - Date.now()) / DAY_MS);
    if (days <= 0 || !is_billing_ok) return { label: 'Trial expired', tone: 'danger' };
    return {
      label: `Trial · ${days} day${days === 1 ? '' : 's'} left`,
      tone: days <= 7 ? 'warning' : 'neutral',
    };
  }
  if (status === 'active') return { label: 'Paying', tone: 'success' };
  if (status === 'past_due') return { label: 'Payment failing', tone: 'warning' };
  if (status === 'cancelled') return { label: 'Cancelled', tone: 'danger' };
  if (status === 'suspended') return { label: 'Suspended', tone: 'danger' };
  return { label: status ?? 'Unknown', tone: 'neutral' };
}

export function stripeLabel(chargesEnabled) {
  if (chargesEnabled === true) return { label: 'Taking payments', tone: 'success' };
  if (chargesEnabled === false) return { label: 'Setup unfinished', tone: 'warning' };
  return { label: 'Not connected', tone: 'neutral' };
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const fmt = (n, unit) => {
    const s = `${n} ${unit}${n === 1 ? '' : 's'}`;
    return future ? `in ${s}` : `${s} ago`;
  };
  if (abs < 60 * 1000) return 'just now';
  if (abs < 60 * 60 * 1000) return fmt(Math.round(abs / 60000), 'minute');
  if (abs < DAY_MS) return fmt(Math.round(abs / 3600000), 'hour');
  if (abs < 60 * DAY_MS) return fmt(Math.round(abs / DAY_MS), 'day');
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const ACTION_LABELS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'tenant.view': 'Viewed facility',
  'tenant.create': 'Created facility',
  'tenant.billing_update': 'Changed billing',
  'support_session.issue': 'Requested view-as-owner link',
  'support_session.open': 'Opened view-as-owner session',
};

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? action;
}

const REASON_LABELS = {
  unknown_email: 'unknown email',
  bad_password: 'wrong password',
  bad_code: 'wrong code',
  code_reused: 'code already used',
  inactive: 'account disabled',
};

const STATUS_WORDS = {
  trial: 'Trial',
  active: 'Paying',
  past_due: 'Payment failing',
  cancelled: 'Cancelled',
  suspended: 'Suspended',
};

// Short human summary of an audit entry's detail payload.
export function auditDetail(entry) {
  const d = entry.detail ?? {};
  switch (entry.action) {
    case 'auth.login_failed':
      return `${d.email ?? ''} — ${REASON_LABELS[d.reason] ?? d.reason ?? ''}`;
    case 'tenant.create':
      return `${d.name ?? d.subdomain}${d.owner_invited ? ' · owner emailed a setup link' : ''}`;
    case 'tenant.billing_update': {
      const parts = [];
      if (d.status) parts.push(`status → ${STATUS_WORDS[d.status] ?? d.status}`);
      if (d.clear_trial) parts.push('trial end removed');
      else if (d.trial_ends_at) parts.push(`trial ends ${new Date(d.trial_ends_at).toLocaleDateString()}`);
      return parts.join(', ');
    }
    default:
      return '';
  }
}
