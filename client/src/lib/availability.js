// Shared availability helpers for the two booking flows (member
// BookingPage, public WalkInPage). Pure functions, no React — unit
// tested from tests/availabilityMerge.test.js (same pattern as
// lib/calendarLayout.js and lib/tz.js).
//
// "No preference" resource selection: when an offering runs on
// several resources, most customers don't care which one they get,
// so the booking flows default to a virtual "No preference" choice.
// The flows fetch /api/availability once per resource and show the
// UNION of open start times; a concrete resource is substituted only
// at confirm time (via resourceIdsBySlot below).

// Sentinel for "the customer doesn't care which resource". Lives in
// client state only — resource ids are UUIDs so it can't collide —
// and is never sent to the API: the confirm step always substitutes
// a real resource id.
export const ANY_RESOURCE = 'any';

// Friendly copy for when every resource that had the slot filled up
// between listing and confirming.
export const SLOT_TAKEN_MESSAGE =
  'That time was just taken — please pick another time.';

// True when a booking-create failure is worth retrying at the SAME
// time on a DIFFERENT resource: 409s without a `code` are slot-level
// conflicts (someone else grabbed it, a blackout landed, hours
// changed since the list loaded). Coded 409s (the waiver signature /
// version flows) are handled specially by the callers and must never
// be silently retried.
export function isRetryableConflict(status, body) {
  return status === 409 && !body?.code;
}

// Merge per-resource /api/availability responses into one slot list.
//
//   resourceIds — the resource ids queried, in catalog display order
//   results     — same order; each { slots?: [{start, end}], reason? }
//
// Returns:
//   slots             — union of start times, deduped, sorted
//   reason            — a "no slots" reason, only when the union is
//                       empty (first non-null wins; formatNoSlotsReason
//                       drops anything unmapped, so this never leaks)
//   resourceIdsBySlot — start ISO → the resource ids that had that
//                       slot, ordered most-open-slots-first. Booking
//                       the emptiest resource first spreads load
//                       across resources instead of piling every
//                       no-preference booking onto the first one.
//                       Ties keep catalog order (Array sort is
//                       stable).
export function mergeAvailability(resourceIds, results) {
  const openCount = new Map();
  const byStart = new Map();
  resourceIds.forEach((resourceId, i) => {
    const slots = results[i]?.slots ?? [];
    openCount.set(resourceId, slots.length);
    for (const slot of slots) {
      const entry = byStart.get(slot.start);
      if (entry) entry.resourceIds.push(resourceId);
      else byStart.set(slot.start, { end: slot.end, resourceIds: [resourceId] });
    }
  });

  // Server timestamps are uniform toISOString() output, so
  // lexicographic order === chronological order.
  const starts = [...byStart.keys()].sort();

  const slots = starts.map((start) => ({
    start,
    end: byStart.get(start).end,
  }));
  const resourceIdsBySlot = {};
  for (const start of starts) {
    resourceIdsBySlot[start] = [...byStart.get(start).resourceIds].sort(
      (a, b) => openCount.get(b) - openCount.get(a),
    );
  }
  const reason =
    slots.length === 0
      ? (results.map((r) => r?.reason).find((r) => r != null) ?? null)
      : null;
  return { slots, reason, resourceIdsBySlot };
}
