// /api/platform/* — the platform (super-admin) console API. Mounted
// BEFORE resolveTenant in src/app.js: these run on the console host
// (admin.{APP_HOSTNAME}) with no tenant context.
//
// Auth:
//   * /auth/login                 — public (email + password + TOTP)
//   * reads + support sessions    — platform console session only
//   * signup-tenant, billing      — session OR legacy
//                                   X-Super-Admin-Token (curl/scripts)

import express from 'express';

import { requirePlatformAccess, requirePlatformAdmin } from '../middleware/platformAuth.js';
import { signupTenant, setTenantBilling } from '../controllers/platform.js';
import {
  getTenant,
  listAudit,
  listTenants,
  platformLogin,
  platformMe,
  setVisibility,
  startSupportSession,
} from '../controllers/platformConsole.js';

const router = express.Router();

router.post('/auth/login', platformLogin);

router.get('/me', requirePlatformAdmin, platformMe);
router.get('/tenants', requirePlatformAdmin, listTenants);
router.get('/tenants/:id', requirePlatformAdmin, getTenant);
router.post('/tenants/:id/support-session', requirePlatformAdmin, startSupportSession);
router.patch('/tenants/:id/visibility', requirePlatformAdmin, setVisibility);
router.get('/audit', requirePlatformAdmin, listAudit);

router.post('/signup-tenant', requirePlatformAccess, signupTenant);
router.patch('/tenants/:subdomain/billing', requirePlatformAccess, setTenantBilling);

// Catch-all for /api/platform/* paths that don't match — return JSON
// 404 so the request doesn't fall through to the tenant chain below.
router.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

export default router;
