// Deterministic UUIDs for migrated rows.
//
// Every row the migration creates gets a UUIDv5 derived from
// (tenant_id, destination table, Momentum source id). Same source row
// → same Courtside UUID on every run. That gives us:
//
//   1. Idempotent loads with a real upsert key. Bookings and
//      subscriptions have no natural key (names repeat, stripe ids
//      can be NULL), so without this a rerun duplicates rows.
//   2. No cross-step id plumbing. transform can compute the UUID a
//      row WILL have without talking to the DB, so its output is
//      genuinely loadable and the old idMaps hand-off disappears.
//
// The namespace is a fixed constant. Changing it (or the name format
// below) between runs breaks rerun idempotency — don't.

import { createHash } from 'node:crypto';

// Arbitrary fixed namespace UUID for this migration. Never change.
export const MIGRATION_NAMESPACE = '3f1c8a52-9d44-4b6e-8e0a-5b7c2d91f364';

// migrationId(tenantId, 'bookings', srcRow.id) → stable UUID string.
export function migrationId(tenantId, table, sourceId) {
  if (!tenantId) throw new Error('migrationId: tenantId required');
  if (!table) throw new Error('migrationId: table required');
  if (sourceId == null || String(sourceId).trim() === '') {
    throw new Error(`migrationId: source id required (table=${table})`);
  }
  return uuidv5(`${tenantId}:${table}:${String(sourceId)}`, MIGRATION_NAMESPACE);
}

// RFC 4122 v5 (SHA-1, name-based). Node has no built-in v5; this is
// the standard 20-line construction rather than a new dependency.
function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('uuidv5: bad namespace');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
