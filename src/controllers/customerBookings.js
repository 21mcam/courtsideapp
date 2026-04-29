// Walk-in (customer) booking flow — Phase 5 slice 7.
//
// Public endpoint, no auth. The walk-in fills in contact info, picks
// a slot, and is redirected to a Stripe-hosted Checkout page to pay.
// On payment success the webhook flips the booking to confirmed +
// paid (handled in stripeWebhook.js).
//
// Identity is captured inline on the booking row (customer_first_name
// etc.) — no users / customers table lookup. v1.1 may dedupe.
//
// Lifecycle:
//   1. POST /api/customers/bookings → INSERT with status='pending_payment',
//      hold_expires_at = now+15min, payment_status='pending'. Returns
//      Stripe Checkout URL.
//   2. (User pays on Stripe-hosted page.)
//   3. webhook checkout.session.completed (mode='payment') flips the
//      booking to status='confirmed', payment_status='paid', stamps
//      stripe_payment_intent_id and amount_paid_cents.
//   4. If user abandons, the hold expires at start_time bound (or our
//      app-level 15min cap). A future janitor cleans stale rows;
//      until then, manual cleanup or the partial GiST exclusion will
//      reject conflicting bookings until cancellation runs through.
//
// The 15min hold is a CHECK that hold_expires_at <= start_time, so
// for slots starting in <15min the hold is shorter (clamped). Same
// behavior the schema explicitly designs.

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';

const HOLD_DURATION_MS = 15 * 60 * 1000;

const createSchema = z.object({
  offering_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  start_time: z.string().datetime({
    message: 'start_time must be ISO 8601 (e.g. 2027-01-04T14:00:00.000Z)',
  }),
  customer: z.object({
    first_name: z.string().trim().min(1).max(200),
    last_name: z.string().trim().min(1).max(200),
    email: z.string().email().transform((s) => s.toLowerCase().trim()),
    phone: z.string().trim().optional(),
  }),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

export async function createCustomerBooking(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const {
      offering_id,
      resource_id,
      start_time,
      customer,
      success_url,
      cancel_url,
    } = parsed.data;
    const { tenant, db } = req;

    // 1. Offering must allow public booking + capacity 1.
    const offerRes = await db.query(
      `SELECT id, name, duration_minutes, capacity, dollar_price,
              active, allow_public_booking
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
        error: 'class offerings use a different booking flow',
      });
    }
    if (!offering.allow_public_booking) {
      return res
        .status(403)
        .json({ error: 'offering does not allow public bookings' });
    }
    if (offering.dollar_price <= 0) {
      return res.status(409).json({
        error: 'offering has no dollar price; cannot collect payment',
      });
    }

    // 2. Offering↔resource link active.
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

    // 3. Compute window.
    const start = new Date(start_time);
    const end = new Date(start.getTime() + offering.duration_minutes * 60 * 1000);
    if (start.getTime() <= Date.now()) {
      return res
        .status(409)
        .json({ error: 'start_time must be in the future' });
    }

    // 4. Lock resource row to serialize concurrent walk-in attempts.
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

    // 5a. Operating hours.
    const dateAndDow = await db.query(
      `SELECT
         (($1::timestamptz AT TIME ZONE $2)::date) AS local_date,
         EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE $2))::integer AS dow`,
      [start.toISOString(), tenant.timezone],
    );
    const { local_date, dow } = dateAndDow.rows[0];
    const opCheck = await db.query(
      `SELECT 1 FROM operating_hours
        WHERE tenant_id = $1 AND resource_id = $2 AND day_of_week = $3
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

    // 5b. Blackouts.
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
      return res.status(409).json({ error: 'requested slot is blacked out' });
    }

    // 5c. Existing non-cancelled bookings on this resource. The
    //     pending_payment booking we're about to insert ALSO occupies
    //     the slot via the GiST exclusion (status <> 'cancelled')
    //     so this gate prevents double-pending too.
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

    // 5d. Class instances on this resource.
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

    // 6. Stripe connection must be charges-enabled.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0 || !connRes.rows[0].charges_enabled) {
      return res
        .status(409)
        .json({ error: 'tenant cannot accept card payments yet' });
    }
    const conn = connRes.rows[0];

    // 7. Compute hold_expires_at: min(now+15min, start_time). Schema
    //    CHECK enforces hold_expires_at <= start_time as the upper
    //    bound; we tighten with the app-level 15min cap.
    const hold = new Date(
      Math.min(Date.now() + HOLD_DURATION_MS, start.getTime()),
    );

    // 8. INSERT the pending booking. We commit it BEFORE talking to
    //    Stripe so the slot is locked under our exclusion constraint.
    //    If the Stripe call fails afterwards the booking row stays
    //    in pending_payment until the hold expires (at which point
    //    a future janitor cancels it). Worst case: a 15-minute slot
    //    hold for a customer who walked away. Acceptable.
    let booking;
    try {
      const r = await db.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id,
           customer_first_name, customer_last_name,
           customer_email, customer_phone,
           start_time, end_time, status, hold_expires_at,
           amount_due_cents, credit_cost_charged, payment_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           'pending_payment', $10, $11, 0, 'pending'
         )
         RETURNING id, offering_id, resource_id, start_time, end_time,
                   status, amount_due_cents, payment_status,
                   hold_expires_at, created_at`,
        [
          tenant.id,
          offering_id,
          resource_id,
          customer.first_name,
          customer.last_name,
          customer.email,
          customer.phone ?? null,
          start,
          end,
          hold,
          offering.dollar_price,
        ],
      );
      booking = r.rows[0];
    } catch (err) {
      if (err.code === '23P01') {
        return res
          .status(409)
          .json({ error: 'slot already booked (concurrent)' });
      }
      throw err;
    }

    // 9. Create Checkout Session in mode='payment' on the connected
    //    account. price_data is inline so we don't have to mint a
    //    Stripe Product per offering.
    let session;
    try {
      session = await getStripe().checkout.sessions.create(
        {
          mode: 'payment',
          customer_email: customer.email,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                unit_amount: offering.dollar_price,
                product_data: {
                  name: offering.name,
                },
              },
              quantity: 1,
            },
          ],
          success_url,
          cancel_url,
          // Critical: the webhook reads these to find which booking
          // to flip. courtside_tenant_id is duplicated for the
          // tenant cross-check; courtside_booking_id is the routing
          // key.
          metadata: {
            courtside_tenant_id: tenant.id,
            courtside_booking_id: booking.id,
          },
          // Stripe's `expires_at` requires >= 30min ahead, but our
          // DB-side hold is often shorter. Don't set it; rely on
          // Stripe's 24h default + the webhook checking the booking
          // status when it flips it ('pending_payment' guard means
          // a cancelled-meanwhile booking won't get re-confirmed).
        },
        { stripeAccount: conn.stripe_account_id },
      );
    } catch (err) {
      // Best effort: cancel the booking we just inserted so the slot
      // isn't held for 15 minutes by a Stripe error.
      await db
        .query(
          `UPDATE bookings SET status = 'cancelled', cancelled_at = now(),
              cancellation_reason = 'stripe checkout session creation failed'
           WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, booking.id],
        )
        .catch(() => {});
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }

    res.status(201).json({
      booking,
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    next(err);
  }
}
