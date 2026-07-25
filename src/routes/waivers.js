// /api/waivers — liability waiver text + member signing.
//
// GET /current is PUBLIC (no auth): the walk-in booking form renders
// the waiver inline before any account exists. resolveTenant runs at
// the /api level (app.js); withTenantContext is applied per-route so
// RLS is in effect.
//
// POST /sign requires an authenticated member (the controller
// additionally refuses tokens without member_id).

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import { getCurrentWaiver, signWaiver } from '../controllers/waivers.js';

const router = express.Router();

router.get('/current', withTenantContext, getCurrentWaiver);
router.post('/sign', requireAuth, withTenantContext, signWaiver);

export default router;
