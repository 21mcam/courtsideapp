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
