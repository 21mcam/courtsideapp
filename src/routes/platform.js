// /api/platform/* — super-admin endpoints. Mounted BEFORE
// resolveTenant in src/app.js because these run on the apex
// hostname; there's no tenant context yet at signup time.
//
// All endpoints require the X-Super-Admin-Token header.

import express from 'express';

import { requireSuperAdmin } from '../middleware/superAdmin.js';
import { signupTenant } from '../controllers/platform.js';

const router = express.Router();

router.post('/signup-tenant', requireSuperAdmin, signupTenant);

// Catch-all for /api/platform/* paths that don't match — return JSON
// 404 so the request doesn't fall through to the tenant chain below.
router.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

export default router;
