// Super-admin / platform controllers. Live on /api/platform/* on the
// apex hostname (no tenant context — these are platform-level ops).
//
// Gated by requirePlatformAccess: a platform console session, or the
// legacy X-Super-Admin-Token header for curl/scripts. Both actions are
// written to platform_audit_log (admin NULL for token callers).
// All DB writes go through SECURITY DEFINER functions so the runtime
// pool itself never has direct access to privileged tables. The web
// process holds zero superuser DB credentials.

import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { tenantUrl } from '../lib/publicUrl.js';
import { platformAudit } from '../middleware/platformAuth.js';
import { sendAdminInvite } from '../services/email.js';
import { platformTrialEndsAt } from './platformBilling.js';
import {
  INVITE_TOKEN_EXPIRY_HOURS,
  issuePasswordSetupToken,
} from './passwordReset.js';

const BCRYPT_ROUNDS = 10;

const signupTenantSchema = z.object({
  // Subdomain shape mirrors the schema's CHECK regex. The reserved-
  // name list is only enforced at the DB layer (CHECK on tenants);
  // a 23514 from the function call below maps to 400.
  subdomain: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 'invalid subdomain'),
  name: z.string().trim().min(1).max(200),
  // IANA timezone name (e.g. America/New_York). The DB CHECK only
  // requires non-empty, so validate against the runtime's tz database
  // here — a typo'd zone would break every booking time the tenant
  // ever renders.
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(isValidTimeZone, 'unknown timezone'),
  owner_email: z.string().email().toLowerCase().trim(),
  // Optional: omit it and the owner is emailed a set-password link
  // instead (the console's default — the operator never handles the
  // tenant's password).
  owner_password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .optional(),
  owner_first_name: z.string().trim().min(1).max(100),
  owner_last_name: z.string().trim().min(1).max(100),
});

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Mint the owner's set-password token inside the new tenant's context
// (password_reset_tokens is RLS-scoped). Separate short transaction
// after create_tenant_with_owner commits.
async function issueOwnerSetupLink(tenantId, subdomain, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const token = await issuePasswordSetupToken(
      client,
      tenantId,
      userId,
      INVITE_TOKEN_EXPIRY_HOURS,
    );
    await client.query('COMMIT');
    return tenantUrl(subdomain, `/reset?token=${token}&invite=1`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function signupTenant(req, res, next) {
  try {
    const parsed = signupTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const data = parsed.data;

    // NULL hash = invited user who hasn't set a password yet
    // (migration 021); login treats it like a wrong password.
    const owner_password_hash = data.owner_password
      ? await bcrypt.hash(data.owner_password, BCRYPT_ROUNDS)
      : null;

    let row;
    try {
      // The function call is one statement, so Postgres wraps it in
      // an implicit transaction — all four inserts succeed or none
      // do. No app-level transaction wrapping needed.
      const result = await pool.query(
        `SELECT tenant_id, user_id, admin_id
           FROM create_tenant_with_owner($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          data.subdomain,
          data.name,
          data.timezone,
          data.owner_email,
          owner_password_hash,
          data.owner_first_name,
          data.owner_last_name,
          // Trial clock starts at signup (PLATFORM_TRIAL_DAYS, default
          // 30; '0' = no clock → NULL, trial never expires). Existing
          // tenants created before migration 025 keep NULL too.
          platformTrialEndsAt(),
        ],
      );
      row = result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        // unique_violation — subdomain or owner email collision.
        return res.status(409).json({ error: 'subdomain or email already taken' });
      }
      if (err.code === '23514') {
        // check_violation — most commonly a reserved subdomain
        // (the schema's CHECK includes a NOT IN list). Map to 400
        // so the caller knows it's input, not server.
        return res.status(400).json({ error: 'subdomain reserved or invalid' });
      }
      throw err;
    }

    await platformAudit(pool, {
      adminId: req.platformAdmin?.id,
      action: 'tenant.create',
      tenantId: row.tenant_id,
      detail: {
        subdomain: data.subdomain,
        name: data.name,
        owner_email: data.owner_email,
        owner_invited: !data.owner_password,
        via: req.platformVia,
      },
      ip: req.ip,
    });

    // Invite path: the token is committed before the email goes out
    // (CLAUDE.md: no external calls inside a transaction). Fire-and-
    // forget like every other email. TODO: outbox.
    let owner_invite_sent = false;
    if (!data.owner_password) {
      const actionUrl = await issueOwnerSetupLink(row.tenant_id, data.subdomain, row.user_id);
      const t = await pool.query('SELECT * FROM tenant_lookup WHERE id = $1', [row.tenant_id]);
      sendAdminInvite({
        tenant: t.rows[0],
        to: data.owner_email,
        firstName: data.owner_first_name,
        actionUrl,
        isNewUser: true,
        isOwner: true,
      }).catch((err) => console.error('[email] owner setup send failed:', err));
      owner_invite_sent = true;
    }

    res.status(201).json({
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      admin_id: row.admin_id,
      subdomain: data.subdomain,
      owner_invite_sent,
    });
  } catch (err) {
    next(err);
  }
}

const setBillingSchema = z.object({
  status: z
    .enum(['trial', 'active', 'past_due', 'cancelled', 'suspended'])
    .optional(),
  // ISO timestamp to (re)set the trial clock, or explicit null to
  // clear it (trial never expires — the "comp this tenant" shape,
  // combined with status 'trial'). Absent = leave unchanged.
  trial_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
});

// PATCH /api/platform/tenants/:subdomain/billing — super-admin
// escape hatch: comp a tenant, extend a trial, suspend, or manually
// reactivate. The automated path is the platform Stripe webhook;
// this exists for the cases Stripe doesn't cover (and for un-bricking
// a tenant whose status was mangled).
export async function setTenantBilling(req, res, next) {
  try {
    const parsed = setBillingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { status, trial_ends_at } = parsed.data;
    const clearTrial = 'trial_ends_at' in req.body && trial_ends_at === null;
    if (status === undefined && trial_ends_at === undefined && !clearTrial) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    const t = await pool.query(
      `SELECT id FROM tenant_lookup WHERE subdomain = $1`,
      [req.params.subdomain],
    );
    if (t.rows.length === 0) {
      return res.status(404).json({ error: 'tenant not found' });
    }

    await pool.query(`SELECT admin_set_platform_billing($1, $2, $3, $4)`, [
      t.rows[0].id,
      status ?? null,
      clearTrial ? null : (trial_ends_at ?? null),
      clearTrial,
    ]);

    await platformAudit(pool, {
      adminId: req.platformAdmin?.id,
      action: 'tenant.billing_update',
      tenantId: t.rows[0].id,
      detail: {
        subdomain: req.params.subdomain,
        status: status ?? null,
        trial_ends_at: clearTrial ? null : (trial_ends_at ?? undefined),
        clear_trial: clearTrial,
        via: req.platformVia,
      },
      ip: req.ip,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
