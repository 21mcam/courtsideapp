// /webhooks/stripe — apex-level webhook receiver.
//
// CRITICAL mount order: this router must be mounted BEFORE
// express.json() in app.js. The signature verification works on the
// raw request bytes; if express.json() runs first it consumes the
// body and the signature check fails silently. CLAUDE.md gotcha #5.
//
// No auth, no resolveTenant, no withTenantContext — Stripe POSTs
// from api.stripe.com and the controller bootstraps tenant context
// itself from the event payload.

import express from 'express';

import { handleStripeWebhook } from '../controllers/stripeWebhook.js';

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook,
);

export default router;
