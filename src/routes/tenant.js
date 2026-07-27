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
    // Business info for the public booking page (migration 029).
    // Structured fields, rendered structured — never concatenated
    // into a display string server-side. All null until the admin
    // fills them in (or until 029 is applied).
    address: {
      street: req.tenant.address_street ?? null,
      city: req.tenant.address_city ?? null,
      state: req.tenant.address_state ?? null,
      zip: req.tenant.address_zip ?? null,
    },
    business_phone: req.tenant.business_phone ?? null,
    // numeric(2,1) arrives from pg as a string — cast so the client
    // gets a number.
    google_rating:
      req.tenant.google_rating != null ? Number(req.tenant.google_rating) : null,
    google_review_count: req.tenant.google_review_count ?? null,
    google_reviews_url: req.tenant.google_reviews_url ?? null,
    // Public by nature — it ships in page source wherever gtag runs.
    ga4_measurement_id: req.tenant.ga4_measurement_id ?? null,
    // True when platform billing has lapsed. This endpoint is on the
    // billing-exempt list in resolveTenant, so the client still
    // bootstraps and can render the billing-hold screen + admin
    // reactivation path instead of a blank 402.
    billing_blocked: req.tenant.is_billing_ok === false,
  });
});

export default router;
