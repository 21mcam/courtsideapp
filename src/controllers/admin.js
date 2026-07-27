// Admin-only views + light writes for member management.
//
// Phase 1 slice 4 had read-only lists. Phase 2 slice 4 adds:
//   - manual member create (user_id = NULL — invite flow / data
//     import; the member can later set up a login and link)
//   - credit adjustments via apply_credit_change()
//   - members list now includes current_credits via LEFT JOIN

import { z } from 'zod';

import {
  sendAdminInvite,
  sendBookingConfirmation,
  sendMemberWelcome,
  tenantUrl,
} from '../services/email.js';
import {
  INVITE_TOKEN_EXPIRY_HOURS,
  issuePasswordSetupToken,
} from './passwordReset.js';
import { isUuid } from './catalog.js';

const createMemberSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(50).optional(),
});

const creditAdjustmentSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, 'amount must be non-zero'),
  note: z.string().max(2000).optional(),
});

export async function listMembers(req, res, next) {
  try {
    // LEFT JOIN with credit_balances so the list always returns one
    // row per member, with balance defaulting to 0 if no balance row
    // exists yet (first credit change auto-creates it).
    const result = await req.db.query(
      `SELECT m.id, m.email, m.first_name, m.last_name, m.phone,
              m.user_id, m.created_at,
              COALESCE(cb.current_credits, 0) AS current_credits
         FROM members m
    LEFT JOIN credit_balances cb
           ON cb.tenant_id = m.tenant_id
          AND cb.member_id = m.id
        WHERE m.tenant_id = $1
        ORDER BY m.created_at DESC`,
      [req.tenant.id],
    );
    res.json({ members: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createManualMember(req, res, next) {
  try {
    const parsed = createMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { email, first_name, last_name, phone } = parsed.data;

    try {
      // user_id stays NULL — this is a manual member without a login.
      // The composite FK (tenant_id, user_id, email) is inactive when
      // user_id is null; no FK enforcement.
      const result = await req.db.query(
        `INSERT INTO members
           (tenant_id, email, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, first_name, last_name, phone, user_id, created_at`,
        [req.tenant.id, email, first_name, last_name, phone ?? null],
      );
      const member = { ...result.rows[0], current_credits: 0 };

      // Welcome email — sent AFTER the transaction commits (res
      // 'finish' fires after withTenantContext's COMMIT flushes),
      // fire-and-forget. TODO: outbox for reliability-critical
      // delivery.
      const tenant = req.tenant;
      res.on('finish', () => {
        sendMemberWelcome({
          tenant,
          to: member.email,
          firstName: member.first_name,
        }).catch((err) =>
          console.error('[email] member welcome send failed:', err),
        );
      });

      res.status(201).json({ member });
    } catch (err) {
      if (err.code === '23505') {
        // UNIQUE (tenant_id, email) — email already in use by another
        // member in this tenant. (May or may not have a linked user.)
        return res
          .status(409)
          .json({ error: 'email already in use by another member in this tenant' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

export async function adjustMemberCredits(req, res, next) {
  try {
    const member_id = req.params.id;
    const parsed = creditAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { amount, note } = parsed.data;

    // granted_by is the admin user from the JWT. The schema column
    // has no FK so historical entries survive admin user deletion.
    const granted_by = req.user.user_id;

    try {
      const result = await req.db.query(
        `SELECT entry_id, balance_after FROM apply_credit_change(
           $1, $2, $3, 'admin_adjustment', $4, $5, NULL, NULL
         )`,
        [req.tenant.id, member_id, amount, note ?? null, granted_by],
      );
      const { entry_id, balance_after } = result.rows[0];
      res.status(201).json({ entry_id, balance_after });
    } catch (err) {
      if (err.code === '23514') {
        // Could be insufficient-credits, tenant-mismatch (shouldn't
        // happen — withTenantContext sets the GUC to req.tenant.id),
        // or amount=0. Map to 400.
        return res
          .status(400)
          .json({ error: err.message || 'invalid credit adjustment' });
      }
      if (err.code === '23503') {
        // FK violation — likely member_id doesn't exist in this tenant.
        return res
          .status(404)
          .json({ error: 'member not found in this tenant' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/members/:id — member detail for the admin UI.
//
// One roundtrip for the whole detail view: profile + credit balance,
// current subscription (joined with its active plan period, same
// shape as GET /api/me/subscriptions), recent bookings (newest 20),
// and the credit ledger paginated via ?ledger_limit & ?ledger_offset
// (default 20, max 100). Ledger is newest-first by entry_number —
// the append-only ordering column, immune to created_at ties.
//
// The runtime role has SELECT on credit_ledger_entries (writes are
// revoked — apply_credit_change() is the only write path).
const memberDetailQuerySchema = z.object({
  ledger_limit: z.coerce.number().int().min(1).max(100).default(20),
  ledger_offset: z.coerce.number().int().min(0).default(0),
});

const RECENT_BOOKINGS_LIMIT = 20;

export async function getMemberDetail(req, res, next) {
  try {
    const member_id = req.params.id;
    if (!isUuid(member_id)) {
      return res.status(404).json({ error: 'member not found' });
    }
    const parsed = memberDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { ledger_limit, ledger_offset } = parsed.data;
    const { tenant, db } = req;

    const memberRes = await db.query(
      `SELECT m.id, m.email, m.first_name, m.last_name, m.phone,
              m.user_id, m.created_at, m.updated_at,
              COALESCE(cb.current_credits, 0) AS current_credits
         FROM members m
    LEFT JOIN credit_balances cb
           ON cb.tenant_id = m.tenant_id
          AND cb.member_id = m.id
        WHERE m.tenant_id = $1 AND m.id = $2`,
      [tenant.id, member_id],
    );
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'member not found' });
    }

    // At most one non-terminal subscription (partial unique index).
    const subRes = await db.query(
      `SELECT s.id, s.status, s.stripe_subscription_id,
              s.current_period_start, s.current_period_end,
              s.cancel_at_period_end, s.activated_at, s.created_at,
              p.id AS plan_id,
              p.name AS plan_name,
              p.monthly_price_cents,
              p.credits_per_week
         FROM subscriptions s
         LEFT JOIN subscription_plan_periods spp
           ON spp.tenant_id = s.tenant_id
          AND spp.subscription_id = s.id
          AND spp.ended_at IS NULL
         LEFT JOIN plans p
           ON p.tenant_id = spp.tenant_id
          AND p.id = spp.plan_id
        WHERE s.tenant_id = $1
          AND s.member_id = $2
          AND s.status IN ('pending', 'active', 'past_due', 'incomplete')
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [tenant.id, member_id],
    );

    const bookingsRes = await db.query(
      `SELECT b.id, b.status, b.start_time, b.end_time,
              b.credit_cost_charged, b.amount_due_cents,
              b.amount_paid_cents, b.payment_status, b.created_at,
              o.name AS offering_name,
              r.name AS resource_name
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
        WHERE b.tenant_id = $1 AND b.member_id = $2
        ORDER BY b.start_time DESC
        LIMIT ${RECENT_BOOKINGS_LIMIT}`,
      [tenant.id, member_id],
    );

    const ledgerRes = await db.query(
      `SELECT id, entry_number, amount, balance_after, reason, note,
              granted_by, booking_id, class_booking_id, created_at
         FROM credit_ledger_entries
        WHERE tenant_id = $1 AND member_id = $2
        ORDER BY entry_number DESC
        LIMIT $3 OFFSET $4`,
      [tenant.id, member_id, ledger_limit, ledger_offset],
    );
    const ledgerCountRes = await db.query(
      `SELECT count(*)::int AS total
         FROM credit_ledger_entries
        WHERE tenant_id = $1 AND member_id = $2`,
      [tenant.id, member_id],
    );

    res.json({
      member: memberRes.rows[0],
      subscription: subRes.rows[0] ?? null,
      bookings: bookingsRes.rows,
      ledger: {
        entries: ledgerRes.rows,
        total: ledgerCountRes.rows[0].total,
        limit: ledger_limit,
        offset: ledger_offset,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/bookings — admin booking calendar feed.
//
// Query filters:
//   from   ISO datetime (inclusive). Defaults to 30 days ago.
//   to     ISO datetime (exclusive). Defaults to 60 days from now.
//   status repeated query param (?status=confirmed&status=no_show).
//          Defaults to all statuses.
//
// Returns rows joined with offering name, resource name, and (when
// applicable) member name + email. Customer fields are returned as
// stored on the booking row — not yet populated since walk-in flow
// ships in phase 5.
//
// Capped at 500 rows. The admin UI defaults to a 7-day window so
// that's plenty; bigger ranges should paginate (deferred).
const listBookingsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v == null ? undefined : Array.isArray(v) ? v : [v])),
});

const VALID_STATUSES = new Set([
  'pending_payment',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
]);

export async function listAllBookings(req, res, next) {
  try {
    const parsed = listBookingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { from, to, status } = parsed.data;

    if (status && status.some((s) => !VALID_STATUSES.has(s))) {
      return res.status(400).json({ error: 'invalid status filter value' });
    }

    const fromTs = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toTs = to
      ? new Date(to)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    if (fromTs >= toTs) {
      return res.status(400).json({ error: 'from must be before to' });
    }

    // Filter by start_time falling in [from, to). Status filter is
    // optional. Status array empty (after parse) means "all".
    const params = [req.tenant.id, fromTs, toTs];
    let statusClause = '';
    if (status && status.length > 0) {
      params.push(status);
      statusClause = `AND b.status = ANY($${params.length}::text[])`;
    }

    const result = await req.db.query(
      `SELECT b.id, b.status, b.start_time, b.end_time,
              b.offering_id, b.resource_id, b.member_id,
              b.credit_cost_charged, b.payment_status,
              b.amount_due_cents, b.amount_paid_cents,
              b.cancelled_at, b.cancelled_by_type,
              b.no_show_marked_at, b.created_at,
              o.name AS offering_name,
              r.name AS resource_name,
              m.first_name AS member_first_name,
              m.last_name  AS member_last_name,
              m.email      AS member_email,
              b.customer_first_name, b.customer_last_name, b.customer_email,
              b.customer_phone, b.customer_note
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
    LEFT JOIN members   m ON m.tenant_id = b.tenant_id AND m.id = b.member_id
        WHERE b.tenant_id = $1
          AND b.start_time >= $2
          AND b.start_time <  $3
          ${statusClause}
        ORDER BY b.start_time ASC
        LIMIT 500`,
      params,
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function listAdmins(req, res, next) {
  try {
    // Join to users so we can show name/email on the admin roster.
    const result = await req.db.query(
      `SELECT ta.id, ta.role, ta.user_id, ta.created_at,
              u.email, u.first_name, u.last_name
         FROM tenant_admins ta
         JOIN users u
           ON u.tenant_id = ta.tenant_id
          AND u.id = ta.user_id
        WHERE ta.tenant_id = $1
        ORDER BY ta.created_at DESC`,
      [req.tenant.id],
    );
    res.json({ admins: result.rows });
  } catch (err) {
    next(err);
  }
}

// ---------- POST /api/admin/admins — staff invite ----------
//
// One user identity, many roles (CLAUDE.md): if a user row already
// exists for this email in this tenant (e.g. a member being promoted
// to staff), we attach a tenant_admin role to it. Otherwise we create
// the user with NO password (password_hash NULL, migration 021) —
// they can't log in until they consume the set-password link in the
// invite email, which reuses the password-reset-token infrastructure
// with a 7-day expiry.
//
// Existing users with a password get a plain sign-in link instead —
// minting a reset token for them would silently invalidate any reset
// token they requested themselves.
//
// Guard: an email that's already an admin in this tenant is a 409.

const inviteAdminSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
});

export async function inviteAdmin(req, res, next) {
  try {
    const parsed = inviteAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { email, first_name, last_name } = parsed.data;
    const { tenant, db } = req;

    const userRes = await db.query(
      `SELECT id, password_hash, first_name, last_name
         FROM users
        WHERE tenant_id = $1 AND email = $2`,
      [tenant.id, email],
    );

    let user_id;
    let userFirstName = first_name;
    let userLastName = last_name;
    // needsPassword drives which link the email carries.
    let needsPassword;
    const existing_user = userRes.rows.length > 0;

    if (existing_user) {
      const existing = userRes.rows[0];
      user_id = existing.id;
      userFirstName = existing.first_name;
      userLastName = existing.last_name;
      needsPassword = existing.password_hash == null;

      const adminRes = await db.query(
        `SELECT 1 FROM tenant_admins WHERE tenant_id = $1 AND user_id = $2`,
        [tenant.id, user_id],
      );
      if (adminRes.rows.length > 0) {
        return res
          .status(409)
          .json({ error: 'this email is already an admin in this tenant' });
      }
    } else {
      needsPassword = true;
      const ins = await db.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
         VALUES ($1, $2, NULL, $3, $4)
         RETURNING id`,
        [tenant.id, email, first_name, last_name],
      );
      user_id = ins.rows[0].id;
    }

    let admin;
    try {
      const adminIns = await db.query(
        `INSERT INTO tenant_admins (tenant_id, user_id, role)
         VALUES ($1, $2, 'admin')
         RETURNING id, role, user_id, created_at`,
        [tenant.id, user_id],
      );
      admin = adminIns.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // UNIQUE (tenant_id, user_id) — concurrent duplicate invite.
        return res
          .status(409)
          .json({ error: 'this email is already an admin in this tenant' });
      }
      throw err;
    }

    const actionUrl = needsPassword
      ? tenantUrl(
          tenant.subdomain,
          `/reset?token=${await issuePasswordSetupToken(
            db,
            tenant.id,
            user_id,
            INVITE_TOKEN_EXPIRY_HOURS,
          )}&invite=1`,
        )
      : tenantUrl(tenant.subdomain, '/login');

    // Invite email — sent AFTER the transaction commits (res 'finish'
    // fires after withTenantContext's COMMIT flushes), fire-and-
    // forget. TODO: outbox for reliability-critical delivery.
    res.on('finish', () => {
      sendAdminInvite({
        tenant,
        to: email,
        firstName: userFirstName,
        actionUrl,
        isNewUser: needsPassword,
      }).catch((err) =>
        console.error('[email] admin invite send failed:', err),
      );
    });

    res.status(201).json({
      admin: {
        ...admin,
        email,
        first_name: userFirstName,
        last_name: userLastName,
      },
      existing_user,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- POST /api/admin/bookings — front-desk booking creation ----------
//
// Calendar click/drag creation. Differences from the self-serve flows:
//   * The window is explicit (start_time AND end_time) — a dragged
//     custom length is kept as-is; the offering supplies the flat
//     price/credit cost regardless of length.
//   * Admins bypass allow_member_booking / allow_public_booking (those
//     gate the self-serve surfaces), the advance-booking window, and
//     operating hours (front desk books special sessions). Blackouts
//     still 409 — they're an explicit admin "don't book this" and
//     should be deleted, not silently overridden.
//   * member_id XOR customer{...}: members spend credits through the
//     ledger (rejected if insufficient — rollback undoes the INSERT);
//     walk-ins go straight to confirmed with the offering's dollar
//     price recorded as cash due on arrival (payment_status 'pending',
//     no Stripe involved).
//   * The liability-waiver gate is DELIBERATELY not enforced here
//     (unlike the member/class/walk-in self-serve flows): the person
//     is standing at the front desk, where staff hand over the paper
//     waiver as part of the same interaction. The AdminWaivers roster
//     therefore only covers digitally-captured signatures — desk-
//     booked customers may be covered on paper only. v1.1 candidate:
//     flag unsigned emails in the admin booking UI.

const MAX_ADMIN_BOOKING_MINUTES = 24 * 60;

const createAdminBookingSchema = z
  .object({
    offering_id: z.string().uuid(),
    resource_id: z.string().uuid(),
    start_time: z.string().datetime({
      message: 'start_time must be ISO 8601 (e.g. 2027-01-04T14:00:00.000Z)',
    }),
    end_time: z.string().datetime({
      message: 'end_time must be ISO 8601',
    }),
    member_id: z.string().uuid().optional(),
    customer: z
      .object({
        first_name: z.string().trim().min(1).max(200),
        last_name: z.string().trim().min(1).max(200),
        email: z.string().email().transform((s) => s.toLowerCase().trim()),
        phone: z.string().trim().max(50).optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.member_id) !== Boolean(v.customer), {
    message: 'provide exactly one of member_id or customer',
  });

export async function createAdminBooking(req, res, next) {
  try {
    const parsed = createAdminBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { offering_id, resource_id, member_id, customer } = parsed.data;
    const { tenant, db, user } = req;

    const start = new Date(parsed.data.start_time);
    const end = new Date(parsed.data.end_time);
    if (end <= start) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }
    if ((end - start) / 60000 > MAX_ADMIN_BOOKING_MINUTES) {
      return res
        .status(400)
        .json({ error: 'booking cannot be longer than 24 hours' });
    }

    // Offering: active rental. Self-serve visibility flags don't gate
    // the front desk.
    const offerRes = await db.query(
      `SELECT id, name, duration_minutes, credit_cost, dollar_price,
              capacity, active
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
        error: 'class offerings use the class flow — create a class instance instead',
      });
    }

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

    // Lock the resource row to serialize concurrent attempts on it
    // (same pattern as the member flow).
    const lockRes = await db.query(
      `SELECT active, name FROM resources
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenant.id, resource_id],
    );
    if (lockRes.rows.length === 0) {
      return res.status(404).json({ error: 'resource not found' });
    }
    if (!lockRes.rows[0].active) {
      return res.status(409).json({ error: 'resource is inactive' });
    }
    const resource_name = lockRes.rows[0].name;

    // Blackouts still apply (see header comment).
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

    if (member_id) {
      const memberRes = await db.query(
        `SELECT id FROM members WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, member_id],
      );
      if (memberRes.rows.length === 0) {
        return res.status(404).json({ error: 'member not found' });
      }
    }

    let booking;
    try {
      const bookRes = await db.query(
        member_id
          ? `INSERT INTO bookings (
               tenant_id, offering_id, resource_id, member_id,
               start_time, end_time, status,
               amount_due_cents, credit_cost_charged, payment_status
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 'confirmed', 0, $7, 'not_required'
             )
             RETURNING id, offering_id, resource_id, member_id,
                       start_time, end_time, status,
                       credit_cost_charged, amount_due_cents,
                       payment_status, created_at`
          : `INSERT INTO bookings (
               tenant_id, offering_id, resource_id,
               customer_first_name, customer_last_name,
               customer_email, customer_phone,
               start_time, end_time, status,
               amount_due_cents, credit_cost_charged, payment_status
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed',
               $10, 0, $11
             )
             RETURNING id, offering_id, resource_id, member_id,
                       customer_first_name, customer_last_name,
                       customer_email, customer_phone,
                       start_time, end_time, status,
                       credit_cost_charged, amount_due_cents,
                       payment_status, created_at`,
        member_id
          ? [
              tenant.id,
              offering_id,
              resource_id,
              member_id,
              start,
              end,
              offering.credit_cost,
            ]
          : [
              tenant.id,
              offering_id,
              resource_id,
              customer.first_name,
              customer.last_name,
              customer.email,
              customer.phone ?? null,
              start,
              end,
              offering.dollar_price,
              offering.dollar_price > 0 ? 'pending' : 'not_required',
            ],
      );
      booking = bookRes.rows[0];
    } catch (err) {
      if (err.code === '23P01') {
        return res.status(409).json({ error: 'slot already booked (concurrent)' });
      }
      throw err;
    }

    if (member_id && offering.credit_cost !== 0) {
      try {
        const creditRes = await db.query(
          `SELECT entry_id, balance_after FROM apply_credit_change(
             $1, $2, $3, 'booking_spend', NULL, $4, $5, NULL
           )`,
          [tenant.id, member_id, -offering.credit_cost, user.user_id, booking.id],
        );
        return res.status(201).json({
          booking,
          balance_after: creditRes.rows[0].balance_after,
        });
      } catch (err) {
        if (err.code === '23514') {
          // insufficient credits — transaction rollback undoes the INSERT
          return res
            .status(400)
            .json({ error: err.message || 'credit change rejected' });
        }
        throw err;
      }
    }

    // Walk-in confirmation email — front-desk bookings for a customer
    // captured an email at creation; confirm to it. Member bookings
    // created by the front desk skip email (the member was standing
    // there). Sent AFTER the transaction commits (res 'finish' fires
    // after withTenantContext's COMMIT flushes), fire-and-forget.
    // TODO: outbox for reliability-critical delivery.
    if (customer?.email) {
      res.on('finish', () => {
        sendBookingConfirmation({
          tenant,
          to: customer.email,
          recipientName: customer.first_name,
          offeringName: offering.name,
          resourceName: resource_name,
          startTime: booking.start_time,
          amountDueCents: booking.amount_due_cents,
        }).catch((err) =>
          console.error('[email] booking confirmation send failed:', err),
        );
      });
    }

    res.status(201).json({ booking });
  } catch (err) {
    next(err);
  }
}

// Accent keys mirror the CHECK constraint on tenants.theme_accent
// (migrations 019 + 030) and ACCENTS in client/src/theme.js.
const themeSchema = z.object({
  accent: z.enum(['indigo', 'sky', 'emerald', 'violet', 'rose', 'slate', 'court']),
});

export async function updateTenantTheme(req, res, next) {
  try {
    const parsed = themeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid accent' });
    }
    // SECURITY DEFINER function — app_runtime has no UPDATE on the
    // tenants root table. Guarded by the tenant GUC inside.
    await req.db.query('SELECT set_tenant_theme($1, $2)', [
      req.tenant.id,
      parsed.data.accent,
    ]);
    res.json({ theme_accent: parsed.data.accent });
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/reply-to-email — the tenant's reply-to address for
// transactional emails (migration 020). null (or '') clears it.
// Same SECURITY DEFINER write path as the theme: app_runtime has no
// UPDATE on tenants.
const replyToSchema = z.object({
  reply_to_email: z.preprocess(
    (v) => (v === '' ? null : v),
    z.string().email().toLowerCase().trim().nullable(),
  ),
});

export async function updateTenantReplyTo(req, res, next) {
  try {
    const parsed = replyToSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid reply-to email' });
    }
    await req.db.query('SELECT set_tenant_reply_to($1, $2)', [
      req.tenant.id,
      parsed.data.reply_to_email,
    ]);
    res.json({ reply_to_email: parsed.data.reply_to_email });
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/business-info — the tenant's public-page identity
// (migration 029): structured address (state is a validated 2-letter
// enum — never free text, that's how "new york,ny" happened on the
// system this replaces), phone, manually-entered Google rating /
// review count / reviews URL, optional GA4 measurement id. Full
// replace: every field is sent on every save; '' clears to NULL.
// Same SECURITY DEFINER write path as theme/reply-to.

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL',
  'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
  'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD',
  'TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const emptyToNull = (schema) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), schema);

const businessInfoSchema = z.object({
  address_street: emptyToNull(z.string().trim().min(1).max(200).nullable()),
  address_city: emptyToNull(z.string().trim().min(1).max(100).nullable()),
  address_state: emptyToNull(z.enum(US_STATES).nullable()),
  address_zip: emptyToNull(
    z.string().regex(/^\d{5}(-\d{4})?$/, 'zip must be 12345 or 12345-6789').nullable(),
  ),
  business_phone: emptyToNull(z.string().trim().min(7).max(30).nullable()),
  google_rating: emptyToNull(z.number().min(0).max(5).nullable()),
  google_review_count: emptyToNull(z.number().int().nonnegative().nullable()),
  google_reviews_url: emptyToNull(
    z.string().url().startsWith('https://').max(500).nullable(),
  ),
  ga4_measurement_id: emptyToNull(
    z
      .string()
      .regex(/^G-[A-Z0-9]{4,16}$/, 'GA4 measurement id looks like G-XXXXXXXXXX')
      .nullable(),
  ),
});

export async function updateTenantBusinessInfo(req, res, next) {
  try {
    const parsed = businessInfoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    try {
      await req.db.query(
        `SELECT set_tenant_business_info($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          req.tenant.id,
          d.address_street,
          d.address_city,
          d.address_state,
          d.address_zip,
          d.business_phone,
          d.google_rating,
          d.google_review_count,
          d.google_reviews_url,
          d.ga4_measurement_id,
        ],
      );
    } catch (err) {
      if (err.code === '23514') {
        return res
          .status(400)
          .json({ error: 'invalid business info: schema CHECK failed' });
      }
      throw err;
    }
    res.json({ business_info: d });
  } catch (err) {
    next(err);
  }
}
