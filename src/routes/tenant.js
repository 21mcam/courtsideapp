// GET /api/tenant — returns the tenant resolved from the request
// hostname. Doesn't need DB access (resolveTenant already populated
// req.tenant), so no withTenantContext wrapper.
//
// This is what the frontend hits in Checkpoint G to render
// "Hello, {tenant.name}".

import express from 'express';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    id: req.tenant.id,
    subdomain: req.tenant.subdomain,
    name: req.tenant.name,
    timezone: req.tenant.timezone,
    // Falls back to indigo until migration 019 is applied.
    theme_accent: req.tenant.theme_accent || 'indigo',
    // Falls back to null until migration 020 is applied.
    reply_to_email: req.tenant.reply_to_email ?? null,
    // True when platform billing has lapsed. This endpoint is on the
    // billing-exempt list in resolveTenant, so the client still
    // bootstraps and can render the billing-hold screen + admin
    // reactivation path instead of a blank 402.
    billing_blocked: req.tenant.is_billing_ok === false,
  });
});

export default router;
