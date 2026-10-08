// Read-only support sessions: the platform operator opening a tenant's
// admin UI to see what the owner sees.
//
// Two tokens, because the console (admin.{APP_HOSTNAME}) and the
// tenant ({subdomain}.{APP_HOSTNAME}) are different origins and can't
// share localStorage:
//
//   1. Handoff token — minted by the console, aud='support-handoff',
//      60-second life, carried to the tenant origin in the URL
//      FRAGMENT (never sent to any server, so it stays out of access
//      logs and Referer headers).
//   2. Session token — what the tenant SPA stores after exchanging the
//      handoff at POST /api/auth/support-session. A normal tenant JWT
//      for the tenant's owner, plus read_only + support_admin_id, with
//      a 1-hour life. requireAuth refuses every non-GET request for it
//      and withTenantContext runs its transactions READ ONLY.

import jwt from 'jsonwebtoken';

export const HANDOFF_AUDIENCE = 'support-handoff';
const HANDOFF_EXPIRY_SECONDS = 60;
const SESSION_EXPIRY = '1h';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'CHANGE_ME') throw new Error('JWT_SECRET is not configured');
  return s;
}

export function signSupportHandoff({ adminId, tenantId }) {
  return jwt.sign({ tenant_id: tenantId }, secret(), {
    subject: adminId,
    audience: HANDOFF_AUDIENCE,
    expiresIn: HANDOFF_EXPIRY_SECONDS,
  });
}

// Returns { adminId, tenantId } or null.
export function verifySupportHandoff(token) {
  try {
    const p = jwt.verify(token, secret(), { audience: HANDOFF_AUDIENCE });
    return { adminId: p.sub, tenantId: p.tenant_id };
  } catch {
    return null;
  }
}

export function signSupportSession({ tenantId, userId, adminId, platformAdminId }) {
  return jwt.sign(
    {
      tenant_id: tenantId,
      user_id: userId,
      member_id: null,
      admin_id: adminId,
      role: 'admin',
      read_only: true,
      support_admin_id: platformAdminId,
    },
    secret(),
    { expiresIn: SESSION_EXPIRY },
  );
}
