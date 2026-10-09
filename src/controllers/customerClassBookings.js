// Walk-in (customer) CLASS booking — customer-side slice 4.
//
// The rental walk-in flow (customerBookings.js) only ever listed
// capacity-1 offerings; a walk-in couldn't buy a spot in a clinic.
// This is the class counterpart. Same contract, same trust model:
//
//   GET  /api/customers/classes          public schedule: upcoming
//        instances of public, priced class offerings + spots left
//   POST /api/customers/class-bookings   hold a spot (pending_payment,
//        30-min hold) → Stripe Checkout on the tenant's connected
//        account → webhook confirms (stripeWebhook.js
//        handleCustomerClassBookingPaid) or auto-refunds a payment that
//        lands after the hold lapsed. The janitor (cleanup.js) cancels
//        abandoned holds so a spot is never held forever.
//
// Rules carried over from the rental flow (don't regress):
//   * One price: the Checkout unit_amount IS offerings.dollar_price, one
//     line item, no fees.
//   * Guest-only: full name, mobile phone, email. No login.
//   * Waiver gate keyed on tenant config alone (non-enumerating), with
//     version echo; signature commits with the booking.
//   * Advance window enforced (shared helper).
//
// Deliberately NOT in this slice: no-login self-cancel / reschedule for
// class spots (no manage token on class_bookings) and the optional
// customer note (bookings-only column). The confirmation email tells
// them to reply to change anything.
//
// Capacity is enforced by the enforce_class_capacity trigger (migration
// 008), which counts pending holds; we also lock the instance row FOR
// UPDATE first so the count + insert serialize cleanly.

import { z } from 'zod';

import { advanceWindowViolation, getAdvancePolicy } from '../lib/advanceWindow.js';
import { getStripe } from '../services/stripe.js';
import { HOLD_DURATION_MINUTES, splitFullName } from './customerBookings.js';
import {
  WAIVER_REQUIRED_CODE,
  WAIVER_VERSION_MISMATCH_CODE,
  findMissingWaiverSignature,
  getWaiverConfig,
  waiverSignatureSchema,
} from './waivers.js';

const HOLD_DURATION_MS = HOLD_DURATION_MINUTES * 60 * 1000;
export const CLASS_FULL_CODE = 'class_full';

