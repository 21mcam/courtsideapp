// GET /api/availability — returns open booking slots for a given
// (resource, offering, date) tuple in the tenant's timezone.
//
// Algorithm:
//   1. Compute the day window in UTC by treating `date` as the local
//      calendar date in the tenant's timezone (Postgres AT TIME ZONE
//      handles DST correctly).
//   2. Pull operating_hours for the resource for that day-of-week,
//      converted to UTC. Multi-row → split shifts.
//   3. Pull blackouts that overlap the day: facility-wide (both
//      target columns null), resource-targeted, offering-targeted.
//   4. Pull non-cancelled bookings on the resource for that day.
//   5. Pull non-cancelled class_instances on the resource for that
//      day (rentals share resources with classes; classes block).
//   6. Subtract (3+4+5) from (2). Slice the remaining free intervals
//      into chunks of the offering's duration.
//   7. Return UTC ISO timestamps; the client formats locally.
//
// No auth required — both members and walk-ins need this.
// Tenant-scoped via the global resolveTenant + per-route
// withTenantContext (so tenant RLS still applies).
//
// The DST safety property: AT TIME ZONE in Postgres pre-resolves
// local-time-on-day → UTC instant. Once we have UTC ms, all
// arithmetic in src/lib/intervals.js is plain math. Spring-forward
// days yield shorter free intervals (the "lost hour" is pre-removed
// by Postgres) and slicing produces correctly fewer slots.

import { z } from 'zod';
import { mergeIntervals, sliceIntoSlots, subtractIntervals } from '../lib/intervals.js';

const querySchema = z.object({
  resource_id: z.string().uuid(),
  offering_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

export async function getAvailability(req, res, next) {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { resource_id, offering_id, date } = parsed.data;
    const tz = req.tenant.timezone;

    // Look up the offering (and verify the offering↔resource link
    // exists + is active in this tenant). Capacity = 1 means rental;
    // capacity > 1 = class. For now availability is only meaningful
    // for rentals — class instances are pre-generated, not slot-
    // sliced. If someone asks availability for a class offering, we
    // return [] cleanly with a hint.
    const offeringQuery = await req.db.query(
      `SELECT o.duration_minutes, o.capacity, o.active AS o_active,
              orx.active AS link_active
         FROM offerings o
         LEFT JOIN offering_resources orx
           ON orx.tenant_id = o.tenant_id
          AND orx.offering_id = o.id
          AND orx.resource_id = $3
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [req.tenant.id, offering_id, resource_id],
    );
    if (offeringQuery.rows.length === 0) {
      return res.status(404).json({ error: 'offering not found in this tenant' });
    }
    const offering = offeringQuery.rows[0];
    if (!offering.o_active) {
      return res.json({ slots: [], reason: 'offering inactive' });
    }
    if (!offering.link_active) {
      return res.json({ slots: [], reason: 'offering not offered on this resource' });
    }
    if (offering.capacity !== 1) {
      return res.json({ slots: [], reason: 'class offerings use pre-generated instances, not slot availability' });
    }

    // Compute day window + day-of-week, all in tenant timezone.
    // We send 'date' as a string and let Postgres do the AT TIME
    // ZONE math.
    const windowQuery = await req.db.query(
      `SELECT
         ($1::date)::timestamp           AT TIME ZONE $2 AS day_start,
         ($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE $2 AS day_end,
         EXTRACT(DOW FROM $1::date)::integer AS dow`,
      [date, tz],
    );
    const { day_start, day_end, dow } = windowQuery.rows[0];

    // Operating hours for that resource + day-of-week, converted to
    // UTC instants for the requested date. Postgres handles DST.
    const hoursQuery = await req.db.query(
      `SELECT
         (($1::date + open_time)::timestamp  AT TIME ZONE $2) AS start_ts,
         (($1::date + close_time)::timestamp AT TIME ZONE $2) AS end_ts
         FROM operating_hours
        WHERE tenant_id = $3
          AND resource_id = $4
          AND day_of_week = $5
        ORDER BY open_time ASC`,
      [date, tz, req.tenant.id, resource_id, dow],
    );

    // Blackouts overlapping the day window. Three target shapes:
    // facility-wide (both nulls), resource-targeted, offering-targeted.
    const blackoutsQuery = await req.db.query(
      `SELECT GREATEST(starts_at, $4)::timestamptz AS start_ts,
              LEAST(ends_at, $5)::timestamptz      AS end_ts
         FROM blackouts
        WHERE tenant_id = $1
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($4, $5, '[)')
          AND (
            (resource_id IS NULL AND offering_id IS NULL)
            OR resource_id = $2
            OR offering_id = $3
          )`,
      [req.tenant.id, resource_id, offering_id, day_start, day_end],
    );

    // Non-cancelled bookings on the resource that day.
    const bookingsQuery = await req.db.query(
      `SELECT GREATEST(start_time, $3)::timestamptz AS start_ts,
              LEAST(end_time, $4)::timestamptz      AS end_ts
         FROM bookings
        WHERE tenant_id = $1
          AND resource_id = $2
          AND status <> 'cancelled'
          AND time_range && tstzrange($3, $4, '[)')`,
      [req.tenant.id, resource_id, day_start, day_end],
    );

    // Non-cancelled class_instances on the resource that day. Classes
    // share resources with rentals; we have to subtract them too or
    // we'd advertise a slot that the booking-time enforce_no_class_
    // overlap_on_booking trigger would later reject.
    const classQuery = await req.db.query(
      `SELECT GREATEST(start_time, $3)::timestamptz AS start_ts,
              LEAST(end_time, $4)::timestamptz      AS end_ts
         FROM class_instances
        WHERE tenant_id = $1
          AND resource_id = $2
          AND cancelled_at IS NULL
          AND time_range && tstzrange($3, $4, '[)')`,
      [req.tenant.id, resource_id, day_start, day_end],
    );

    const open = mergeIntervals(
      hoursQuery.rows.map((r) => ({ start: r.start_ts, end: r.end_ts })),
    );
    const occupied = [
      ...blackoutsQuery.rows,
      ...bookingsQuery.rows,
      ...classQuery.rows,
    ].map((r) => ({ start: r.start_ts, end: r.end_ts }));

    const free = subtractIntervals(open, occupied);
    const durationMs = offering.duration_minutes * 60 * 1000;
    const slots = sliceIntoSlots(free, durationMs);

    res.json({
      slots: slots.map((s) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
      })),
      day_start: new Date(day_start).toISOString(),
      day_end: new Date(day_end).toISOString(),
      duration_minutes: offering.duration_minutes,
    });
  } catch (err) {
    next(err);
  }
}
