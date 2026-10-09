// Search-engine policy for everything that ISN'T /api (migration 035).
//
// The SPA's HTML is served by express.static / the SPA fallback, which
// never run resolveTenant — so a non-public facility's pages need their
// own noindex signal, and robots.txt has to answer per host:
//
//   * {subdomain}.{APP_HOSTNAME} — tenant pages: indexable only when
//     tenants.visibility = 'public'.
//   * the apex, admin.{APP_HOSTNAME} (platform console), unknown hosts —
//     never indexed.
//
// Server-side on purpose: Google honours an X-Robots-Tag header and
// robots.txt without running our JavaScript.
//
// Visibility is cached per subdomain for CACHE_MS so a page load
// (HTML + a dozen assets) costs at most one lookup.

import { pool } from '../db/pool.js';
import { extractSubdomain } from './resolveTenant.js';

const CACHE_MS = 60 * 1000;
const cache = new Map(); // subdomain -> { indexable, at }

export function __clearCrawlerCache() {
  cache.clear();
}

async function isIndexable(req) {
  const sub = extractSubdomain(req.hostname, req.query);
  if (!sub || sub === 'admin') return false;
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.indexable;
  let indexable = false;
  try {
    const r = await pool.query('SELECT visibility FROM tenant_lookup WHERE subdomain = $1', [sub]);
    indexable = r.rows[0]?.visibility === 'public';
  } catch (err) {
    console.error('[crawler-policy] lookup failed:', err);
    return false; // fail closed: never index on error
  }
  cache.set(sub, { indexable, at: Date.now() });
  return indexable;
}

export async function robotsTxt(req, res) {
  const indexable = await isIndexable(req);
  res.type('text/plain').set('Cache-Control', 'public, max-age=300');
  res.send(indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');
}

export async function crawlerHeaders(req, res, next) {
  if (!(await isIndexable(req))) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}
