// /api/admin/* — admin-only read views for the admin UI.
//
// Middleware order: requireAuth → requireAdmin → withTenantContext →
// handler. requireAuth verifies the JWT and runs the tenant cross-
// check; requireAdmin gates on role; withTenantContext opens the tx
// with the RLS GUC. resolveTenant is mounted globally on /api in
// app.js, so req.tenant is already populated by the time we get here.

import express from 'express';

import { withTenantContext } from '../db/withTenantContext.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listMembers,
  listAdmins,
  createManualMember,
  adjustMemberCredits,
  listAllBookings,
} from '../controllers/admin.js';
import {
  listResources,
  createResource,
  listOfferings,
  createOffering,
  listOfferingResources,
  linkResourceToOffering,
  listPlans,
  createPlan,
} from '../controllers/catalog.js';
import {
  listOperatingHours,
  createOperatingHours,
  deleteOperatingHours,
  getBookingPolicies,
  upsertBookingPolicies,
  listBlackouts,
  createBlackout,
  deleteBlackout,
} from '../controllers/operations.js';
import {
  createClassInstance,
  listClassInstances,
  cancelClassInstance,
} from '../controllers/classes.js';
import {
  createClassSchedule,
  listClassSchedules,
  generateClassSchedule,
} from '../controllers/classSchedules.js';

const router = express.Router();

router.use(requireAuth, requireAdmin, withTenantContext);

// User management
//   - listMembers: Phase 1 slice 4 (now extended with current_credits
//     in Phase 2 slice 4)
//   - createManualMember + adjustMemberCredits: Phase 2 slice 4
router.get('/members', listMembers);
router.post('/members', createManualMember);
router.post('/members/:id/credit-adjustments', adjustMemberCredits);
router.get('/admins', listAdmins);

// Catalog (Phase 2 slice 2)
router.get('/resources', listResources);
router.post('/resources', createResource);
router.get('/offerings', listOfferings);
router.post('/offerings', createOffering);
router.get('/offerings/:id/resources', listOfferingResources);
router.post('/offerings/:id/resources', linkResourceToOffering);

// Plans (Phase 2 slice 3)
router.get('/plans', listPlans);
router.post('/plans', createPlan);

// Operating hours + booking policies (Phase 3 prep)
router.get('/operating-hours', listOperatingHours);
router.post('/operating-hours', createOperatingHours);
router.delete('/operating-hours/:id', deleteOperatingHours);
router.get('/booking-policies', getBookingPolicies);
router.put('/booking-policies', upsertBookingPolicies);

// Blackouts (Phase 3 prep)
router.get('/blackouts', listBlackouts);
router.post('/blackouts', createBlackout);
router.delete('/blackouts/:id', deleteBlackout);

// Bookings calendar (Phase 3 slice 6) — admin overview of all
// bookings across the tenant with filter + cancel + mark-no-show
// (mutations live on /api/bookings/:id/cancel and /:id/mark-no-show).
router.get('/bookings', listAllBookings);

// Class instances (Phase 4 slice 1) — one-off creation, list, and
// cancel-with-cascade.
router.get('/class-instances', listClassInstances);
router.post('/class-instances', createClassInstance);
router.post('/class-instances/:id/cancel', cancelClassInstance);

// Class schedules + recurrence generator (Phase 4 slice 2).
// POST creates the schedule and runs an initial generation pass;
// /:id/generate extends the horizon for an existing schedule.
router.get('/class-schedules', listClassSchedules);
router.post('/class-schedules', createClassSchedule);
router.post('/class-schedules/:id/generate', generateClassSchedule);

export default router;
