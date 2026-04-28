// Password reset controllers — Phase 1, slice 5.
//
// Plumbing-only: tokens stored, hashed, single-use, rate-limited via
// the partial-unique-index in migration 013. Email delivery via
// Resend lands in Phase 3 — for now the reset URL is logged to the
// server console as a dev affordance.
//
// Anti-enumeration: forgotPassword always returns 200. The response
// shape doesn't differentiate "email exists" from "email doesn't
// exist," so an attacker can't probe the user table by trying
// addresses.
//
// Existing JWTs stay valid until natural expiry. Phase 5 hardening
// can add a `password_changed_at` column on users + cross-check in
// requireAuth to invalidate-on-reset; not in scope here.

import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const BCRYPT_ROUNDS = 10;

const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1).max(256),
  new_password: z.string().min(8, 'password must be at least 8 characters'),
});

function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function buildResetUrl(req, rawToken) {
  // Best-effort URL for the dev log. In prod (Phase 3+) Resend's
  // template owns the URL; this is just the convenience handoff for
  // local testing.
  const apex = process.env.APP_HOSTNAME || 'localhost';
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const port = apex === 'localhost' ? ':5173' : '';
  return `${protocol}://${req.tenant.subdomain}.${apex}${port}/reset?token=${rawToken}`;
}

export async function forgotPassword(req, res, next) {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input' });
    }
    const { email } = parsed.data;

    const userResult = await req.db.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
      [req.tenant.id, email],
    );

    // Anti-enumeration: same response whether or not the email exists.
    // We do skip the token write entirely if the user isn't found —
    // the timing difference is measurable but small, and writing a
    // token nobody can ever use is wasteful. The forgot-password
    // form is rate-limited at the network/UI layer (Phase 3 concern).
    if (userResult.rows.length === 0) {
      return res.json({ ok: true });
    }

    const user_id = userResult.rows[0].id;

    // Invalidate any prior unused tokens for this user. The partial
    // unique index requires this — without it, the INSERT below
    // collides with the existing active row.
    await req.db.query(
      `UPDATE password_reset_tokens
          SET used_at = now()
        WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
      [req.tenant.id, user_id],
    );

    const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
    );

    await req.db.query(
      `INSERT INTO password_reset_tokens
         (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [req.tenant.id, user_id, tokenHash, expiresAt],
    );

    // TODO (Phase 3): swap this for a Resend send + per-tenant
    // reply-to address. Until then, console.log is the dev hand-off.
    console.log(`[password-reset] ${buildResetUrl(req, rawToken)}`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input' });
    }
    const { token, new_password } = parsed.data;

    const tokenHash = hashToken(token);

    const tokenResult = await req.db.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE tenant_id = $1
          AND token_hash = $2
          AND used_at IS NULL
          AND expires_at > now()`,
      [req.tenant.id, tokenHash],
    );

    if (tokenResult.rows.length === 0) {
      // Don't differentiate "invalid", "expired", "used" — same
      // response. Caller just sees "your link no longer works."
      return res.status(400).json({ error: 'invalid or expired token' });
    }

    const { id: token_id, user_id } = tokenResult.rows[0];
    const password_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    // Both updates are in the withTenantContext transaction — atomic.
    await req.db.query(
      `UPDATE users SET password_hash = $1
        WHERE tenant_id = $2 AND id = $3`,
      [password_hash, req.tenant.id, user_id],
    );
    await req.db.query(
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [req.tenant.id, token_id],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
