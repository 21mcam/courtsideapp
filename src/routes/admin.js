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
import {
  listResources,
  createResource,
  listOfferings,
  createOffering,
  listOfferingResources,
  linkResourceToOffering,
  listPlans,
  createPlan,
} from '../controllers/catalog.js';

const router = express.Router();

router.use(requireAuth, requireAdmin, withTenantContext);

// User management (Phase 1 slice 4)
router.get('/members', listMembers);
router.get('/admins', listAdmins);

// Catalog (Phase 2 slice 2)
router.get('/resources', listResources);
router.post('/resources', createResource);
router.get('/offerings', listOfferings);
router.post('/offerings', createOffering);
router.get('/offerings/:id/resources', listOfferingResources);
router.post('/offerings/:id/resources', linkResourceToOffering);

// Plans (Phase 2 slice 3)
router.get('/plans', listPlans);
router.post('/plans', createPlan);

export default router;
