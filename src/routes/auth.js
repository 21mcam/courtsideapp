// /api/auth — Phase 1, slice 1.
//
// Tenant-scoped (resolveTenant is mounted globally on /api in app.js).
// Login + register-member need DB access, so they go through
// withTenantContext. NO requireAuth here — these are pre-auth routes.

import express from 'express';
import { withTenantContext } from '../db/withTenantContext.js';
import { registerMember, login } from '../controllers/auth.js';
import { forgotPassword, resetPassword } from '../controllers/passwordReset.js';

const router = express.Router();

router.post('/register-member', withTenantContext, registerMember);
router.post('/login', withTenantContext, login);
router.post('/forgot-password', withTenantContext, forgotPassword);
router.post('/reset-password', withTenantContext, resetPassword);

export default router;
