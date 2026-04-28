// /api/class-bookings — member class-booking flow.
//
// Member endpoints (require member_id in JWT):
//   POST /            book a class instance
//   GET  /me          list own class bookings
//   POST /:id/cancel  self-cancel (admin override allowed)
//
// Admin endpoint:
//   POST /:id/mark-no-show
//
// Same middleware sandwich as /api/bookings: requireAuth +
// withTenantContext (one transaction per request, RLS GUC set).

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createMemberClassBooking,
  cancelMemberClassBooking,
  markClassBookingNoShow,
  listMyClassBookings,
} from '../controllers/classBookings.js';

const router = express.Router();

router.use(requireAuth, withTenantContext);

router.post('/', createMemberClassBooking);
router.get('/me', listMyClassBookings);
router.post('/:id/cancel', cancelMemberClassBooking);
router.post('/:id/mark-no-show', markClassBookingNoShow);

export default router;
