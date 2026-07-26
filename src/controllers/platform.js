// Super-admin / platform controllers. Live on /api/platform/* on the
// apex hostname (no tenant context — these are platform-level ops).
//
// All paths are gated by requireSuperAdmin (X-Super-Admin-Token).
// All DB writes go through SECURITY DEFINER functions so the runtime
// pool itself never has direct access to privileged tables. The web
// process holds zero superuser DB credentials.

import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { platformTrialEndsAt } from './platformBilling.js';

const BCRYPT_ROUNDS = 10;

const signupTenantSchema = z.object({
  // Subdomain shape mirrors the schema's CHECK regex. The reserved-
  // name list is only enforced at the DB layer (CHECK on tenants);
  // a 23514 from the function call below maps to 400.
  subdomain: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 'invalid subdomain'),
  name: z.string().trim().min(1).max(200),
  // IANA timezone name (e.g. America/New_York). Loose validation —
  // the DB CHECK only requires non-empty trimmed; PG will accept any
  // string here. App-level deeper validation can come later.
  timezone: z.string().trim().min(1).max(100),
  owner_email: z.string().email().toLowerCase().trim(),
  owner_password: z.string().min(8, 'password must be at least 8 characters'),
  owner_first_name: z.string().trim().min(1).max(100),
  owner_last_name: z.string().trim().min(1).max(100),
});

export async function signupTenant(req, res, next) {
  try {
    const parsed = signupTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const data = parsed.data;

    const owner_password_hash = await bcrypt.hash(
      data.owner_password,
      BCRYPT_ROUNDS,
    );

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

    res.status(201).json({
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      admin_id: row.admin_id,
      subdomain: data.subdomain,
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
