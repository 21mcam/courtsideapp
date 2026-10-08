// Platform console sessions (migration 032).
//
// A platform session is a JWT with aud='platform' and sub=the
// platform_admins id. It is deliberately incompatible with tenant
// tokens in both directions: requirePlatformAdmin demands the
// audience, and tenant requireAuth refuses any token that carries one.
//
// Every request re-checks the admin row via platform_admin_session(),
// so deactivating a platform admin revokes their live sessions
// immediately rather than at token expiry.
//
// requirePlatformAccess additionally accepts the legacy
// X-Super-Admin-Token header (curl/scripts) for the two endpoints that
// predate the console. Those calls are audited with a NULL admin.

import jwt from 'jsonwebtoken';

import { pool } from '../db/pool.js';
import { requireSuperAdmin } from './superAdmin.js';

export const PLATFORM_AUDIENCE = 'platform';
const SESSION_EXPIRY = '12h';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'CHANGE_ME') throw new Error('JWT_SECRET is not configured');
  return s;
}

export function signPlatformSession(adminId) {
  return jwt.sign({}, secret(), {
    subject: adminId,
    audience: PLATFORM_AUDIENCE,
    expiresIn: SESSION_EXPIRY,
  });
}

export async function requirePlatformAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'not signed in' });
  }

  let payload;
  try {
    payload = jwt.verify(header.slice('Bearer '.length), secret(), {
      audience: PLATFORM_AUDIENCE,
    });
  } catch {
    return res.status(401).json({ error: 'invalid or expired session' });
  }

  try {
    const r = await pool.query(
      'SELECT id, email, display_name FROM platform_admin_session($1)',
      [payload.sub],
    );
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
    req.platformAdmin = r.rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// Session OR legacy token. Downstream code reads
// req.platformAdmin?.id (null for token callers) for audit attribution.
export function requirePlatformAccess(req, res, next) {
  if (req.headers['x-super-admin-token'] !== undefined) {
    return requireSuperAdmin(req, res, () => {
      req.platformAdmin = null;
      req.platformVia = 'token';
      next();
    });
  }
  return requirePlatformAdmin(req, res, (err) => {
    if (err) return next(err);
    req.platformVia = 'session';
    next();
  });
}

// Audit write. By default best-effort: a failed audit must not turn an
// already-completed action into a 500 — but it is logged loudly. Pass
// required: true for actions that must not happen unrecorded (support
// sessions); the error then propagates and the action is refused.
export async function platformAudit(
  db,
  { adminId, action, tenantId = null, detail = {}, ip = null, required = false },
) {
  try {
    await db.query('SELECT platform_audit($1, $2, $3, $4, $5)', [
      adminId ?? null,
      action,
      tenantId,
      JSON.stringify(detail),
      ip,
    ]);
  } catch (err) {
    if (required) throw err;
    console.error(`[platform-audit] failed to record ${action}:`, err);
  }
}
