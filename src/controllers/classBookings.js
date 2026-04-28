// Member class-booking flow — Phase 4 slice 3.
//
// Mirrors src/controllers/bookings.js (rentals) but writes into
// class_bookings. The schema does most of the safety work:
//   * enforce_class_capacity trigger blocks the (capacity+1)-th booking
//   * enforce_class_booking_validity trigger checks instance not
//     cancelled, offering still active + member-bookable, resource
//     still active, link still active
//   * partial unique index (tenant, class_instance, member) WHERE
//     member_id IS NOT NULL AND status <> 'cancelled' blocks
//     double-booking
//
// We translate the resulting Postgres error codes into clean HTTP
// responses. Plan-allowed-categories is NOT enforced — same comment
// as createMemberBooking; lands with subscriptions in phase 5.
//
// Endpoints:
//   GET   /api/class-instances           list bookable instances
//   POST  /api/class-bookings            book a spot
//   GET   /api/class-bookings/me         my class bookings
//   POST  /api/class-bookings/:id/cancel    self-cancel (or admin)
//   POST  /api/class-bookings/:id/mark-no-show   admin-only

import { z } from 'zod';

// ============================================================
// GET /api/class-instances — member-readable upcoming list
// ============================================================
//
// Filters:
//   from / to   ISO datetimes; defaults [now, now+60d)
//   offering_id optional UUID; narrows to one offering if set
//
// Excludes cancelled instances, instances whose offering is
// inactive, or whose offering doesn't allow_member_booking, and
// returns a `spots_remaining` field from a count subquery.
const instancesQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  offering_id: z.string().uuid().optional(),
});

