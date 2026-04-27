// Resolves the tenant from the request hostname and attaches it as
// req.tenant. Mount this on /api/* — it's the prerequisite for
// withTenantContext (which sets the per-request RLS GUC).
//
// Hostname strategy:
//   * Production: {subdomain}.{APP_HOSTNAME}, e.g. momentum.courtside.com
//   * Local dev:  {subdomain}.localhost works in modern browsers without
//     /etc/hosts edits — the browser resolves *.localhost to 127.0.0.1.
//   * Local dev fallback: ?tenant=foo when the host is bare localhost
//     (curl, etc.).
//
// This middleware queries `tenant_lookup` directly (not via
// withTenantContext) — the view is the unprivileged routing surface
// for app_runtime, exposed to the runtime role per migration 011. No
// tenant context exists yet at this point in the request lifecycle,
// which is fine: the view's owner (postgres) bypasses RLS on the
// underlying tenants table.

import { pool } from '../db/pool.js';

const APP_HOSTNAME = process.env.APP_HOSTNAME || 'localhost';

// Mirrors the schema's subdomain CHECK regex. Defense in depth against
// crafted Host headers — even though we only query a parameterized
// SELECT, an obviously-malformed subdomain skips the DB roundtrip.
const SUBDOMAIN_SHAPE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function extractSubdomain(hostname, query) {
  // Bare localhost / 127.0.0.1: use ?tenant= fallback.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return typeof query.tenant === 'string' ? query.tenant : null;
  }

  const suffix = '.' + APP_HOSTNAME;
  if (!hostname.endsWith(suffix)) return null;
  return hostname.slice(0, -suffix.length);
}

export async function resolveTenant(req, res, next) {
  try {
    const subdomain = extractSubdomain(req.hostname, req.query);

    if (!subdomain) {
      return res.status(404).json({ error: 'no tenant in hostname' });
    }
    if (!SUBDOMAIN_SHAPE.test(subdomain)) {
      return res.status(404).json({ error: 'invalid subdomain' });
    }

    const result = await pool.query(
      'SELECT id, subdomain, name, timezone, is_billing_ok FROM tenant_lookup WHERE subdomain = $1',
      [subdomain],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'tenant not found' });
    }

    const tenant = result.rows[0];

    if (!tenant.is_billing_ok) {
      // 402 Payment Required — tenant subscription not in good standing.
      return res.status(402).json({ error: 'tenant billing not in good standing' });
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}
