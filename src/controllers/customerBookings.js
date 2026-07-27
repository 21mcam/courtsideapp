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
//      hold_expires_at = now + HOLD_DURATION_MINUTES, payment_status =
//      'pending'. Returns Stripe Checkout URL.
//   2. (User pays on Stripe-hosted page.)
//   3. webhook checkout.session.completed (mode='payment') flips the
//      booking to status='confirmed', payment_status='paid', stamps
//      stripe_payment_intent_id and amount_paid_cents.
//   4. If user abandons, the hold expires at start_time bound (or our
//      app-level 30min cap) and the janitor sweep (cleanup.js)
//      cancels the row.
//
// The 30min hold is a CHECK that hold_expires_at <= start_time, so
// for slots starting in <30min the hold is shorter (clamped). Same
// behavior the schema explicitly designs.
//
// Hold duration is 30 minutes because that's Stripe Checkout's
// MINIMUM session expires_at. We set expires_at on the session to
// the same instant the hold expires (clamped up to Stripe's 30min
// floor), so the janitor cancelling an expired hold and the customer
// still being able to pay can barely overlap. The residual race
// (slot starting in <30min: hold clamps to start_time, session lives
// the full 30min) is closed by the webhook auto-refunding payments
// that land on a booking no longer in pending_payment.

import crypto from 'node:crypto';

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';
import { sendBookingReschedule, buildManageUrl } from '../services/email.js';
import {
  getAdvancePolicy,
  advanceWindowViolation,
} from '../lib/advanceWindow.js';
import {
  getWaiverConfig,
  findMissingWaiverSignature,
  waiverSignatureSchema,
  WAIVER_REQUIRED_CODE,
  WAIVER_VERSION_MISMATCH_CODE,
} from './waivers.js';

// Stripe's minimum Checkout session lifetime is 30 minutes; the DB
// hold matches so the two expire together (see header). Exported so
// the create response (and through it, UI copy) derives from the one
// constant — the old flow hardcoded "held for 15 minutes" in copy and
// drifted.
export const HOLD_DURATION_MINUTES = 30;
const HOLD_DURATION_MS = HOLD_DURATION_MINUTES * 60 * 1000;

// The checkout form asks for one "Full name" field (every extra
// mobile field costs completions); the bookings schema stores
// first/last with non-empty CHECKs on both. Last token = last name,
// everything before it = first name. Single-token names ("Cher")
// duplicate into both columns — the alternative is rewriting the
// load-bearing member-XOR-customer CHECK from migration 007.
export function splitFullName(fullName) {
  const tokens = fullName.trim().split(/\s+/);
  if (tokens.length === 1) {
    return { first_name: tokens[0], last_name: tokens[0] };
  }
  return {
    first_name: tokens.slice(0, -1).join(' '),
    last_name: tokens[tokens.length - 1],
  };
}

