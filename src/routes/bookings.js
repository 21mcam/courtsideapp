// /api/bookings — member booking flow.
//
// Both endpoints require an authenticated member token. requireAuth
// runs first (verifies the JWT + tenant cross-check); the controller
// then refuses if the JWT lacks member_id (admin-only users can't
// book as a member).
//
// withTenantContext wraps each request in a transaction with the
// RLS GUC set, so the SELECT FOR UPDATE on resources + the booking
// INSERT + the apply_credit_change call all land atomically.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createMemberBooking,
  listMyBookings,
} from '../controllers/bookings.js';

const router = express.Router();

router.use(requireAuth, withTenantContext);

router.post('/', createMemberBooking);
router.get('/me', listMyBookings);

export default router;
