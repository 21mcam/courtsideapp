// Member booking flow — Phase 3 slice 2.
//
// POST /api/bookings (authenticated, requires member_id in JWT).
//
// The flow inside one withTenantContext transaction:
//
//   1. Resolve the offering: must exist, active, capacity = 1
//      (rentals only — class bookings are a separate flow), and
//      allow_member_booking = true.
//   2. Resolve the offering↔resource link: must exist, active.
//   3. Compute end_time from start_time + offering.duration_minutes.
//   4. SELECT FOR UPDATE on the resource row. Serializes concurrent
//      booking attempts on the same resource — the second waiter
//      sees the first attempt's INSERT before re-checking.
//   5. Re-validate availability:
//        a. start..end fits inside an operating_hours window
//           for the day-of-week (in tenant timezone).
//        b. No overlapping blackout (any of three target shapes:
//           facility / resource / offering).
//        c. No overlapping non-cancelled booking on this resource.
//        d. No overlapping non-cancelled class_instance.
//   6. INSERT the booking row (status = 'confirmed', payment shape
//      member-style: amount_due_cents = 0, credit_cost_charged =
//      offering.credit_cost, payment_status = 'not_required').
//   7. Call apply_credit_change with reason='booking_spend' and the
//      newly-inserted booking_id. Insufficient credits raises
//      check_violation; we map to 400 and the whole transaction
//      rolls back, removing the booking row we just inserted.
//
// Belt-and-suspenders: even if the SELECT FOR UPDATE is bypassed
// somehow, the bookings table's partial GiST exclusion constraint
// (status <> 'cancelled', overlapping time_range on same resource)
// will reject the second INSERT.
//
// Plan-allowed-categories check is intentionally NOT enforced here
// — Phase 5 ships subscriptions and that's where it lands. For
// Phase 3 a member with admin-granted credits can book anything.

import { z } from 'zod';

const createBookingSchema = z.object({
  offering_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  start_time: z.string().datetime({
    message: 'start_time must be ISO 8601 (e.g. 2027-01-04T14:00:00.000Z)',
  }),
});

