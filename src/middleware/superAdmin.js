// Super-admin gate for /api/platform/*. "Super admin" in Phase 1
// means platform owner (yours only per PLAN.md), authenticated by a
// shared secret in the X-Super-Admin-Token header.
//
// Comparison is constant-time via SHA-256 hash + timingSafeEqual:
// hashing makes both inputs the same length, sidestepping length-leak
// concerns and the common bug of timingSafeEqual throwing on unequal
// lengths. Yes, the secret is hashed twice on every request — that's
// negligible.
//
// Phase 5+ may graduate this to a real super-admin auth flow (its own
// users table or a magic platform tenant). The signup endpoint won't
// need to change — only this middleware.

import { createHash, timingSafeEqual } from 'node:crypto';

const SUPER_ADMIN_TOKEN = process.env.SUPER_ADMIN_TOKEN;

if (!SUPER_ADMIN_TOKEN) {
  // Don't throw at module load — running without super-admin (e.g.
  // test runs without the env, the smoke-only flow) is valid. The
  // middleware itself returns 503 if a request actually comes in.
  console.warn('SUPER_ADMIN_TOKEN is not set; /api/platform/* will refuse all requests');
}

function constantTimeEqual(a, b) {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

export function requireSuperAdmin(req, res, next) {
  if (!SUPER_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'super-admin not configured' });
  }

  const provided = req.headers['x-super-admin-token'];
  const providedStr = typeof provided === 'string' ? provided : '';

  if (!providedStr) {
    return res.status(401).json({ error: 'missing super-admin token' });
  }

  if (!constantTimeEqual(SUPER_ADMIN_TOKEN, providedStr)) {
    return res.status(401).json({ error: 'invalid super-admin token' });
  }

  next();
}