// ---------- GET /api/customers/classes ----------
//
// Only instances a walk-in could actually book right now: not
// cancelled, offering active + public + priced, start inside the
// advance window. Full instances ARE listed (spots_remaining 0) so the
// page can say "Full" instead of a class silently vanishing.
// Never exposes who is booked.
export async function listPublicClasses(req, res, next) {
  try {
    const { db, tenant } = req;
    const policy = await getAdvancePolicy(db, tenant.id);
    const from = new Date(Date.now() + policy.min_advance_booking_minutes * 60000);
    const to = new Date(Date.now() + policy.max_advance_booking_days * 86400000);

    const r = await db.query(
      `SELECT ci.id, ci.offering_id, ci.start_time, ci.end_time, ci.capacity,
              o.name AS offering_name, o.description, o.category,
              o.duration_minutes, o.dollar_price,
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
          AND o.allow_public_booking
          AND o.dollar_price > 0
          AND ci.start_time >= $2
          AND ci.start_time <= $3
        ORDER BY ci.start_time ASC
        LIMIT 200`,
      [tenant.id, from, to],
    );

    res.json({
      classes: r.rows.map((c) => ({
        ...c,
        // Overbooked-by-admin rosters never show negative.
        spots_remaining: Math.max(0, c.spots_remaining),
      })),
      policy: { hold_minutes: HOLD_DURATION_MINUTES },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- POST /api/customers/class-bookings ----------

const createSchema = z.object({
  class_instance_id: z.string().uuid(),
  customer: z.object({
    full_name: z.string().trim().min(1).max(300),
    phone: z.string().trim().min(7).max(30),
    email: z.string().email().transform((s) => s.toLowerCase().trim()),
  }),
  waiver: waiverSignatureSchema.optional(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

export async function createCustomerClassBooking(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { class_instance_id, customer, waiver, success_url, cancel_url } = parsed.data;
    const { tenant, db } = req;
    const name = splitFullName(customer.full_name);

    // Waiver gate — identical to the rental walk-in (see the long
    // comment in createCustomerBooking): config-keyed, never branches
    // on whether this email already signed.
    const waiverConfig = await getWaiverConfig(db, tenant.id);
    if (waiverConfig.waiver_required) {
      if (!waiver) {
        return res.status(409).json({
          error: 'a signed liability waiver is required before booking',
          code: WAIVER_REQUIRED_CODE,
          waiver_version: waiverConfig.waiver_version,
        });
      }
      if (waiver.waiver_version !== waiverConfig.waiver_version) {
        return res.status(409).json({
          error: 'the waiver was updated after it was displayed; reload it and sign again',
          code: WAIVER_VERSION_MISMATCH_CODE,
          waiver_version: waiverConfig.waiver_version,
        });
      }
    }
    const missingWaiver = await findMissingWaiverSignature(db, tenant.id, {
      customerEmail: customer.email,
    });

    // Lock the instance: serializes this check-then-insert against
    // concurrent buyers of the last spot (the capacity trigger is the
    // backstop).
    const ciRes = await db.query(
      `SELECT ci.id, ci.start_time, ci.cancelled_at, ci.capacity,
              o.name AS offering_name, o.active, o.allow_public_booking,
              o.dollar_price
         FROM class_instances ci
         JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
        WHERE ci.tenant_id = $1 AND ci.id = $2
        FOR UPDATE OF ci`,
      [tenant.id, class_instance_id],
    );
    if (ciRes.rows.length === 0) {
      return res.status(404).json({ error: 'class not found' });
    }
    const ci = ciRes.rows[0];
    if (ci.cancelled_at) {
      return res.status(409).json({ error: 'this class has been cancelled' });
    }
    if (!ci.active) {
      return res.status(409).json({ error: 'this class is no longer offered' });
    }
    if (!ci.allow_public_booking) {
      return res.status(403).json({ error: 'this class is for members only' });
    }
    if (ci.dollar_price <= 0) {
      return res.status(409).json({
        error: "this class can't be booked online — please book at the front desk",
      });
    }
    const start = new Date(ci.start_time);
    if (start.getTime() <= Date.now()) {
      return res.status(409).json({ error: 'this class has already started' });
    }
    const advanceViolation = advanceWindowViolation(await getAdvancePolicy(db, tenant.id), start);
    if (advanceViolation) {
      return res.status(409).json({ error: advanceViolation });
    }

    // One spot per email per class (customers have no unique index —
    // members do). Covers the double-tap and the "paid, then booked
    // again" mistake; a different email can still book a friend.
    const dup = await db.query(
      `SELECT 1 FROM class_bookings
        WHERE tenant_id = $1 AND class_instance_id = $2
          AND customer_email = $3 AND status <> 'cancelled'
        LIMIT 1`,
      [tenant.id, class_instance_id, customer.email],
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({
        error: 'this email already has a spot in this class — check your confirmation email',
        code: 'already_booked',
      });
    }

    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0 || !connRes.rows[0].charges_enabled) {
      return res.status(409).json({
        error: 'this facility cannot accept card payments online yet — please book at the front desk',
      });
    }
    const conn = connRes.rows[0];

    const hold = new Date(Math.min(Date.now() + HOLD_DURATION_MS, start.getTime()));

    let booking;
    try {
      const r = await db.query(
        `INSERT INTO class_bookings (
           tenant_id, class_instance_id,
           customer_first_name, customer_last_name, customer_email, customer_phone,
           status, hold_expires_at, amount_due_cents, credit_cost_charged, payment_status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', $7, $8, 0, 'pending')
         RETURNING id, class_instance_id, status, amount_due_cents, payment_status,
                   hold_expires_at, created_at`,
        [
          tenant.id,
          class_instance_id,
          name.first_name,
          name.last_name,
          customer.email,
          customer.phone,
          hold,
          ci.dollar_price,
        ],
      );
      booking = r.rows[0];
    } catch (err) {
      if (err.code === '23514' && /at capacity/.test(err.message)) {
        return res.status(409).json({
          error: 'sorry — this class just filled up',
          code: CLASS_FULL_CODE,
        });
      }
      throw err;
    }

    if (missingWaiver && waiver) {
      await db.query(
        `INSERT INTO waiver_signatures
           (tenant_id, customer_email, signer_name, guardian_name, is_minor, waiver_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenant.id,
          customer.email,
          waiver.signer_name,
          waiver.guardian_name ?? null,
          waiver.is_minor ?? false,
          missingWaiver.waiver_version,
        ],
      );
    }

    // The success page looks the spot up by id + email
    // (lookupCustomerBooking checks class_bookings too).
    const successUrl = new URL(success_url);
    successUrl.searchParams.set('booking_id', booking.id);

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
                unit_amount: ci.dollar_price,
                product_data: { name: ci.offering_name },
              },
              quantity: 1,
            },
          ],
          success_url: successUrl.toString(),
          cancel_url,
          // courtside_type routes the webhook to the class handler;
          // the class booking id is the routing key.
          metadata: {
            courtside_type: 'class_booking',
            courtside_tenant_id: tenant.id,
            courtside_class_booking_id: booking.id,
          },
          // Same expiry rule as the rental flow (see its comment).
          expires_at: Math.max(
            Math.floor(hold.getTime() / 1000),
            Math.floor(Date.now() / 1000) + 31 * 60,
          ),
        },
        { stripeAccount: conn.stripe_account_id },
      );
    } catch (err) {
      // >= 400 response → withTenantContext rolls back the hold AND
      // any waiver signature; nothing to clean up.
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }

    res.status(201).json({
      booking,
      checkout_url: session.url,
      session_id: session.id,
      hold_minutes: HOLD_DURATION_MINUTES,
    });
  } catch (err) {
    next(err);
  }
}
