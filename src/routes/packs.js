// /api/packs — member-facing credit pack storefront + checkout.
//
// requireAuth runs BEFORE withTenantContext (same ordering rationale
// as routes/me.js): the JWT tenant cross-check rejects cross-tenant
// tokens before a DB connection is checked out. The checkout handler
// additionally requires a member identity (req.user.member_id).

import express from 'express';
import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import {
  listActivePacks,
  startPackCheckout,
} from '../controllers/packs.js';

const router = express.Router();

router.use(requireAuth, withTenantContext);

router.get('/', listActivePacks);
router.post('/:id/checkout', startPackCheckout);

export default router;
