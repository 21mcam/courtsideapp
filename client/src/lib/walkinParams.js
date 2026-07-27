// Pure helpers for the public walk-in flow's URL-derived step state.
// No React, no browser APIs — unit tested from tests/walkinParams.test.js
// (same pattern as lib/availability.js).
//
// URL contract (never any PII):
//   /walk-in                          → step 'services'
//   /walk-in?service=<offeringId>     → step 'time'
//   /walk-in?service=..&date=..&res=..&slot=<ISO> → step 'details'
//
// The step is DERIVED from which params are present and valid, never
// stored — refresh restores the flow, hardware back pops one step.

import { formatCategoryLabel } from '../format.js';
import { ANY_RESOURCE } from './availability.js';

// Fallback only — the offerings response carries the authoritative
// policy.hold_minutes from the server constant.
export const DEFAULT_HOLD_MINUTES = 30;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Trim + collapse internal whitespace: '  Mia   Lopez ' → 'Mia Lopez'.
// Used for the booking payload and the waiver signature prefill.
export function normalizeFullName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

// Tenant-local YYYY-MM-DD for "today" (+offset). Uses Intl so DST and
// the tenant/server timezone gap are handled by the platform.
export function tenantLocalDate(tz, daysFromNow = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + daysFromNow);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// Validate the raw search params against the loaded offerings list.
// Anything malformed degrades to the earliest step it can support —
// an unknown offering id restarts at 'services', a bad date becomes
// tenant-today, a bad resource falls back to the offering's default.
//
//   searchParams — anything with .get(name) (URLSearchParams)
//   offerings    — the loaded public offerings array (required)
//   tz           — tenant IANA timezone
//
// Returns { step, offering, date, resourceId, slotStart }.
export function parseWalkInParams(searchParams, offerings, tz) {
  const serviceParam = searchParams.get('service');
  const offering =
    serviceParam && UUID_REGEX.test(serviceParam)
      ? (offerings.find((o) => o.id === serviceParam) ?? null)
      : null;

  const today = tenantLocalDate(tz);
  const dateParam = searchParams.get('date');
  // Shape check + semantic check ('2027-13-99' matches the regex but
  // isn't a date) + no past days.
  const date =
    dateParam &&
    DATE_REGEX.test(dateParam) &&
    !Number.isNaN(Date.parse(`${dateParam}T12:00:00Z`)) &&
    dateParam >= today
      ? dateParam
      : today;

  const resParam = searchParams.get('res');
  const defaultResource = offering
    ? offering.resources.length > 1
      ? ANY_RESOURCE
      : (offering.resources[0]?.id ?? '')
    : '';
  let resourceId = defaultResource;
  if (offering && resParam) {
    if (resParam === ANY_RESOURCE && offering.resources.length > 1) {
      resourceId = ANY_RESOURCE;
    } else if (offering.resources.some((r) => r.id === resParam)) {
      resourceId = resParam;
    }
  }

  const slotParam = searchParams.get('slot');
  const slotStart =
    offering && slotParam && !Number.isNaN(Date.parse(slotParam))
      ? new Date(slotParam).toISOString()
      : null;

  const step = !offering ? 'services' : slotStart ? 'details' : 'time';
  return { step, offering, date, resourceId, slotStart };
}

// Build the search params for a given selection state. Omits empty
// values so URLs stay minimal ('/walk-in?service=..' after the first
// tap). extra lets callers keep flags like cancelled=1 out of it.
export function buildWalkInParams({ offeringId, date, resourceId, slotStart }) {
  const params = new URLSearchParams();
  if (offeringId) params.set('service', offeringId);
  if (offeringId && date) params.set('date', date);
  if (offeringId && resourceId) params.set('res', resourceId);
  if (offeringId && slotStart) params.set('slot', slotStart);
  return params;
}

// Group offerings into display sections by category key. Sections
// with a category_display row sort by its display_order and use its
// label; unlabeled keys fall back to the derived label and sort
// alphabetically after the labeled ones. Offerings keep their
// server-side (display_order, name) order within a section.
export function buildSections(offerings, categories) {
  const overlay = new Map((categories ?? []).map((c) => [c.category, c]));
  const groups = new Map();
  for (const o of offerings) {
    if (!groups.has(o.category)) groups.set(o.category, []);
    groups.get(o.category).push(o);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ra = overlay.get(a);
    const rb = overlay.get(b);
    if (ra && rb) {
      return ra.display_order - rb.display_order || a.localeCompare(b);
    }
    if (ra) return -1;
    if (rb) return 1;
    return a.localeCompare(b);
  });
  return keys.map((key) => ({
    key,
    label: overlay.get(key)?.label || formatCategoryLabel(key),
    offerings: groups.get(key),
  }));
}

// The day strip offers exactly the days the advance-window policy
// allows bookings on (capped for sanity). Returns YYYY-MM-DD strings
// starting today.
export function dayStripDates(tz, maxAdvanceDays) {
  const n = Number(maxAdvanceDays);
  const days = Math.max(1, Math.min(Number.isFinite(n) ? n : 30, 60));
  const out = [];
  for (let i = 0; i <= days - 1; i += 1) {
    out.push(tenantLocalDate(tz, i));
  }
  return out;
}
