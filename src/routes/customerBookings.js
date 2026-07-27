// /api/customers/bookings — public walk-in booking flow.
//
// No auth (anyone can book a public slot). resolveTenant runs at
// the /api level (apex mount in app.js); withTenantContext is
// applied per-route here so RLS is in effect.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import {
  createCustomerBooking,
  listPublicOfferings,
  lookupCustomerBooking,
  getManageBooking,
  rescheduleManagedBooking,
} from '../controllers/customerBookings.js';

const router = express.Router();

router.use(withTenantContext);

router.get('/offerings', listPublicOfferings);
router.post('/bookings', createCustomerBooking);
// Email-gated lookup for the walk-in success page ('/bookings' above
// is an exact-path match, so it can't shadow this).
router.post('/bookings/lookup', lookupCustomerBooking);
// No-login manage/reschedule via the capability token from the
// confirmation email. Unknown tokens 404 identically to the lookup.
router.get('/bookings/manage/:token', getManageBooking);
router.post('/bookings/manage/:token/reschedule', rescheduleManagedBooking);

export default router;
