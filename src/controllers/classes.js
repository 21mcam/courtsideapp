// Class-instance admin endpoints — Phase 4 slice 1.
//
// One-off class instances only for now (class_schedule_id = NULL).
// Recurring schedules + the instance generator land in slice 2.
//
// Three endpoints:
//   POST   /api/admin/class-instances           create
//   GET    /api/admin/class-instances           list (date filter)
//   POST   /api/admin/class-instances/:id/cancel  cancel + cascade
//
// All run inside withTenantContext + requireAdmin (mounted at the
// /api/admin router level).

import { z } from 'zod';

// Create. Capacity defaults to offering.capacity. Resource is
// validated by the schema's enforce_class_instance_validity trigger;
// we surface trigger errors as 409 with a useful message.
const createSchema = z.object({
  offering_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  start_time: z.string().datetime({
    message: 'start_time must be ISO 8601',
  }),
  // Optional override. Must be >= 1; the trigger enforces offering
  // capacity is > 1, but per-instance capacity is allowed to differ
  // (admin might run a smaller version of a class).
  capacity: z.number().int().min(1).optional(),
});

export async function createClassInstance(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { offering_id, resource_id, start_time, capacity } = parsed.data;
    const { tenant, db } = req;

    // Pull offering for duration + default capacity. Trigger will also
    // validate but we want a clean 404 / 409 here for predictable UX.
    const offerRes = await db.query(
      `SELECT id, duration_minutes, capacity, active
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
    if (offering.capacity === 1) {
      return res.status(409).json({
        error: 'offering is a rental (capacity 1); use bookings instead',
      });
    }

    const start = new Date(start_time);
    const end = new Date(start.getTime() + offering.duration_minutes * 60 * 1000);
    const finalCapacity = capacity ?? offering.capacity;

    try {
      const result = await db.query(
        `INSERT INTO class_instances (
           tenant_id, class_schedule_id, offering_id, resource_id,
           start_time, end_time, capacity
         ) VALUES (
           $1, NULL, $2, $3, $4, $5, $6
         )
         RETURNING id, class_schedule_id, offering_id, resource_id,
                   start_time, end_time, capacity, cancelled_at, created_at`,
        [tenant.id, offering_id, resource_id, start, end, finalCapacity],
      );
      res.status(201).json({ class_instance: result.rows[0] });
    } catch (err) {
      // Trigger / constraint translations.
      // 23P01 — gist exclusion (overlap on resource)
      if (err.code === '23P01') {
        return res.status(409).json({
          error: 'class instance overlaps with another non-cancelled instance on this resource',
        });
      }
      // 23503 — composite FK miss (offering_resources link missing)
      if (err.code === '23503') {
        return res.status(409).json({
          error: 'offering is not offered on this resource (link missing or inactive)',
        });
      }
      // 23514 — check / trigger raised check_violation (inactive
      // resource, capacity = 1, etc.)
      if (err.code === '23514') {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// List. Date window filter; default [today-7d, today+60d). Joined
// with offering + resource + a roster-size count so the calendar
// view can show "3/8 booked" without an extra request.
const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  include_cancelled: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

export async function listClassInstances(req, res, next) {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { from, to, include_cancelled } = parsed.data;

    const fromTs = from
      ? new Date(from)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toTs = to
      ? new Date(to)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    if (fromTs >= toTs) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    const cancelledClause = include_cancelled
      ? ''
      : 'AND ci.cancelled_at IS NULL';

    const result = await req.db.query(
      `SELECT ci.id, ci.class_schedule_id, ci.offering_id, ci.resource_id,
              ci.start_time, ci.end_time, ci.capacity,
              ci.cancelled_at, ci.cancellation_reason, ci.created_at,
              o.name AS offering_name,
              r.name AS resource_name,
              COALESCE((
                SELECT count(*) FROM class_bookings cb
                 WHERE cb.tenant_id = ci.tenant_id
                   AND cb.class_instance_id = ci.id
                   AND cb.status <> 'cancelled'
              ), 0)::integer AS roster_count
         FROM class_instances ci
         JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
         JOIN resources r ON r.tenant_id = ci.tenant_id AND r.id = ci.resource_id
        WHERE ci.tenant_id = $1
          AND ci.start_time >= $2
          AND ci.start_time <  $3
          ${cancelledClause}
        ORDER BY ci.start_time ASC
        LIMIT 500`,
      [req.tenant.id, fromTs, toTs],
    );
    res.json({ class_instances: result.rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/class-instances/:id/roster — list every class_booking
// for the instance, with member name + email when present, customer
// fields when not, and the current status. Used by the admin roster
// view to know who's coming and to fire cancel / mark-no-show.
export async function getClassInstanceRoster(req, res, next) {
  try {
    const { tenant, db } = req;
    const id = req.params.id;

    // Confirm the instance exists in this tenant before returning a
    // roster — distinguish 404 (no such instance) from 200 with an
    // empty roster (instance exists but nobody's signed up).
    const ciRes = await db.query(
      `SELECT ci.id, ci.start_time, ci.end_time, ci.capacity,
              ci.cancelled_at, ci.cancellation_reason,
              o.name AS offering_name,
              r.name AS resource_name
         FROM class_instances ci
         JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
         JOIN resources r ON r.tenant_id = ci.tenant_id AND r.id = ci.resource_id
        WHERE ci.tenant_id = $1 AND ci.id = $2`,
      [tenant.id, id],
    );
    if (ciRes.rows.length === 0) {
      return res.status(404).json({ error: 'class instance not found' });
    }
    const instance = ciRes.rows[0];

    const rosterRes = await db.query(
      `SELECT cb.id, cb.member_id, cb.status, cb.credit_cost_charged,
              cb.created_at, cb.cancelled_at, cb.cancelled_by_type,
              cb.no_show_marked_at,
              cb.customer_first_name, cb.customer_last_name, cb.customer_email,
              m.first_name AS member_first_name,
              m.last_name  AS member_last_name,
              m.email      AS member_email
         FROM class_bookings cb
    LEFT JOIN members m ON m.tenant_id = cb.tenant_id AND m.id = cb.member_id
        WHERE cb.tenant_id = $1 AND cb.class_instance_id = $2
        ORDER BY cb.created_at ASC`,
      [tenant.id, id],
    );
    res.json({ instance, roster: rosterRes.rows });
  } catch (err) {
    next(err);
  }
}

// Cancel an instance. Cascades to its class_bookings: any non-cancelled
// roster row gets cancelled_at + cancelled_by_type='admin', and member
// bookings get a credit refund via apply_credit_change.
//
// All in one transaction so a partial failure rolls back. Refunds on
// admin cancel are 100% — the tenant cancelled the class, not the
// member, so the booking_policies refund-tier rules don't apply.
export async function cancelClassInstance(req, res, next) {
  try {
    const { tenant, db, user } = req;
    const id = req.params.id;
    const reason =
      typeof req.body?.cancellation_reason === 'string'
        ? req.body.cancellation_reason
        : null;

    const ciRes = await db.query(
      `SELECT id, cancelled_at FROM class_instances
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    );
    if (ciRes.rows.length === 0) {
      return res.status(404).json({ error: 'class instance not found' });
    }
    if (ciRes.rows[0].cancelled_at) {
      return res
        .status(409)
        .json({ error: 'class instance is already cancelled' });
    }

    // Pull the roster of non-cancelled bookings BEFORE we update them
    // — we need to refund member credits one-by-one through
    // apply_credit_change. customers (no member_id) just get cancelled;
    // payment refunds via Stripe land with phase 5.
    const rosterRes = await db.query(
      `SELECT id, member_id, credit_cost_charged
         FROM class_bookings
        WHERE tenant_id = $1 AND class_instance_id = $2 AND status <> 'cancelled'`,
      [tenant.id, id],
    );

    // Cancel the instance.
    await db.query(
      `UPDATE class_instances
          SET cancelled_at = now(),
              cancellation_reason = $1,
              cancelled_by_user_id = $2
        WHERE tenant_id = $3 AND id = $4`,
      [reason, user.user_id, tenant.id, id],
    );

    // Cancel each roster row + refund member credits.
    let refunded_count = 0;
    for (const row of rosterRes.rows) {
      await db.query(
        `UPDATE class_bookings
            SET status = 'cancelled',
                cancelled_at = now(),
                cancelled_by_type = 'admin',
                cancelled_by_user_id = $1,
                cancellation_reason = $2
          WHERE tenant_id = $3 AND id = $4`,
        [
          user.user_id,
          reason ?? 'class instance cancelled',
          tenant.id,
          row.id,
        ],
      );
      if (row.member_id && row.credit_cost_charged > 0) {
        // 100% refund — admin-initiated cancel.
        await db.query(
          `SELECT entry_id FROM apply_credit_change(
             $1, $2, $3, 'booking_refund', NULL, $4, NULL, $5
           )`,
          [
            tenant.id,
            row.member_id,
            row.credit_cost_charged,
            user.user_id,
            row.id,
          ],
        );
        refunded_count += 1;
      }
    }

    res.json({
      class_instance_id: id,
      cancelled_at: new Date().toISOString(),
      roster_cancelled: rosterRes.rows.length,
      members_refunded: refunded_count,
    });
  } catch (err) {
    next(err);
  }
}