export async function listAvailableClassInstances(req, res, next) {
  try {
    const parsed = instancesQuery.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { from, to, offering_id } = parsed.data;
    const fromTs = from ? new Date(from) : new Date();
    const toTs = to
      ? new Date(to)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    if (fromTs >= toTs) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    const params = [req.tenant.id, fromTs, toTs];
    let offeringClause = '';
    if (offering_id) {
      params.push(offering_id);
      offeringClause = `AND ci.offering_id = $${params.length}`;
    }

    const result = await req.db.query(
      `SELECT ci.id, ci.offering_id, ci.resource_id,
              ci.start_time, ci.end_time, ci.capacity,
              o.name AS offering_name,
              o.duration_minutes,
              o.credit_cost,
              r.name AS resource_name,
              (ci.capacity - COALESCE((
                SELECT count(*) FROM class_bookings cb
                 WHERE cb.tenant_id = ci.tenant_id
                   AND cb.class_instance_id = ci.id
                   AND cb.status <> 'cancelled'
              ), 0))::integer AS spots_remaining
         FROM class_instances ci
         JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
         JOIN resources r ON r.tenant_id = ci.tenant_id AND r.id = ci.resource_id
        WHERE ci.tenant_id = $1
          AND ci.cancelled_at IS NULL
          AND o.active
          AND o.allow_member_booking
          AND ci.start_time >= $2
          AND ci.start_time <  $3
          ${offeringClause}
        ORDER BY ci.start_time ASC
        LIMIT 200`,
      params,
    );
    res.json({ class_instances: result.rows });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// POST /api/class-bookings — member books a spot
// ============================================================
const createSchema = z.object({
  class_instance_id: z.string().uuid(),
});

export async function createMemberClassBooking(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member to book a class' });
    }
    const { tenant, db, user } = req;
    const member_id = user.member_id;

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { class_instance_id } = parsed.data;

    // Pull instance + its offering. RLS scopes by tenant; missing or
    // wrong-tenant id returns no rows. Trigger would also catch
    // cancelled / inactive / capacity, but we want clean app-level
    // errors before we touch the row.
    const ciRes = await db.query(
      `SELECT ci.id, ci.start_time, ci.cancelled_at,
              ci.capacity, o.duration_minutes, o.credit_cost,
              o.active AS offering_active,
              o.allow_member_booking
         FROM class_instances ci
         JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
        WHERE ci.tenant_id = $1 AND ci.id = $2`,
      [tenant.id, class_instance_id],
    );
    if (ciRes.rows.length === 0) {
      return res.status(404).json({ error: 'class instance not found' });
    }
    const ci = ciRes.rows[0];
    if (ci.cancelled_at) {
      return res.status(409).json({ error: 'class instance is cancelled' });
    }
    if (!ci.offering_active) {
      return res.status(409).json({ error: 'offering is inactive' });
    }
    if (!ci.allow_member_booking) {
      return res
        .status(403)
        .json({ error: 'offering does not allow member bookings' });
    }
    if (new Date(ci.start_time).getTime() <= Date.now()) {
      return res.status(409).json({
        error: 'cannot book a class instance whose start time has passed',
      });
    }

    // Advance-window policy. Same logic as createMemberBooking, just
    // applied to the class instance start_time.
    const policyRes = await db.query(
      `SELECT min_advance_booking_minutes, max_advance_booking_days
         FROM booking_policies WHERE tenant_id = $1`,
      [tenant.id],
    );
    const policy = policyRes.rows[0] ?? {
      min_advance_booking_minutes: 0,
      max_advance_booking_days: 30,
    };
    const minutesAhead =
      (new Date(ci.start_time).getTime() - Date.now()) / 60000;
    if (minutesAhead < policy.min_advance_booking_minutes) {
      return res.status(409).json({
        error: `bookings must be made at least ${policy.min_advance_booking_minutes} minutes in advance`,
      });
    }
    if (minutesAhead > policy.max_advance_booking_days * 1440) {
      return res.status(409).json({
        error: `bookings cannot be made more than ${policy.max_advance_booking_days} days in advance`,
      });
    }

    // INSERT. Capacity + validity triggers fire here; partial unique
    // index catches double-booking. We translate trigger error codes
    // to HTTP statuses.
    let booking;
    try {
      const insertRes = await db.query(
        `INSERT INTO class_bookings (
           tenant_id, class_instance_id, member_id, status,
           amount_due_cents, credit_cost_charged, payment_status
         ) VALUES (
           $1, $2, $3, 'confirmed', 0, $4, 'not_required'
         )
         RETURNING id, class_instance_id, member_id, status,
                   credit_cost_charged, payment_status, created_at`,
        [tenant.id, class_instance_id, member_id, ci.credit_cost],
      );
      booking = insertRes.rows[0];
    } catch (err) {
      // 23505 unique_violation — the partial unique index on
      // (tenant_id, class_instance_id, member_id) for non-cancelled
      // rows. Member already has a spot here.
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: 'you already have a spot in this class' });
      }
      // 23514 check_violation — capacity trigger or validity trigger.
      // Distinguish by message keyword for a more useful response.
      if (err.code === '23514') {
        if (/at capacity/i.test(err.message)) {
          return res.status(409).json({ error: 'class is full' });
        }
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    // Spend credits.
    try {
      const creditRes = await db.query(
        `SELECT entry_id, balance_after FROM apply_credit_change(
           $1, $2, $3, 'booking_spend', NULL, $4, NULL, $5
         )`,
        [tenant.id, member_id, -ci.credit_cost, user.user_id, booking.id],
      );
      const { entry_id, balance_after } = creditRes.rows[0];
      res.status(201).json({
        class_booking: booking,
        ledger_entry_id: entry_id,
        balance_after,
      });
    } catch (err) {
      if (err.code === '23514') {
        // insufficient credits / amount=0 / tenant mismatch — whole
        // tx rolls back, removing the INSERT above
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

// ============================================================
// GET /api/class-bookings/me — my class bookings
// ============================================================
export async function listMyClassBookings(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member to view class bookings' });
    }
    const result = await req.db.query(
      `SELECT cb.id, cb.class_instance_id, cb.status,
              cb.credit_cost_charged, cb.payment_status,
              cb.cancelled_at, cb.created_at,
              ci.start_time, ci.end_time,
              o.name AS offering_name,
              r.name AS resource_name
         FROM class_bookings cb
         JOIN class_instances ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
         JOIN offerings o        ON o.tenant_id = ci.tenant_id  AND o.id = ci.offering_id
         JOIN resources r        ON r.tenant_id = ci.tenant_id  AND r.id = ci.resource_id
        WHERE cb.tenant_id = $1 AND cb.member_id = $2
        ORDER BY ci.start_time DESC`,
      [req.tenant.id, req.user.member_id],
    );
    res.json({ class_bookings: result.rows });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// POST /api/class-bookings/:id/cancel — member self-cancel
// (admin can also call; honors booking_policies refund tiers)
// ============================================================
export async function cancelMemberClassBooking(req, res, next) {
  try {
    if (!req.user?.user_id) {
      return res.status(401).json({ error: 'authentication required' });
    }
    const { tenant, db, user } = req;
    const id = req.params.id;

    const cbRes = await db.query(
      `SELECT cb.id, cb.member_id, cb.class_instance_id, cb.status,
              cb.credit_cost_charged, cb.cancelled_at,
              ci.start_time
         FROM class_bookings cb
         JOIN class_instances ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
        WHERE cb.tenant_id = $1 AND cb.id = $2`,
      [tenant.id, id],
    );
    if (cbRes.rows.length === 0) {
      return res.status(404).json({ error: 'class booking not found' });
    }
    const cb = cbRes.rows[0];

    const isAdmin = !!user.admin_id;
    const isOwn = cb.member_id && cb.member_id === user.member_id;
    if (!isAdmin && !isOwn) {
      return res
        .status(403)
        .json({ error: 'cannot cancel a booking that does not belong to you' });
    }

    if (cb.status !== 'confirmed') {
      return res.status(409).json({
        error: `class booking is ${cb.status}; only confirmed bookings can be cancelled`,
      });
    }

    const policyRes = await db.query(
      `SELECT free_cancel_hours_before, partial_refund_hours_before,
              partial_refund_percent, allow_member_self_cancel
         FROM booking_policies WHERE tenant_id = $1`,
      [tenant.id],
    );
    const policy = policyRes.rows[0] ?? {
      free_cancel_hours_before: 24,
      partial_refund_hours_before: null,
      partial_refund_percent: null,
      allow_member_self_cancel: true,
    };
    if (!isAdmin && isOwn && !policy.allow_member_self_cancel) {
      return res
        .status(403)
        .json({ error: 'self-cancellation is disabled by tenant policy' });
    }

    const startMs = new Date(cb.start_time).getTime();
    const hoursBefore = (startMs - Date.now()) / (60 * 60 * 1000);
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
      (cb.credit_cost_charged * refundPercent) / 100,
    );

    await db.query(
      `UPDATE class_bookings
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

    let refund_entry_id = null;
    let balance_after = null;
    if (refundCredits > 0 && cb.member_id) {
      const refundRes = await db.query(
        `SELECT entry_id, balance_after FROM apply_credit_change(
           $1, $2, $3, 'booking_refund', NULL, $4, NULL, $5
         )`,
        [tenant.id, cb.member_id, refundCredits, user.user_id, cb.id],
      );
      refund_entry_id = refundRes.rows[0].entry_id;
      balance_after = refundRes.rows[0].balance_after;
    }

    res.json({
      class_booking_id: id,
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

// ============================================================
// POST /api/class-bookings/:id/mark-no-show — admin-only
// ============================================================
export async function markClassBookingNoShow(req, res, next) {
  try {
    if (!req.user?.admin_id) {
      return res.status(403).json({ error: 'admin role required' });
    }
    const { tenant, db, user } = req;
    const id = req.params.id;

    const cbRes = await db.query(
      `SELECT cb.id, cb.status, ci.start_time
         FROM class_bookings cb
         JOIN class_instances ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
        WHERE cb.tenant_id = $1 AND cb.id = $2`,
      [tenant.id, id],
    );
    if (cbRes.rows.length === 0) {
      return res.status(404).json({ error: 'class booking not found' });
    }
    const cb = cbRes.rows[0];
    if (cb.status !== 'confirmed') {
      return res.status(409).json({
        error: `class booking is ${cb.status}; only confirmed bookings can be marked no-show`,
      });
    }
    if (new Date(cb.start_time).getTime() > Date.now()) {
      return res.status(409).json({
        error: 'cannot mark no-show on a class instance whose start_time is in the future',
      });
    }

    const policyRes = await db.query(
      `SELECT no_show_action, no_show_fee_cents
         FROM booking_policies WHERE tenant_id = $1`,
      [tenant.id],
    );
    const policy = policyRes.rows[0] ?? {
      no_show_action: 'none',
      no_show_fee_cents: null,
    };

    await db.query(
      `UPDATE class_bookings
          SET status = 'no_show',
              no_show_marked_at = now(),
              no_show_marked_by = $1
        WHERE tenant_id = $2 AND id = $3`,
      [user.user_id, tenant.id, id],
    );

    res.json({
      class_booking_id: id,
      status: 'no_show',
      policy_action: policy.no_show_action,
      policy_fee_cents: policy.no_show_fee_cents,
    });
  } catch (err) {
    next(err);
  }
}
