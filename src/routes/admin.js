// /api/admin/* — admin-only read views for the admin UI.
//
// Middleware order: requireAuth → requireAdmin → withTenantContext →
// handler. requireAuth verifies the JWT and runs the tenant cross-
// check; requireAdmin gates on role; withTenantContext opens the tx
// with the RLS GUC. resolveTenant is mounted globally on /api in
// app.js, so req.tenant is already populated by the time we get here.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { listMembers, listAdmins } from '../controllers/admin.js';

const router = express.Router();

router.use(requireAuth, requireAdmin, withTenantContext);

router.get('/members', listMembers);
router.get('/admins', listAdmins);

export default router;
