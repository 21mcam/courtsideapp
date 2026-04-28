// JWT verification middleware. Phase 0 ships this scaffold; Phase 1
// adds the login/register routes that issue tokens.
//
// Expected token shape (signed in Phase 1):
//   { tenant_id, user_id, role: 'member' | 'admin' | 'owner' }
//
// On success, attaches `req.user` with the decoded payload. On failure,
// responds 401 (missing/invalid token) or 403 (token belongs to a
// different tenant).
//
// The tenant cross-check is defense in depth: even if a token is valid,
// using it on a different tenant's subdomain is a 403. The browser's
// same-origin policy prevents this in normal flows, but we don't rely
// on that.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET === 'CHANGE_ME') {
  // Don't throw — login/register isn't built yet, and Phase 0 routes
  // don't actually call requireAuth. Phase 1 will fail loudly on first
  // verify if the secret isn't set. Logging now keeps that future
  // failure traceable.
  console.warn('JWT_SECRET is not set or is the placeholder; auth will fail when used');
}

export function requireAuth(req, res, next) {
  if (!req.tenant?.id) {
    return next(
      new Error('requireAuth requires req.tenant; mount resolveTenant earlier'),
    );
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing or malformed authorization header' });
  }

  const token = header.slice('Bearer '.length);

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }

  if (payload.tenant_id !== req.tenant.id) {
    return res.status(403).json({ error: 'token does not belong to this tenant' });
  }

  req.user = payload;
  next();
}

// Gate routes to admin/owner-only callers. Mount AFTER requireAuth.
// Phase 1 makes no distinction between admin and owner roles for
// access control — both pass. Finer-grained gates ("only owners can
// edit billing") come later.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin role required' });
  }
  next();
}
