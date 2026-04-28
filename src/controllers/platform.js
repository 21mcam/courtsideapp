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
           FROM create_tenant_with_owner($1, $2, $3, $4, $5, $6, $7)`,
        [
          data.subdomain,
          data.name,
          data.timezone,
          data.owner_email,
          owner_password_hash,
          data.owner_first_name,
          data.owner_last_name,
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
