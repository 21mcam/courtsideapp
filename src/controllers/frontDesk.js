// Front-desk booking operations (migration 037).
//
// Most of Momentum's bookings are entered by staff, not customers, so
// the front desk needs to do what Setmore's staff app does:
//
//   * POST /api/admin/bookings/:id/mark-paid    record an in-person
//     payment (cash / card / other) on a cash-on-arrival walk-in, so it
//     reaches revenue reports.
//   * POST /api/admin/bookings/:id/mark-unpaid  undo a mistaken
//     mark-paid (in-person payments only — Stripe money never moves
//     here).
//   * POST /api/admin/bookings/:id/reschedule   move a booking to a new
//     time and/or resource without cancel + rebook (which emailed a
//     cancellation and dropped the original row's history).
//
// Staff overrides match createAdminBooking: operating hours, the
// advance window, the customer reschedule cutoff and the self-serve
// visibility flags don't apply; blackouts, overlapping bookings and
// class instances still 409. staffSlotConflict() is the shared check.

import { z } from 'zod';

import { sendBookingReschedule } from '../services/email.js';

// Mark this transaction as a staff booking so enforce_booking_validity
// skips the allow_public_booking / allow_member_booking checks
// (migration 037). Transaction-local, like app.current_tenant_id.
export async function markStaffBookingSource(db) {
  await db.query("SELECT set_config('app.booking_source', 'staff', true)");
}

// Returns a { status, error } to send, or null when [start, end) on the
// resource is free. excludeBookingId lets a booking move within its own
// current window.
export async function staffSlotConflict(
  db,
  tenantId,
  { offering_id, resource_id, start, end, excludeBookingId = null },
) {
  const blackout = await db.query(
    `SELECT 1 FROM blackouts
      WHERE tenant_id = $1
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
        AND (
          (resource_id IS NULL AND offering_id IS NULL)
          OR resource_id = $4
          OR offering_id = $5
        )
      LIMIT 1`,
    [tenantId, start, end, resource_id, offering_id],
  );
  if (blackout.rows.length > 0) {
    return { status: 409, error: 'requested slot is blacked out' };
  }
  const booked = await db.query(
    `SELECT 1 FROM bookings
      WHERE tenant_id = $1 AND resource_id = $2
        AND status <> 'cancelled'
        AND time_range && tstzrange($3, $4, '[)')
        AND ($5::uuid IS NULL OR id <> $5)
      LIMIT 1`,
    [tenantId, resource_id, start, end, excludeBookingId],
  );
  if (booked.rows.length > 0) {
    return { status: 409, error: 'slot already booked' };
  }
  const classes = await db.query(
    `SELECT 1 FROM class_instances
      WHERE tenant_id = $1 AND resource_id = $2
        AND cancelled_at IS NULL
        AND time_range && tstzrange($3, $4, '[)')
      LIMIT 1`,
    [tenantId, resource_id, start, end],
  );
  if (classes.rows.length > 0) {
    return { status: 409, error: 'slot conflicts with an existing class instance' };
  }
  return null;
}

const idSchema = z.string().uuid();

// ---------- mark paid / unpaid ----------

const markPaidSchema = z.object({
  method: z.enum(['cash', 'card', 'other']).default('cash'),
});

