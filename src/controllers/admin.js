// Admin-only views + light writes for member management.
//
// Phase 1 slice 4 had read-only lists. Phase 2 slice 4 adds:
//   - manual member create (user_id = NULL — invite flow / data
//     import; the member can later set up a login and link)
//   - credit adjustments via apply_credit_change()
//   - members list now includes current_credits via LEFT JOIN

import { z } from 'zod';

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
              b.customer_first_name, b.customer_last_name, b.customer_email
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
