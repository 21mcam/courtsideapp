// /api/class-instances — member-readable list of upcoming bookable
// class instances. Mirrors /api/availability for rentals: pre-auth
// in the sense that it requires only requireAuth (any signed-in
// user), no role gate.
//
// Mounted in app.js. Uses withTenantContext per-route so RLS applies.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import { listAvailableClassInstances } from '../controllers/classBookings.js';

const router = express.Router();

router.use(requireAuth, withTenantContext);

router.get('/', listAvailableClassInstances);

export default router;
