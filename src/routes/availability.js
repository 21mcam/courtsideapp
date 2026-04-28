// /api/availability — public, tenant-scoped, no auth required.
//
// Members and walk-ins both need to see open slots before they can
// book. resolveTenant runs globally on /api; this router adds
// withTenantContext so the queries land inside the tenant's RLS
// scope.

import express from 'express';
import { withTenantContext } from '../db/withTenantContext.js';
import { getAvailability } from '../controllers/availability.js';

const router = express.Router();

router.get('/', withTenantContext, getAvailability);

export default router;
