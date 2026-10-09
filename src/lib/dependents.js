// Booking FOR a family member (migration 034, FAMILY_ACCOUNTS.md PR 2).
//
// Every booking path that accepts `dependent_id` resolves it here: it
// must be an ACTIVE dependent of the booking's paying member. The
// composite FK (tenant_id, dependent_id, member_id) already makes a
// cross-household booking impossible at the schema level; this gives
// the clean 404 and refuses deactivated kids (the FK can't see
// `active`).

import { z } from 'zod';

// Optional on every create body; null/absent = the member themself.
export const dependentIdSchema = z.string().uuid().nullable().optional();

// → { dependent: {id, first_name, last_name, birth_year} | null } or { error }.
export async function resolveDependent(db, tenantId, memberId, dependentId) {
  if (!dependentId) return { dependent: null };
  const r = await db.query(
    `SELECT id, first_name, last_name, birth_year FROM dependents
      WHERE tenant_id = $1 AND member_id = $2 AND id = $3 AND active`,
    [tenantId, memberId, dependentId],
  );
  if (r.rows.length === 0) {
    return { error: { status: 404, body: { error: 'family member not found' } } };
  }
  return { dependent: r.rows[0] };
}

// "Leo Rivera" for display; null for the member themself.
export function participantName(dep) {
  return dep ? `${dep.first_name} ${dep.last_name}` : null;
}
