// Loader/validator for momentum.map.json — the hand-authored
// translation table between Diamond/Setmore identifiers and the
// Courtside rows that admin-UI prework must already have created.
//
// Fail-closed contract: resolving an entry that is absent, still a
// "TODO" placeholder, or a null numeric throws. 02_transform collects
// these errors across the whole dataset and aborts with the complete
// list, so the operator fixes the map once instead of replaying the
// transform per gap.

import { readFile } from 'node:fs/promises';

const isTodo = (v) => typeof v === 'string' && v.includes('TODO');

export async function loadMapping(path) {
  const mapping = JSON.parse(await readFile(path, 'utf-8'));
  for (const key of ['plans', 'services', 'staff_keys', 'setmore_columns', 'setmore_status_map']) {
    if (mapping[key] == null || typeof mapping[key] !== 'object') {
      throw new Error(`momentum.map.json: missing or invalid "${key}" section`);
    }
  }
  if (typeof mapping.timezone !== 'string' || isTodo(mapping.timezone)) {
    throw new Error('momentum.map.json: "timezone" must be a concrete IANA zone');
  }
  return mapping;
}

// Diamond plan key ('basic' | 'pro' | 'unlimited' | ...) →
// { name, monthly_price_cents, stripe_price_id }.
export function resolvePlan(mapping, planKey) {
  const p = mapping.plans[planKey];
  if (!p) throw new Error(`unmapped plan key: ${JSON.stringify(planKey)}`);
  if (isTodo(p.name)) throw new Error(`plan ${planKey}: name is still TODO`);
  if (!Number.isInteger(p.monthly_price_cents) || p.monthly_price_cents < 0) {
    throw new Error(`plan ${planKey}: monthly_price_cents not filled in`);
  }
  if (isTodo(p.stripe_price_id)) {
    throw new Error(`plan ${planKey}: stripe_price_id is still TODO`);
  }
  return { name: p.name, monthly_price_cents: p.monthly_price_cents, stripe_price_id: p.stripe_price_id ?? null };
}

// Source service name → Courtside offering name.
export function resolveOffering(mapping, serviceName) {
  const name = mapping.services[serviceName];
  if (!name || isTodo(name)) {
    throw new Error(`unmapped service: ${JSON.stringify(serviceName)}`);
  }
  return name;
}

// Setmore staff key (= Diamond bookings.staff_key) → Courtside
// resource name.
export function resolveResource(mapping, staffKey) {
  const name = mapping.staff_keys[staffKey];
  if (!name || isTodo(name)) {
    throw new Error(`unmapped staff key: ${JSON.stringify(staffKey)}`);
  }
  return name;
}

// Canonical field → actual CSV header. Throws while any header is
// still TODO — the Setmore export must be inspected before the
// transform will parse it.
export function resolveSetmoreColumns(mapping) {
  const cols = mapping.setmore_columns;
  const fields = [
    'appointment_id', 'service_name', 'staff_key', 'customer_name',
    'customer_email', 'customer_phone', 'start_time', 'end_time', 'status',
  ];
  const todos = fields.filter((f) => !cols[f] || isTodo(cols[f]));
  if (todos.length > 0) {
    throw new Error(
      `momentum.map.json setmore_columns still TODO for: ${todos.join(', ')} — ` +
        `inspect a real Setmore export and fill them in`,
    );
  }
  const resolved = Object.fromEntries(fields.map((f) => [f, cols[f]]));
  // OPTIONAL split-export support: some Setmore exports put the date
  // in its own column with bare times in start/end. When "date" is
  // set (non-null and not a TODO placeholder) the transform joins
  // '<date> <time>' before parsing. Never TODO-enforced — combined
  // exports simply leave it null.
  if (cols.date != null && !isTodo(cols.date)) resolved.date = cols.date;
  return resolved;
}

// Setmore status value → 'confirmed' | 'cancelled' | 'no_show'.
export function resolveSetmoreStatus(mapping, status) {
  const mapped = mapping.setmore_status_map[status];
  if (!mapped || isTodo(status) || !['confirmed', 'cancelled', 'no_show'].includes(mapped)) {
    throw new Error(`unmapped Setmore status: ${JSON.stringify(status)}`);
  }
  return mapped;
}
