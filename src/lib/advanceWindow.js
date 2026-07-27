// Advance-booking window policy, shared by the member create path
// (controllers/bookings.js), the walk-in create path
// (controllers/customerBookings.js) and the walk-in reschedule path.
//
// Tenants set a floor and ceiling on how far out a booking may start.
// Pulled from booking_policies; a missing row falls back to the schema
// defaults (0 min / 30 days) so pre-migration-012 tenants keep working.
//
// Violations are NOT resource-dependent (they hit every resource
// identically), so callers return them as 409s WITHOUT
// code: 'slot_conflict' — the walk-in UI's next-resource retry loop
// must not spin on them.

export const ADVANCE_POLICY_DEFAULTS = {
  min_advance_booking_minutes: 0,
  max_advance_booking_days: 30,
};

export async function getAdvancePolicy(db, tenantId) {
  const r = await db.query(
    `SELECT min_advance_booking_minutes, max_advance_booking_days
       FROM booking_policies WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ?? { ...ADVANCE_POLICY_DEFAULTS };
}

// Pure: returns a human-readable violation message, or null when the
// start time is inside the window. Compared in minutes for both
// bounds — avoids day-vs-DST surprises.
export function advanceWindowViolation(policy, start, now = Date.now()) {
  const minutesAhead = (start.getTime() - now) / 60000;
  if (minutesAhead < policy.min_advance_booking_minutes) {
    return `bookings must be made at least ${policy.min_advance_booking_minutes} minutes in advance`;
  }
  const maxMinutesAhead = policy.max_advance_booking_days * 1440;
  if (minutesAhead > maxMinutesAhead) {
    return `bookings cannot be made more than ${policy.max_advance_booking_days} days in advance`;
  }
  return null;
}
