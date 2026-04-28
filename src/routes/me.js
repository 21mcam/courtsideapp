// /api/me — authenticated route returning the current user + resolved
// role memberships for the active tenant.
//
// Middleware order matters here: requireAuth runs BEFORE
// withTenantContext. requireAuth verifies the JWT and rejects
// cross-tenant tokens with 403 before any DB connection is even
// checked out — that's the app-layer defense. withTenantContext
// then opens the transaction with the tenant GUC; the queries run
// under RLS, which is the DB-layer defense.

import express from 'express';
import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import { me } from '../controllers/me.js';

const router = express.Router();

router.get('/', requireAuth, withTenantContext, me);

export default router;
