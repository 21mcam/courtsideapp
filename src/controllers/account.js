// /api/me account self-service — the signed-in person managing their
// own login (members AND staff; staff have no member row).
//
//   PATCH /api/me/profile   first/last name (+ phone for members)
//   POST  /api/me/password  change password (requires the current one)
//   GET   /api/me/credits   the member's own credit history
//
// Email change is deliberately NOT here: users.email and members.email
// are tied by a composite FK and the address is also the login, so it
// needs its own verify-the-new-address flow (later slice).
//
// All writes run on req.db (tenant transaction, RLS) and are refused
// for read-only support sessions by requireAuth before reaching here.

import bcrypt from 'bcryptjs';
import { z } from 'zod';

const BCRYPT_ROUNDS = 10;
const CREDITS_PAGE_SIZE = 25;

const profileSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  // Members only; '' clears it. Ignored for staff-only users.
  phone: z.string().trim().max(50).optional(),
});

export async function updateProfile(req, res, next) {
  try {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { first_name, last_name, phone } = parsed.data;
    const { db, tenant, user } = req;

    const u = await db.query(
      `UPDATE users SET first_name = $1, last_name = $2
        WHERE tenant_id = $3 AND id = $4
        RETURNING id, email, first_name, last_name`,
      [first_name, last_name, tenant.id, user.user_id],
    );
    if (u.rows.length === 0) return res.status(401).json({ error: 'user not found' });

    // Keep the member record's name in step with the login (admin
    // screens and emails read members.first_name).
    let member = null;
    const m = await db.query(
      `UPDATE members
          SET first_name = $1,
              last_name  = $2,
              phone      = CASE WHEN $3::boolean THEN NULLIF($4, '') ELSE phone END
        WHERE tenant_id = $5 AND user_id = $6
        RETURNING id, phone`,
      [first_name, last_name, phone !== undefined, phone ?? '', tenant.id, user.user_id],
    );
    if (m.rows[0]) member = m.rows[0];

    res.json({ user: u.rows[0], member });
  } catch (err) {
    next(err);
  }
}

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'password must be at least 8 characters').max(200),
});

export async function changePassword(req, res, next) {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { current_password, new_password } = parsed.data;
    const { db, tenant, user } = req;

    const r = await db.query(
      `SELECT password_hash FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, user.user_id],
    );
    const hash = r.rows[0]?.password_hash;
    // NULL hash = invited user who never set one; they use the
    // emailed link / forgot-password, not this form.
    if (!hash || !(await bcrypt.compare(current_password, hash))) {
      return res.status(400).json({ error: 'current password is incorrect' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'new password must be different' });
    }

    await db.query(
      `UPDATE users SET password_hash = $1 WHERE tenant_id = $2 AND id = $3`,
      [await bcrypt.hash(new_password, BCRYPT_ROUNDS), tenant.id, user.user_id],
    );
    // Any outstanding reset/invite link would otherwise still let
    // someone set a different password after this change.
    await db.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
      [tenant.id, user.user_id],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Member-facing credit history. Admin notes are NOT returned — they're
// staff-internal ("comped after complaint"). Booking-linked entries
// carry what was booked so "−5 credits" means something.
export async function listMyCredits(req, res, next) {
  try {
    const { db, tenant, user } = req;
    if (!user.member_id) {
      return res.json({ entries: [], total: 0, limit: CREDITS_PAGE_SIZE, offset: 0 });
    }
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

    const r = await db.query(
      `SELECT l.id, l.amount, l.balance_after, l.reason, l.created_at,
              COALESCE(bo.name, co.name) AS offering_name,
              COALESCE(b.start_time, ci.start_time) AS booking_start
         FROM credit_ledger_entries l
         LEFT JOIN bookings b
           ON b.tenant_id = l.tenant_id AND b.id = l.booking_id
         LEFT JOIN offerings bo
           ON bo.tenant_id = b.tenant_id AND bo.id = b.offering_id
         LEFT JOIN class_bookings cb
           ON cb.tenant_id = l.tenant_id AND cb.id = l.class_booking_id
         LEFT JOIN class_instances ci
           ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
         LEFT JOIN offerings co
           ON co.tenant_id = ci.tenant_id AND co.id = ci.offering_id
        WHERE l.tenant_id = $1 AND l.member_id = $2
        ORDER BY l.entry_number DESC
        LIMIT $3 OFFSET $4`,
      [tenant.id, user.member_id, CREDITS_PAGE_SIZE, offset],
    );
    const count = await db.query(
      `SELECT count(*)::int AS total FROM credit_ledger_entries
        WHERE tenant_id = $1 AND member_id = $2`,
      [tenant.id, user.member_id],
    );

    res.json({
      entries: r.rows,
      total: count.rows[0].total,
      limit: CREDITS_PAGE_SIZE,
      offset,
    });
  } catch (err) {
    next(err);
  }
}
