// Shareable links to the tenant's public booking page, for the admin
// UI ("here's your URL — put it in your Instagram bio").
//
// The absolute base comes from the server (tenant.booking_url, built
// by src/lib/publicUrl.js) because APP_HOSTNAME is server-only. The
// per-service query string is built by buildWalkInParams — the same
// function the walk-in flow uses — so the share link and the parser
// that reads it back (parseWalkInParams) can't drift on the param name.
//
// Pure: no React, no clipboard. Unit tested from
// tests/bookingLinks.test.js against the server constructor.

import { buildWalkInParams } from './walkinParams.js';

export const WALK_IN_PATH = '/walk-in';

// Absolute URL of the booking page. Falls back to the current origin
// when the server didn't send booking_url (an older bundle talking to
// a newer server, or vice versa) — correct in production, where admin
// and booking page share a subdomain, and only wrong on bare-localhost
// dev where the tenant rides in ?tenant=.
export function bookingPageUrl(tenant) {
  if (tenant?.booking_url) return tenant.booking_url;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${WALK_IN_PATH}`;
  }
  return WALK_IN_PATH;
}

// Deep link into one service's time picker, skipping the service list.
// Falls back to the plain booking page when there's no offering id.
export function serviceBookingUrl(tenant, offeringId) {
  const base = bookingPageUrl(tenant);
  if (!offeringId) return base;
  return `${base}?${buildWalkInParams({ offeringId })}`;
}

// Scheme-stripped for display: 'momentum.courtside.app/walk-in'. The
// copied value is always the full URL — this is presentation only.
export function displayUrl(url) {
  return String(url ?? '').replace(/^https?:\/\//, '');
}
