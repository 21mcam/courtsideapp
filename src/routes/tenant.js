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
  });
});

export default router;