export async function markBookingPaid(req, res, next) {
  try {
    const id = idSchema.safeParse(req.params.id);
    const parsed = markPaidSchema.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) {
      return res.status(400).json({
        error: 'invalid input',
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const { db, tenant, user } = req;

    const cur = await db.query(
      `SELECT id, member_id, status, payment_status, amount_due_cents,
              stripe_payment_intent_id
         FROM bookings
        WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
      [tenant.id, id.data],
    );
    const b = cur.rows[0];
    if (!b) return res.status(404).json({ error: 'booking not found' });
    if (b.member_id) {
      return res.status(409).json({ error: 'member bookings are paid with credits' });
    }
    if (b.payment_status === 'paid') {
      return res.status(409).json({ error: 'booking is already paid' });
    }
    if (b.payment_status !== 'pending' || b.amount_due_cents <= 0) {
      return res.status(409).json({ error: 'nothing is owed on this booking' });
    }
    if (b.stripe_payment_intent_id || b.status === 'pending_payment') {
      // An online checkout in progress — Stripe settles it, not staff.
      return res.status(409).json({ error: 'this booking is waiting on online payment' });
    }
    if (b.status === 'cancelled') {
      return res.status(409).json({ error: 'booking is cancelled' });
    }

    const upd = await db.query(
      `UPDATE bookings
          SET payment_status = 'paid',
              amount_paid_cents = amount_due_cents,
              payment_method = $3,
              paid_at = now(),
              paid_marked_by = $4
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, payment_status, amount_due_cents, amount_paid_cents,
                  payment_method, paid_at`,
      [tenant.id, b.id, parsed.data.method, user.user_id],
    );
    res.json({ booking: upd.rows[0] });
  } catch (err) {
    next(err);
  }
}

export async function markBookingUnpaid(req, res, next) {
  try {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'invalid booking id' });
    const { db, tenant } = req;

    const cur = await db.query(
      `SELECT id, payment_status, payment_method, amount_refunded_cents
         FROM bookings
        WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
      [tenant.id, id.data],
    );
    const b = cur.rows[0];
    if (!b) return res.status(404).json({ error: 'booking not found' });
    if (!b.payment_method || b.payment_status !== 'paid' || b.amount_refunded_cents > 0) {
      return res.status(409).json({
        error: 'only an in-person payment recorded by staff can be undone',
      });
    }

    const upd = await db.query(
      `UPDATE bookings
          SET payment_status = 'pending',
              amount_paid_cents = 0,
              payment_method = NULL,
              paid_at = NULL,
              paid_marked_by = NULL
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, payment_status, amount_due_cents, amount_paid_cents,
                  payment_method, paid_at`,
      [tenant.id, b.id],
    );
    res.json({ booking: upd.rows[0] });
  } catch (err) {
    next(err);
  }
}

// ---------- reschedule ----------

const MAX_STAFF_BOOKING_MINUTES = 24 * 60;

const rescheduleSchema = z.object({
  start_time: z.string().datetime({ message: 'start_time must be ISO 8601' }),
  // Omitted = keep the booking's current length.
  end_time: z.string().datetime({ message: 'end_time must be ISO 8601' }).optional(),
  // Omitted = stay on the current resource.
  resource_id: z.string().uuid().optional(),
  // Email the person the new time (when we have an address).
  notify: z.boolean().default(true),
});

export async function rescheduleAdminBooking(req, res, next) {
  try {
    const id = idSchema.safeParse(req.params.id);
    const parsed = rescheduleSchema.safeParse(req.body ?? {});
    if (!id.success || !parsed.success) {
      return res.status(400).json({
        error: 'invalid input',
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
    }
    const { db, tenant } = req;

    const cur = await db.query(
      `SELECT b.id, b.status, b.offering_id, b.resource_id, b.member_id,
              b.start_time, b.end_time,
              b.customer_first_name, b.customer_email,
              m.email AS member_email, m.first_name AS member_first_name,
              o.name AS offering_name
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
    LEFT JOIN members m ON m.tenant_id = b.tenant_id AND m.id = b.member_id
        WHERE b.tenant_id = $1 AND b.id = $2
          FOR UPDATE OF b`,
      [tenant.id, id.data],
    );
    const b = cur.rows[0];
    if (!b) return res.status(404).json({ error: 'booking not found' });
    if (b.status !== 'confirmed') {
      return res.status(409).json({ error: `can't move a ${b.status.replace('_', ' ')} booking` });
    }

    const start = new Date(parsed.data.start_time);
    const end = parsed.data.end_time
      ? new Date(parsed.data.end_time)
      : new Date(start.getTime() + (new Date(b.end_time) - new Date(b.start_time)));
    if (end <= start) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }
    if ((end - start) / 60000 > MAX_STAFF_BOOKING_MINUTES) {
      return res.status(400).json({ error: 'booking cannot be longer than 24 hours' });
    }
    const resource_id = parsed.data.resource_id ?? b.resource_id;
    const sameSpot =
      resource_id === b.resource_id &&
      start.getTime() === new Date(b.start_time).getTime() &&
      end.getTime() === new Date(b.end_time).getTime();
    if (sameSpot) {
      return res.status(400).json({ error: 'that is the booking’s current time and resource' });
    }

    // Same offering on the new resource, and lock the resource row to
    // serialize against concurrent creates (same pattern as create).
    const target = await db.query(
      `SELECT r.active, r.name, orx.active AS link_active
         FROM resources r
    LEFT JOIN offering_resources orx
           ON orx.tenant_id = r.tenant_id
          AND orx.resource_id = r.id
          AND orx.offering_id = $3
        WHERE r.tenant_id = $1 AND r.id = $2
          FOR UPDATE OF r`,
      [tenant.id, resource_id, b.offering_id],
    );
    const t = target.rows[0];
    if (!t) return res.status(404).json({ error: 'resource not found' });
    if (!t.active) return res.status(409).json({ error: 'resource is inactive' });
    if (!t.link_active) {
      return res.status(409).json({ error: `${b.offering_name} isn't offered on ${t.name}` });
    }

    const conflict = await staffSlotConflict(db, tenant.id, {
      offering_id: b.offering_id,
      resource_id,
      start,
      end,
      excludeBookingId: b.id,
    });
    if (conflict) return res.status(conflict.status).json({ error: conflict.error });

    await markStaffBookingSource(db);
    let updated;
    try {
      const upd = await db.query(
        `UPDATE bookings
            SET resource_id = $3,
                start_time = $4,
                end_time = $5,
                previous_start_time = start_time,
                rescheduled_at = now(),
                reschedule_count = reschedule_count + 1,
                reminder_sent_at = NULL
          WHERE tenant_id = $1 AND id = $2
          RETURNING id, resource_id, start_time, end_time, previous_start_time,
                    reschedule_count, status`,
        [tenant.id, b.id, resource_id, start, end],
      );
      updated = upd.rows[0];
    } catch (err) {
      if (err.code === '23P01') {
        return res.status(409).json({ error: 'slot already booked (concurrent)' });
      }
      throw err;
    }

    // Tell them the new time — after COMMIT, fire-and-forget (same as
    // the other booking emails). The walk-in's manage link from the
    // original confirmation keeps working (its token hash is
    // unchanged), but we can't re-send it: only the hash is stored.
    // TODO: outbox for reliability-critical delivery.
    const to = b.member_id ? b.member_email : b.customer_email;
    if (parsed.data.notify && to) {
      res.on('finish', () => {
        sendBookingReschedule({
          tenant,
          to,
          recipientName: b.member_id ? b.member_first_name : b.customer_first_name,
          offeringName: b.offering_name,
          resourceName: t.name,
          previousStartTime: b.start_time,
          startTime: updated.start_time,
        }).catch((err) => console.error('[email] staff reschedule send failed:', err));
      });
    }

    res.json({ booking: updated, notified: Boolean(parsed.data.notify && to) });
  } catch (err) {
    next(err);
  }
}
