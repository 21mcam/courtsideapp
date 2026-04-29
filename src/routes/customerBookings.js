// /api/customers/bookings — public walk-in booking flow.
//
// No auth (anyone can book a public slot). resolveTenant runs at
// the /api level (apex mount in app.js); withTenantContext is
// applied per-route here so RLS is in effect.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { createCustomerBooking } from '../controllers/customerBookings.js';

const router = express.Router();

router.use(withTenantContext);

router.post('/bookings', createCustomerBooking);

export default router;
