// /webhooks/stripe-platform — events from the platform's OWN Stripe
// account (tenant billing). Same critical constraint as
// /webhooks/stripe: must be mounted BEFORE express.json() in app.js
// with express.raw so signature verification sees the exact bytes
// (CLAUDE.md gotcha #5).

import express from 'express';

import { handlePlatformStripeWebhook } from '../controllers/platformStripeWebhook.js';

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  handlePlatformStripeWebhook,
);

export default router;
