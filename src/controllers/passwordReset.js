// Password reset controllers — Phase 1, slice 5.
//
// Tokens stored, hashed, single-use, rate-limited via the
// partial-unique-index in migration 013. The reset link goes out via
// the email service (Resend; keyless dev/test no-ops) AFTER the
// transaction commits; the console.log stays as the local-dev
// affordance since keyless environments never send.
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

import { sendPasswordReset, tenantUrl } from '../services/email.js';

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

// Staff invites reuse this token infrastructure as a set-password
// link; a week-long window suits "check your email when you get a
// minute" better than the 1-hour reset window.
export const INVITE_TOKEN_EXPIRY_HOURS = 24 * 7;

// Invalidate any prior unused tokens for this user and mint a fresh
// one. Returns the raw token (only its hash is stored). Must run
// inside the caller's withTenantContext transaction — the
// invalidate-then-insert sequence is what satisfies the partial
// unique index (one active token per user, migration 013).
export async function issuePasswordSetupToken(
  db,
  tenantId,
  userId,
  expiryHours = RESET_TOKEN_EXPIRY_HOURS,
) {
  await db.query(
    `UPDATE password_reset_tokens
        SET used_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
    [tenantId, userId],
  );

  const rawToken = randomBytes(RESET_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO password_reset_tokens
       (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, hashToken(rawToken), expiresAt],
  );

  return rawToken;
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

    const rawToken = await issuePasswordSetupToken(
      req.db,
      req.tenant.id,
      user_id,
    );

    const resetUrl = tenantUrl(req.tenant.subdomain, `/reset?token=${rawToken}`);

    // Dev affordance: keyless environments (local dev, tests) skip
    // the send, so the console line is the local hand-off — but ONLY
    // there. When RESEND_API_KEY is set (production), the raw token
    // must never hit the logs: the URL is account-takeover-capable
    // for anyone with log access (Railway dashboard, log drains).
    if (!process.env.RESEND_API_KEY) {
      console.log(`[password-reset] ${resetUrl}`);
    }

    // Send AFTER the transaction commits — res 'finish' fires after
    // withTenantContext's COMMIT flushes. Fire-and-forget.
    // TODO: outbox (CLAUDE.md) once reliability-critical email
    // delivery needs more than log-on-failure.
    const tenant = req.tenant;
    res.on('finish', () => {
      sendPasswordReset({ tenant, to: email, resetUrl }).catch((err) =>
        console.error('[email] password reset send failed:', err),
      );
    });

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