export async function createMemberBooking(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member to book' });
    }
    const { tenant, db, user } = req;
    const member_id = user.member_id;

    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { offering_id, resource_id, start_time } = parsed.data;

    // 1. Offering
    const offerRes = await db.query(
      `SELECT id, category, duration_minutes, credit_cost,
              capacity, active, allow_member_booking
         FROM offerings
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, offering_id],
    );
    if (offerRes.rows.length === 0) {
      return res.status(404).json({ error: 'offering not found' });
    }
    const offering = offerRes.rows[0];
    if (!offering.active) {
      return res.status(409).json({ error: 'offering is inactive' });
    }
    if (offering.capacity !== 1) {
      return res.status(409).json({
        error: 'class offerings use the class booking flow, not /api/bookings',
      });
    }
    if (!offering.allow_member_booking) {
      return res.status(403).json({ error: 'offering does not allow member bookings' });
    }

    // 2. Offering↔resource link
    const linkRes = await db.query(
      `SELECT active FROM offering_resources
        WHERE tenant_id = $1 AND offering_id = $2 AND resource_id = $3`,
      [tenant.id, offering_id, resource_id],
    );
    if (linkRes.rows.length === 0 || !linkRes.rows[0].active) {
      return res
        .status(409)
        .json({ error: 'offering not offered on this resource' });
    }

    // 3. Compute window
    const start = new Date(start_time);
    const end = new Date(start.getTime() + offering.duration_minutes * 60 * 1000);

    // 4. Lock the resource row to serialize concurrent attempts on it.
    //    If the resource doesn't exist (or RLS hides it), this returns
    //    no rows and we 404. RLS shouldn't hide it because we're in
    //    the tenant context, but defense in depth.
    const lockRes = await db.query(
      `SELECT active FROM resources
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenant.id, resource_id],
    );
    if (lockRes.rows.length === 0) {
      return res.status(404).json({ error: 'resource not found' });
    }
    if (!lockRes.rows[0].active) {
      return res.status(409).json({ error: 'resource is inactive' });
    }

    // 5a. Operating hours: at least one row must contain [start, end].
    //     Convert the row's local open/close times to UTC for the
    //     calendar date in tenant timezone.
    //     Edge: a slot starting just before a DST transition could
    //     straddle it. The same AT TIME ZONE logic applies — Postgres
    //     handles it correctly.
    //
    //     We compute the LOCAL date for `start` in tenant timezone
    //     so we look up the right day-of-week and the right calendar
    //     date for the open/close time math.
    const dateAndDow = await db.query(
      `SELECT
         (($1::timestamptz AT TIME ZONE $2)::date)        AS local_date,
         EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE $2))::integer AS dow`,
      [start.toISOString(), tenant.timezone],
    );
    const { local_date, dow } = dateAndDow.rows[0];

    const opCheck = await db.query(
      `SELECT 1 FROM operating_hours
        WHERE tenant_id = $1
          AND resource_id = $2
          AND day_of_week = $3
          AND ($4::date + open_time)::timestamp  AT TIME ZONE $5 <= $6
          AND ($4::date + close_time)::timestamp AT TIME ZONE $5 >= $7
        LIMIT 1`,
      [tenant.id, resource_id, dow, local_date, tenant.timezone, start, end],
    );
    if (opCheck.rows.length === 0) {
      return res
        .status(409)
        .json({ error: 'requested slot is outside operating hours' });
    }

    // 5b. Blackouts
    const blackoutCheck = await db.query(
      `SELECT 1 FROM blackouts
        WHERE tenant_id = $1
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
          AND (
            (resource_id IS NULL AND offering_id IS NULL)
            OR resource_id = $4
            OR offering_id = $5
          )
        LIMIT 1`,
      [tenant.id, start, end, resource_id, offering_id],
    );
    if (blackoutCheck.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'requested slot is blacked out' });
    }

    // 5c. Existing bookings on this resource
    const overlapBookings = await db.query(
      `SELECT 1 FROM bookings
        WHERE tenant_id = $1 AND resource_id = $2
          AND status <> 'cancelled'
          AND time_range && tstzrange($3, $4, '[)')
        LIMIT 1`,
      [tenant.id, resource_id, start, end],
    );
    if (overlapBookings.rows.length > 0) {
      return res.status(409).json({ error: 'slot already booked' });
    }

    // 5d. Class instances on this resource
    const overlapClasses = await db.query(
      `SELECT 1 FROM class_instances
        WHERE tenant_id = $1 AND resource_id = $2
          AND cancelled_at IS NULL
          AND time_range && tstzrange($3, $4, '[)')
        LIMIT 1`,
      [tenant.id, resource_id, start, end],
    );
    if (overlapClasses.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'slot conflicts with an existing class instance' });
    }

    // 6. Insert the booking row.
    let booking;
    try {
      const bookRes = await db.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id, member_id,
           start_time, end_time, status,
           amount_due_cents, credit_cost_charged, payment_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'confirmed', 0, $7, 'not_required'
         )
         RETURNING id, offering_id, resource_id, member_id,
                   start_time, end_time, status,
                   credit_cost_charged, payment_status, created_at`,
        [
          tenant.id,
          offering_id,
          resource_id,
          member_id,
          start,
          end,
          offering.credit_cost,
        ],
      );
      booking = bookRes.rows[0];
    } catch (err) {
      // Belt-and-suspenders: GiST exclusion catches concurrent races
      // that slipped past the SELECT FOR UPDATE somehow.
      if (err.code === '23P01') {
        return res.status(409).json({ error: 'slot already booked (concurrent)' });
      }
      throw err;
    }

    // 7. Spend credits via apply_credit_change. If insufficient
    //    credits the function raises check_violation; the surrounding
    //    transaction rolls back, undoing the booking INSERT above.
    try {
      const creditRes = await db.query(
        `SELECT entry_id, balance_after FROM apply_credit_change(
           $1, $2, $3, 'booking_spend', NULL, $4, $5, NULL
         )`,
        [
          tenant.id,
          member_id,
          -offering.credit_cost,
          user.user_id,
          booking.id,
        ],
      );
      const { entry_id, balance_after } = creditRes.rows[0];
      res.status(201).json({ booking, ledger_entry_id: entry_id, balance_after });
    } catch (err) {
      if (err.code === '23514') {
        // insufficient credits / amount=0 / tenant mismatch
        return res
          .status(400)
          .json({ error: err.message || 'credit change rejected' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// POST /api/bookings/:id/cancel — member self-cancel (or admin
// override). Honors booking_policies' three-field cancellation
// model:
//   * hours_before >= free_cancel_hours_before        → 100% refund
//   * partial_refund_hours_before <= hours_before
//     < free_cancel_hours_before                      → partial_refund_percent
//   * hours_before < partial_refund_hours_before      → 0% refund
//   * If partial_refund_* are NULL, only the full / none tiers apply.
//
// allow_member_self_cancel = false blocks members but admins still
// can. The booking status MUST be 'confirmed' — completed/no_show/
// already-cancelled bookings can't be re-cancelled.
//
// Refund is floor(credit_cost_charged * refund_percent / 100).
// If > 0 and the booking has a member, apply_credit_change is
// called with reason='booking_refund'. UPDATE booking + refund
// happen in the same withTenantContext transaction.
export async function cancelMemberBooking(req, res, next) {
  try {
    if (!req.user?.user_id) {
      return res.status(401).json({ error: 'authentication required' });
    }
    const { tenant, db, user } = req;
    const id = req.params.id;

    // Look up the booking. RLS scopes by tenant; an id from another
    // tenant simply returns no rows.
    const bookingRes = await db.query(
      `SELECT id, member_id, offering_id, resource_id,
              start_time, end_time, status,
              credit_cost_charged, payment_status,
              cancelled_at
         FROM bookings
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    );
    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ error: 'booking not found' });
    }
    const booking = bookingRes.rows[0];

    // Auth: own member booking, or admin.
    const isAdmin = !!user.admin_id;
    const isOwnMemberBooking =
      booking.member_id && booking.member_id === user.member_id;
    if (!isAdmin && !isOwnMemberBooking) {
      return res
        .status(403)
        .json({ error: 'cannot cancel a booking that does not belong to you' });
    }

    // Status gate.
    if (booking.status !== 'confirmed') {
      return res.status(409).json({
        error: `booking is ${booking.status}; only confirmed bookings can be cancelled`,
      });
    }

    // Pull tenant booking policy. If no row exists (older tenants),
    // use schema defaults.
    const policyRes = await db.query(
      `SELECT free_cancel_hours_before, partial_refund_hours_before,
              partial_refund_percent, allow_member_self_cancel
         FROM booking_policies
        WHERE tenant_id = $1`,
      [tenant.id],
    );
    const policy = policyRes.rows[0] ?? {
      free_cancel_hours_before: 24,
      partial_refund_hours_before: null,
      partial_refund_percent: null,
      allow_member_self_cancel: true,
    };

    if (!isAdmin && isOwnMemberBooking && !policy.allow_member_self_cancel) {
      return res
        .status(403)
        .json({ error: 'self-cancellation is disabled by tenant policy' });
    }

    // Compute refund tier from time-until-start.
    const startMs = new Date(booking.start_time).getTime();
    const nowMs = Date.now();
    const hoursBefore = (startMs - nowMs) / (60 * 60 * 1000);

    let refundPercent = 0;
    if (hoursBefore >= policy.free_cancel_hours_before) {
      refundPercent = 100;
    } else if (
      policy.partial_refund_hours_before != null &&
      policy.partial_refund_percent != null &&
      hoursBefore >= policy.partial_refund_hours_before
    ) {
      refundPercent = policy.partial_refund_percent;
    }

    const refundCredits = Math.floor(
      (booking.credit_cost_charged * refundPercent) / 100,
    );

    // Mark cancelled. The schema's lifecycle CHECKs require
    // cancelled_at when status='cancelled'.
    await db.query(
      `UPDATE bookings
          SET status = 'cancelled',
              cancelled_at = now(),
              cancelled_by_type = $1,
              cancelled_by_user_id = $2,
              cancellation_reason = $3
        WHERE tenant_id = $4 AND id = $5`,
      [
        isAdmin ? 'admin' : 'member',
        user.user_id,
        typeof req.body?.cancellation_reason === 'string'
          ? req.body.cancellation_reason
          : null,
        tenant.id,
        id,
      ],
    );

    // Refund if applicable. Only meaningful for member bookings with
    // a positive credit_cost_charged.
    let refund_entry_id = null;
    let balance_after = null;
    if (refundCredits > 0 && booking.member_id) {
      const refundRes = await db.query(
        `SELECT entry_id, balance_after FROM apply_credit_change(
           $1, $2, $3, 'booking_refund', NULL, $4, $5, NULL
         )`,
        [
          tenant.id,
          booking.member_id,
          refundCredits,
          user.user_id,
          booking.id,
        ],
      );
      refund_entry_id = refundRes.rows[0].entry_id;
      balance_after = refundRes.rows[0].balance_after;
    }

    res.json({
      booking_id: id,
      status: 'cancelled',
      refund_credits: refundCredits,
      refund_percent: refundPercent,
      balance_after,
      refund_entry_id,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/bookings/me — list the authenticated member's bookings.
// Useful for "my bookings" UI and for tests to verify state.
export async function listMyBookings(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member to view bookings' });
    }
    const result = await req.db.query(
      `SELECT b.id, b.offering_id, b.resource_id, b.start_time, b.end_time,
              b.status, b.credit_cost_charged, b.payment_status,
              b.cancelled_at, b.created_at,
              o.name AS offering_name,
              r.name AS resource_name
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.member_id = $2
        ORDER BY b.start_time DESC`,
      [req.tenant.id, req.user.member_id],
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    next(err);
  }
}
