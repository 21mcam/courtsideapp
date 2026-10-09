// Platform console API (migration 032) — the super-admin's own login
// plus cross-tenant read views. Mounted under /api/platform, which sits
// BEFORE resolveTenant: there is no tenant context here, so queries go
// through the pool to SECURITY DEFINER platform_* functions (never to
// tenant tables directly — app_runtime couldn't read them cross-tenant
// anyway, by design).

import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { createLoginThrottle } from '../lib/loginThrottle.js';
import { tenantUrl } from '../lib/publicUrl.js';
import { signSupportHandoff } from '../lib/supportSession.js';
import { verifyTotp } from '../lib/totp.js';
import { platformAudit, signPlatformSession } from '../middleware/platformAuth.js';

// Same timing-equalizer idea as tenant login (controllers/auth.js):
// unknown email / inactive admin cost one bcrypt compare, like a wrong
// password, so response time doesn't reveal which emails exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('platform-timing-equalizer', 10);

export const loginThrottle = createLoginThrottle();

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'enter the 6-digit code'),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/platform/auth/login
export async function platformLogin(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'email, password and 6-digit code are required' });
    }
    const { email, password, code } = parsed.data;
    const keys = [`ip:${req.ip}`, `email:${email}`];

    const wait = loginThrottle.blockedFor(keys);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'too many attempts — try again later' });
    }

    const fail = async (reason, adminId = null) => {
      loginThrottle.recordFailure(keys);
      await platformAudit(pool, {
        adminId,
        action: 'auth.login_failed',
        detail: { email, reason },
        ip: req.ip,
      });
      return res.status(401).json({ error: 'invalid credentials' });
    };

    const r = await pool.query(
      'SELECT id, password_hash, totp_secret, active FROM platform_admin_for_login($1)',
      [email],
    );
    const admin = r.rows[0];

    if (!admin) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return fail('unknown_email');
    }
    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) return fail('bad_password', admin.id);
    if (!admin.active) return fail('inactive', admin.id);

    const step = verifyTotp(admin.totp_secret, code);
    if (step === null) return fail('bad_code', admin.id);

    // Consumes the step (single-use codes) and writes the auth.login
    // audit row in one statement.
    const rec = await pool.query('SELECT platform_admin_record_login($1, $2, $3) AS ok', [
      admin.id,
      step,
      req.ip,
    ]);
    if (!rec.rows[0].ok) return fail('code_reused', admin.id);

    loginThrottle.clear(keys);
    res.json({ token: signPlatformSession(admin.id) });
  } catch (err) {
    next(err);
  }
}

// GET /api/platform/me
export function platformMe(req, res) {
  res.json({ admin: req.platformAdmin });
}

// GET /api/platform/tenants
export async function listTenants(req, res, next) {
  try {
    const r = await pool.query('SELECT * FROM platform_list_tenants($1)', [
      req.platformAdmin.id,
    ]);
    // visibility (migration 035) rides tenant_lookup, not the list fn.
    const vis = await pool.query('SELECT id, visibility FROM tenant_lookup');
    const visById = new Map(vis.rows.map((v) => [v.id, v.visibility]));
    res.json({
      tenants: r.rows.map((t) => ({
        ...t,
        visibility: visById.get(t.id) ?? 'public',
        booking_url: tenantUrl(t.subdomain, '/walk-in'),
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/platform/tenants/:id
export async function getTenant(req, res, next) {
  try {
    if (!UUID.test(req.params.id)) {
      return res.status(404).json({ error: 'tenant not found' });
    }
    const r = await pool.query('SELECT platform_get_tenant($1, $2, $3) AS doc', [
      req.platformAdmin.id,
      req.params.id,
      req.ip,
    ]);
    const doc = r.rows[0].doc;
    if (!doc) return res.status(404).json({ error: 'tenant not found' });

    const audit = await pool.query(
      'SELECT * FROM platform_list_audit($1, $2, $3)',
      [req.platformAdmin.id, req.params.id, 20],
    );

    const vis = await pool.query('SELECT visibility FROM tenant_lookup WHERE id = $1', [
      req.params.id,
    ]);
    doc.tenant.visibility = vis.rows[0]?.visibility ?? 'public';

    res.json({
      ...doc,
      urls: {
        home: tenantUrl(doc.tenant.subdomain, '/'),
        booking: tenantUrl(doc.tenant.subdomain, '/walk-in'),
      },
      audit: audit.rows,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/platform/audit?tenant_id=&limit=
export async function listAudit(req, res, next) {
  try {
    const tenantId = typeof req.query.tenant_id === 'string' && UUID.test(req.query.tenant_id)
      ? req.query.tenant_id
      : null;
    const limit = Number.parseInt(req.query.limit, 10) || 100;
    const r = await pool.query('SELECT * FROM platform_list_audit($1, $2, $3)', [
      req.platformAdmin.id,
      tenantId,
      limit,
    ]);
    res.json({ entries: r.rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/platform/tenants/:id/support-session
//
// Mints the 60-second handoff and returns the tenant URL that redeems
// it. The console opens that URL in a new tab; the tenant SPA trades
// the handoff for a read-only session (POST /api/auth/support-session).
export async function startSupportSession(req, res, next) {
  try {
    if (!UUID.test(req.params.id)) {
      return res.status(404).json({ error: 'tenant not found' });
    }
    const t = await pool.query('SELECT id, subdomain FROM tenant_lookup WHERE id = $1', [
      req.params.id,
    ]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    const tenant = t.rows[0];

    await platformAudit(pool, {
      adminId: req.platformAdmin.id,
      action: 'support_session.issue',
      tenantId: tenant.id,
      detail: { subdomain: tenant.subdomain, read_only: true },
      ip: req.ip,
      required: true,
    });

    const handoff = signSupportHandoff({ adminId: req.platformAdmin.id, tenantId: tenant.id });
    res.json({
      url: tenantUrl(tenant.subdomain, `/support-session#token=${encodeURIComponent(handoff)}`),
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/platform/tenants/:id/visibility  { visibility }
// private | unlisted | public (migration 035). Audited in the DB
// function itself.
const visibilitySchema = z.object({ visibility: z.enum(['private', 'unlisted', 'public']) });

export async function setVisibility(req, res, next) {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'tenant not found' });
    const parsed = visibilitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'visibility must be private, unlisted or public' });
    try {
      await pool.query('SELECT platform_set_visibility($1, $2, $3, $4)', [
        req.platformAdmin.id,
        req.params.id,
        parsed.data.visibility,
        req.ip,
      ]);
    } catch (err) {
      if (/tenant not found/.test(err.message)) return res.status(404).json({ error: 'tenant not found' });
      throw err;
    }
    res.json({ visibility: parsed.data.visibility });
  } catch (err) {
    next(err);
  }
}