const createSchema = z.object({
  offering_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  start_time: z.string().datetime({
    message: 'start_time must be ISO 8601 (e.g. 2027-01-04T14:00:00.000Z)',
  }),
  customer: z.object({
    full_name: z.string().trim().min(1).max(300),
    // Required: the facility needs a same-day contact channel for a
    // prepaid slot. Loose shape check only — real-world phone formats
    // are chaos and over-validation costs completions.
    phone: z.string().trim().min(7).max(30),
    email: z.string().email().transform((s) => s.toLowerCase().trim()),
  }),
  // Optional "Anything we should know?" note. Empty/whitespace →
  // treated as absent (DB CHECK rejects blank non-null).
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((s) => (s ? s : undefined)),
  // Inline liability waiver — required (409 below) when the tenant's
  // booking_policies.waiver_required is on and this email hasn't
  // signed the current version yet. Recorded in the SAME transaction
  // as the booking row.
  waiver: waiverSignatureSchema.optional(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

// sha256 hex of a manage token — the only form that ever touches the
// DB (bookings.manage_token_hash).
export function hashManageToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Slot validation shared by create and reschedule. Returns
// { status, body } to send, or null when the slot is bookable.
//
// Resource-DEPENDENT failures carry code 'slot_conflict': the walk-in
// UI's "No preference" flow retries the same time on the next
// resource only for these (lib/availability.js). Failures that would
// hit every resource identically (past time, advance window) stay
// uncoded so the client surfaces the real error instead of looping on
// "that time was just taken".
//
// Locks the resource row FOR UPDATE to serialize concurrent attempts;
// the caller's INSERT/UPDATE in the same transaction is protected.
// `excludeBookingId` lets a reschedule shift within its own slot on
// the same resource without colliding with itself.
async function validateCustomerSlot(
  db,
  tenant,
  { offering_id, resource_id, start, end, excludeBookingId = null },
) {
  const conflict = (error) => ({
    status: 409,
    body: { error, code: 'slot_conflict' },
  });

  // Link active.
  const linkRes = await db.query(
    `SELECT active FROM offering_resources
      WHERE tenant_id = $1 AND offering_id = $2 AND resource_id = $3`,
    [tenant.id, offering_id, resource_id],
  );
  if (linkRes.rows.length === 0 || !linkRes.rows[0].active) {
    return conflict('offering not offered on this resource');
  }

  // Past time.
  if (start.getTime() <= Date.now()) {
    return {
      status: 409,
      body: {
        error: 'that time has already passed — please pick an upcoming time',
      },
    };
  }

  // Advance-booking window (shared with the member path — the old
  // walk-in flow skipped this gate entirely).
  const advancePolicy = await getAdvancePolicy(db, tenant.id);
  const advanceViolation = advanceWindowViolation(advancePolicy, start);
  if (advanceViolation) {
    return { status: 409, body: { error: advanceViolation } };
  }

  // Lock resource row to serialize concurrent attempts.
  const lockRes = await db.query(
    `SELECT active FROM resources
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenant.id, resource_id],
  );
  if (lockRes.rows.length === 0) {
    return { status: 404, body: { error: 'resource not found' } };
  }
  if (!lockRes.rows[0].active) {
    return conflict('resource is inactive');
  }

  // Operating hours.
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
    return conflict('requested slot is outside operating hours');
  }

  // Blackouts.
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
    return conflict('requested slot is blacked out');
  }

  // Existing non-cancelled bookings on this resource. A
  // pending_payment booking ALSO occupies the slot via the GiST
  // exclusion (status <> 'cancelled') so this gate prevents
  // double-pending too. excludeBookingId keeps a reschedule from
  // colliding with its own current slot.
  const overlapBookings = await db.query(
    `SELECT 1 FROM bookings
      WHERE tenant_id = $1 AND resource_id = $2
        AND status <> 'cancelled'
        AND time_range && tstzrange($3, $4, '[)')
        AND ($5::uuid IS NULL OR id <> $5)
      LIMIT 1`,
    [tenant.id, resource_id, start, end, excludeBookingId],
  );
  if (overlapBookings.rows.length > 0) {
    return conflict('slot already booked');
  }

  // Class instances on this resource.
  const overlapClasses = await db.query(
    `SELECT 1 FROM class_instances
      WHERE tenant_id = $1 AND resource_id = $2
        AND cancelled_at IS NULL
        AND time_range && tstzrange($3, $4, '[)')
      LIMIT 1`,
    [tenant.id, resource_id, start, end],
  );
  if (overlapClasses.rows.length > 0) {
    return conflict('slot conflicts with an existing class instance');
  }

  return null;
}

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
      note,
      waiver,
      success_url,
      cancel_url,
    } = parsed.data;
    const { tenant, db } = req;
    const customerName = splitFullName(customer.full_name);

    // 0. Liability waiver gate. When the tenant requires a waiver,
    //    EVERY walk-in booking request must carry the inline waiver
    //    fields (the walk-in form always renders them; this 409 is
    //    the backstop for clients that skip it). Deliberately keyed
    //    on config alone, NOT on whether this email already signed —
    //    branching on prior-signature existence would let an
    //    unauthenticated caller probe arbitrary emails for "has this
    //    person visited since the last waiver edit" (the lookup
    //    endpoint was carefully made non-enumerating; this one must
    //    not leak either). Duplicate signatures are simply not
    //    re-inserted (step 8b). The signature row is inserted AFTER
    //    the booking INSERT succeeds — same transaction, so it
    //    commits iff the booking commits.
    const waiverConfig = await getWaiverConfig(db, tenant.id);
    if (waiverConfig.waiver_required) {
      if (!waiver) {
        return res.status(409).json({
          error: 'a signed liability waiver is required before booking',
          code: WAIVER_REQUIRED_CODE,
          waiver_version: waiverConfig.waiver_version,
        });
      }
      // The client must echo the version it rendered: if the admin
      // edited the waiver text after the form loaded, the signature
      // would cover text the signer never saw. 409 → re-render.
      if (waiver.waiver_version !== waiverConfig.waiver_version) {
        return res.status(409).json({
          error:
            'the waiver was updated after it was displayed; reload it and sign again',
          code: WAIVER_VERSION_MISMATCH_CODE,
          waiver_version: waiverConfig.waiver_version,
        });
      }
    }
    // Insert-dedupe check (NOT observable in any response): only
    // record a signature when this email has none at the current
    // version.
    const missingWaiver = await findMissingWaiverSignature(db, tenant.id, {
      customerEmail: customer.email,
    });

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
      return res
        .status(409)
        .json({ error: 'this session type is no longer offered' });
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
        error: "this session type can't be booked online — please book at the front desk",
      });
    }

    // 2. Compute window + gates shared with reschedule: link active,
    //    advance window, past-time, resource lock, operating hours,
    //    blackouts, overlapping bookings, class instances.
    const start = new Date(start_time);
    const end = new Date(start.getTime() + offering.duration_minutes * 60 * 1000);
    const slotError = await validateCustomerSlot(db, tenant, {
      offering_id,
      resource_id,
      start,
      end,
    });
    if (slotError) {
      return res.status(slotError.status).json(slotError.body);
    }

    // 6. Stripe connection must be charges-enabled.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0 || !connRes.rows[0].charges_enabled) {
      return res.status(409).json({
        error:
          'this facility cannot accept card payments online yet — please book at the front desk',
      });
    }
    const conn = connRes.rows[0];

    // 7. Compute hold_expires_at: min(now+30min, start_time). Schema
    //    CHECK enforces hold_expires_at <= start_time as the upper
    //    bound; we tighten with the app-level 30min cap.
    const hold = new Date(
      Math.min(Date.now() + HOLD_DURATION_MS, start.getTime()),
    );

    // 8. INSERT the pending booking. We commit it BEFORE talking to
    //    Stripe so the slot is locked under our exclusion constraint.
    //    If the Stripe call fails afterwards the booking row stays
    //    in pending_payment until the hold expires (at which point
    //    the janitor cancels it). Worst case: a 30-minute slot
    //    hold for a customer who walked away. Acceptable.
    let booking;
    try {
      const r = await db.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id,
           customer_first_name, customer_last_name,
           customer_email, customer_phone, customer_note,
           start_time, end_time, status, hold_expires_at,
           amount_due_cents, credit_cost_charged, payment_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'pending_payment', $11, $12, 0, 'pending'
         )
         RETURNING id, offering_id, resource_id, start_time, end_time,
                   status, amount_due_cents, payment_status,
                   hold_expires_at, created_at`,
        [
          tenant.id,
          offering_id,
          resource_id,
          customerName.first_name,
          customerName.last_name,
          customer.email,
          customer.phone,
          note ?? null,
          start,
          end,
          hold,
          offering.dollar_price,
        ],
      );
      booking = r.rows[0];
    } catch (err) {
      if (err.code === '23P01') {
        return res.status(409).json({
          error: 'slot already booked (concurrent)',
          code: 'slot_conflict',
        });
      }
      throw err;
    }

    // 8b. Record the inline waiver signature — same transaction as
    //     the booking INSERT above, before the Stripe call. If the
    //     Stripe call fails the response is >= 400 and
    //     withTenantContext rolls the whole transaction back, so a
    //     signature never lands without its booking. Skipped when
    //     this email already holds a current-version signature
    //     (repeat walk-in) — enforcement only needs one.
    if (missingWaiver && waiver) {
      await db.query(
        `INSERT INTO waiver_signatures
           (tenant_id, customer_email, signer_name, guardian_name,
            is_minor, waiver_version)
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

    // 9. Create Checkout Session in mode='payment' on the connected
    //    account. price_data is inline so we don't have to mint a
    //    Stripe Product per offering.
    //
    //    The booking id is appended to the success_url so the success
    //    page can show a reference code + slot details (via the
    //    email-gated POST /api/customers/bookings/lookup). A booking
    //    UUID is unguessable and not personal data, so it's safe in a
    //    URL; the email needed to read details never rides in the URL.
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
                unit_amount: offering.dollar_price,
                product_data: {
                  name: offering.name,
                },
              },
              quantity: 1,
            },
          ],
          success_url: successUrl.toString(),
          cancel_url,
          // Critical: the webhook reads these to find which booking
          // to flip. courtside_tenant_id is duplicated for the
          // tenant cross-check; courtside_booking_id is the routing
          // key.
          metadata: {
            courtside_tenant_id: tenant.id,
            courtside_booking_id: booking.id,
          },
          // Expire the Stripe session in step with our DB hold so
          // the janitor can't cancel a booking whose payment page is
          // still live. Stripe's floor is 30min ahead — for slots
          // starting sooner, the hold clamps to start_time while the
          // session keeps the 30min minimum; that residual window is
          // covered by the webhook's auto-refund of payments landing
          // on a non-pending booking. The +31min floor (not exactly
          // 30) keeps clock skew / request latency from tripping
          // Stripe's ">= 30 minutes in the future" validation.
          expires_at: Math.max(
            Math.floor(hold.getTime() / 1000),
            Math.floor(Date.now() / 1000) + 31 * 60,
          ),
        },
        { stripeAccount: conn.stripe_account_id },
      );
    } catch (err) {
      // Best effort: cancel the booking we just inserted so the slot
      // isn't held for the full hold window by a Stripe error.
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
      // Copy source of truth for "we hold your time for N minutes" —
      // never hardcode the number client-side.
      hold_minutes: HOLD_DURATION_MINUTES,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- GET /api/customers/offerings ----------
//
// Public counterpart of listBookableOfferings (bookings.js): the
// offerings a walk-in can see and book, with the resources each runs
// on. Filters mirror the createCustomerBooking gates so nothing shown
// here fails at booking time: active, public, rental, priced.
// Credit cost is intentionally not exposed — walk-ins see dollars.
//
// Also carries everything the checkout UI needs BEFORE it can submit:
//   * categories — the tenant's section labels + ordering
//     (category_display overlay; keys with no row fall back to a
//     client-derived label)
//   * policy — hold minutes, reschedule cutoff, advance window. All
//     checkout trust copy ("we hold your time for 30 minutes",
//     "reschedule free up to 24h before") derives from this block so
//     copy can never drift from enforcement.
export async function listPublicOfferings(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT o.id, o.name, o.category, o.description, o.duration_minutes,
              o.dollar_price, o.display_order,
              COALESCE(
                (
                  SELECT json_agg(json_build_object(
                    'id', r.id, 'name', r.name, 'display_order', r.display_order
                  ) ORDER BY r.display_order, r.name)
                    FROM offering_resources orx
                    JOIN resources r
                      ON r.tenant_id = orx.tenant_id AND r.id = orx.resource_id
                   WHERE orx.tenant_id = o.tenant_id
                     AND orx.offering_id = o.id
                     AND orx.active
                     AND r.active
                ),
                '[]'::json
              ) AS resources
         FROM offerings o
        WHERE o.tenant_id = $1
          AND o.active
          AND o.allow_public_booking
          AND o.capacity = 1
          AND o.dollar_price > 0
        ORDER BY o.display_order ASC, o.name ASC`,
      [req.tenant.id],
    );

    const categoriesRes = await req.db.query(
      `SELECT category, label, display_order
         FROM category_display
        WHERE tenant_id = $1
        ORDER BY display_order ASC, category ASC`,
      [req.tenant.id],
    );

    const policyRes = await req.db.query(
      `SELECT customer_reschedule_hours_before,
              min_advance_booking_minutes, max_advance_booking_days
         FROM booking_policies WHERE tenant_id = $1`,
      [req.tenant.id],
    );
    const policy = policyRes.rows[0] ?? {
      customer_reschedule_hours_before: 24,
      min_advance_booking_minutes: 0,
      max_advance_booking_days: 30,
    };

    res.json({
      offerings: result.rows,
      categories: categoriesRes.rows,
      policy: {
        hold_minutes: HOLD_DURATION_MINUTES,
        customer_reschedule_hours_before:
          policy.customer_reschedule_hours_before,
        min_advance_booking_minutes: policy.min_advance_booking_minutes,
        max_advance_booking_days: policy.max_advance_booking_days,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- POST /api/customers/bookings/lookup ----------
//
// Public, unauthenticated booking lookup for the walk-in success
// page. A walk-in has no credential, so the gate is knowledge of BOTH
// the booking id (an unguessable UUID, carried on the Checkout
// success_url) AND the email the booking was made with. A wrong email
// returns the same 404 as an unknown id, so the endpoint can't be
// used to enumerate bookings or confirm emails. POST (not GET) keeps
// the email out of URLs and access logs.

const lookupSchema = z.object({
  booking_id: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((s) => s.toLowerCase().trim()),
});

// Human-friendly short reference derived from the booking UUID. Shown
// on the success page + read out at the front desk. First 8 hex chars
// uppercased — collision odds within one facility's active bookings
// are negligible, and the full UUID remains the real key.
export function bookingReference(bookingId) {
  return bookingId.slice(0, 8).toUpperCase();
}

export async function lookupCustomerBooking(req, res, next) {
  try {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      // Malformed UUIDs get the same 404 as unknown ones (no
      // enumeration hints); genuinely malformed bodies get a 400.
      const bookingIdIssue = parsed.error.issues.some(
        (i) => i.path[0] === 'booking_id',
      );
      if (bookingIdIssue && typeof req.body?.booking_id === 'string') {
        return res.status(404).json({ error: 'booking not found' });
      }
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { booking_id, email } = parsed.data;
    const { tenant, db } = req;

    const result = await db.query(
      `SELECT b.id, b.status, b.start_time, b.end_time,
              b.amount_due_cents, b.amount_paid_cents, b.payment_status,
              o.name AS offering_name,
              r.name AS resource_name
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.id = $2 AND b.customer_email = $3`,
      [tenant.id, booking_id, email],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'booking not found' });
    }
    const b = result.rows[0];

    res.json({
      booking: {
        id: b.id,
        reference: bookingReference(b.id),
        status: b.status,
        start_time: b.start_time,
        end_time: b.end_time,
        offering_name: b.offering_name,
        resource_name: b.resource_name,
        amount_due_cents: b.amount_due_cents,
        amount_paid_cents: b.amount_paid_cents,
        payment_status: b.payment_status,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- no-login manage / reschedule ----------
//
// The confirmation email carries a capability URL
// (/walk-in/manage?token=...) whose token was minted by the Stripe
// webhook when payment confirmed. Possession of the link IS the auth:
// same trust anchor as the email-gated lookup above, but one tap.
// Only the sha256 of the token is stored (bookings.manage_token_hash)
// — a DB read yields nothing usable, and there's no expiry column
// because validity is bounded by booking state + the policy cutoff.
//
// Accepted tradeoff (standard for capability URLs): the token rides
// in a GET URL, so it can land in proxy logs / browser history. Scope
// is a single booking's reschedule; the mutation is a POST.
//
// Unknown/garbage tokens return the same 404 body as the lookup
// endpoint — no enumeration signal. The 20..200 length guard just
// rejects pathological input before hashing.

const manageTokenSchema = z.string().min(20).max(200);

const rescheduleSchema = z.object({
  // Same offering only — structurally no price change. The new slot
  // may land on any resource the offering runs on.
  start_time: z.string().datetime({
    message: 'start_time must be ISO 8601 (e.g. 2027-01-04T14:00:00.000Z)',
  }),
  resource_id: z.string().uuid(),
});

const RESCHEDULE_NOT_FOUND = { error: 'booking not found' };

async function getReschedulePolicy(db, tenantId) {
  const r = await db.query(
    `SELECT customer_reschedule_hours_before
       FROM booking_policies WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.customer_reschedule_hours_before ?? 24;
}

// Shared shape for both manage endpoints' responses.
function rescheduleInfo(booking, hoursBefore, advancePolicy) {
  const cutoffAt = new Date(
    new Date(booking.start_time).getTime() - hoursBefore * 60 * 60 * 1000,
  );
  let reason = null;
  if (booking.status !== 'confirmed' || booking.payment_status !== 'paid') {
    reason = 'not_confirmed';
  } else if (Date.now() >= cutoffAt.getTime()) {
    reason = 'cutoff_passed';
  }
  return {
    allowed: reason === null,
    reason,
    cutoff_at: cutoffAt.toISOString(),
    hours_before: hoursBefore,
    min_advance_booking_minutes: advancePolicy.min_advance_booking_minutes,
    max_advance_booking_days: advancePolicy.max_advance_booking_days,
  };
}

function manageBookingJson(b) {
  return {
    id: b.id,
    reference: bookingReference(b.id),
    status: b.status,
    start_time: b.start_time,
    end_time: b.end_time,
    offering_id: b.offering_id,
    offering_name: b.offering_name,
    resource_id: b.resource_id,
    resource_name: b.resource_name,
    customer_note: b.customer_note,
    amount_paid_cents: b.amount_paid_cents,
    payment_status: b.payment_status,
    reschedule_count: b.reschedule_count,
  };
}

// GET /api/customers/bookings/manage/:token
export async function getManageBooking(req, res, next) {
  try {
    const parsedToken = manageTokenSchema.safeParse(req.params.token);
    if (!parsedToken.success) {
      return res.status(404).json(RESCHEDULE_NOT_FOUND);
    }
    const { tenant, db } = req;
    const tokenHash = hashManageToken(parsedToken.data);

    const result = await db.query(
      `SELECT b.id, b.status, b.start_time, b.end_time,
              b.offering_id, b.resource_id, b.customer_note,
              b.amount_paid_cents, b.payment_status, b.reschedule_count,
              o.name AS offering_name, o.duration_minutes,
              r.name AS resource_name
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.manage_token_hash = $2`,
      [tenant.id, tokenHash],
    );
    if (result.rows.length === 0) {
      return res.status(404).json(RESCHEDULE_NOT_FOUND);
    }
    const b = result.rows[0];

    // The offering's currently-bookable resources, so the manage page
    // can run the same "No preference" availability merge as checkout
    // without depending on the public offerings list (the offering
    // may have gone non-public since booking; reschedule still works).
    const resourcesRes = await db.query(
      `SELECT r.id, r.name, r.display_order
         FROM offering_resources orx
         JOIN resources r
           ON r.tenant_id = orx.tenant_id AND r.id = orx.resource_id
        WHERE orx.tenant_id = $1 AND orx.offering_id = $2
          AND orx.active AND r.active
        ORDER BY r.display_order, r.name`,
      [tenant.id, b.offering_id],
    );

    const hoursBefore = await getReschedulePolicy(db, tenant.id);
    const advancePolicy = await getAdvancePolicy(db, tenant.id);

    res.json({
      booking: manageBookingJson(b),
      offering: {
        id: b.offering_id,
        name: b.offering_name,
        duration_minutes: b.duration_minutes,
        resources: resourcesRes.rows,
      },
      reschedule: rescheduleInfo(b, hoursBefore, advancePolicy),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/customers/bookings/manage/:token/reschedule
export async function rescheduleManagedBooking(req, res, next) {
  try {
    const parsedToken = manageTokenSchema.safeParse(req.params.token);
    if (!parsedToken.success) {
      return res.status(404).json(RESCHEDULE_NOT_FOUND);
    }
    const parsed = rescheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { start_time, resource_id } = parsed.data;
    const { tenant, db } = req;
    const tokenHash = hashManageToken(parsedToken.data);

    // Lock the booking row — serializes concurrent reschedules of the
    // same booking (double-tap, two open tabs).
    const bookingRes = await db.query(
      `SELECT id, status, payment_status, member_id, offering_id,
              resource_id, start_time, end_time, customer_note,
              customer_first_name, customer_email,
              amount_paid_cents, reschedule_count
         FROM bookings
        WHERE tenant_id = $1 AND manage_token_hash = $2
        FOR UPDATE`,
      [tenant.id, tokenHash],
    );
    if (bookingRes.rows.length === 0) {
      return res.status(404).json(RESCHEDULE_NOT_FOUND);
    }
    const booking = bookingRes.rows[0];

    // Only confirmed + paid customer bookings are reschedulable.
    // (member_id is always NULL when a token exists — the webhook only
    // mints them for walk-ins — but check anyway.)
    if (
      booking.status !== 'confirmed' ||
      booking.payment_status !== 'paid' ||
      booking.member_id !== null
    ) {
      return res.status(409).json({
        error: 'this booking can no longer be rescheduled',
        code: 'not_reschedulable',
      });
    }

    // Cutoff: reschedules close N hours before the CURRENT slot.
    const hoursBefore = await getReschedulePolicy(db, tenant.id);
    const cutoffMs =
      new Date(booking.start_time).getTime() - hoursBefore * 60 * 60 * 1000;
    if (Date.now() >= cutoffMs) {
      return res.status(409).json({
        error: `reschedules close ${hoursBefore} hours before your session`,
        code: 'reschedule_cutoff_passed',
      });
    }

    // Offering must still be bookable — the validity trigger does NOT
    // re-fire on a time-only UPDATE (it watches offering/resource/
    // member/status columns), so this controller re-check is
    // load-bearing, not defense in depth.
    const offerRes = await db.query(
      `SELECT id, name, duration_minutes, capacity, dollar_price, active
         FROM offerings
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, booking.offering_id],
    );
    const offering = offerRes.rows[0];
    if (!offering || !offering.active || offering.capacity !== 1) {
      return res.status(409).json({
        error: 'this session type is no longer offered — contact the facility',
      });
    }

    // New slot must pass the exact create-time gates, excluding the
    // booking's own current slot from the overlap check so small
    // shifts on the same resource work.
    const start = new Date(start_time);
    const end = new Date(
      start.getTime() + offering.duration_minutes * 60 * 1000,
    );
    const slotError = await validateCustomerSlot(db, tenant, {
      offering_id: booking.offering_id,
      resource_id,
      start,
      end,
      excludeBookingId: booking.id,
    });
    if (slotError) {
      return res.status(slotError.status).json(slotError.body);
    }

    // Move it. time_range is GENERATED, so the GiST exclusion
    // re-checks overlap against every other non-cancelled row — the
    // concurrency backstop behind the app-level checks above. Payment
    // fields are untouched: same offering, same price, no money moves.
    let updated;
    try {
      const r = await db.query(
        `UPDATE bookings
            SET start_time = $1,
                end_time = $2,
                resource_id = $3,
                previous_start_time = start_time,
                rescheduled_at = now(),
                reschedule_count = reschedule_count + 1
          WHERE tenant_id = $4 AND id = $5
          RETURNING id, status, start_time, end_time, offering_id,
                    resource_id, customer_note, amount_paid_cents,
                    payment_status, reschedule_count, previous_start_time`,
        [start, end, resource_id, tenant.id, booking.id],
      );
      updated = r.rows[0];
    } catch (err) {
      if (err.code === '23P01') {
        return res.status(409).json({
          error: 'slot already booked (concurrent)',
          code: 'slot_conflict',
        });
      }
      throw err;
    }

    const resourceNameRes = await db.query(
      `SELECT name FROM resources WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, resource_id],
    );
    const resourceName = resourceNameRes.rows[0]?.name ?? null;

    const advancePolicy = await getAdvancePolicy(db, tenant.id);

    // Post-commit (withTenantContext commits before 'finish' fires):
    // tell the customer, with the same manage link re-embedded — the
    // stored hash is untouched, so the raw token the client just
    // presented keeps working. Fire-and-forget; failure must never
    // fail the reschedule. TODO: outbox for reliability-critical
    // delivery.
    const rawToken = parsedToken.data;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      sendBookingReschedule({
        tenant,
        to: booking.customer_email,
        recipientName: booking.customer_first_name,
        offeringName: offering.name,
        resourceName,
        previousStartTime: booking.start_time,
        startTime: updated.start_time,
        manageUrl: buildManageUrl(tenant.subdomain, rawToken),
      }).catch((err) =>
        console.error('[email] reschedule confirmation send failed:', err),
      );
    });

    res.json({
      booking: manageBookingJson({
        ...updated,
        offering_name: offering.name,
        resource_name: resourceName,
      }),
      reschedule: rescheduleInfo(updated, hoursBefore, advancePolicy),
    });
  } catch (err) {
    next(err);
  }
}
