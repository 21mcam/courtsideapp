// GET /api/customers/home — the data behind a facility's public home
// page (what a logged-out visitor sees at {subdomain}.{APP_HOSTNAME}/).
//
// Public, no auth. Profile fields (name, address, phone, rating) already
// ship on GET /api/tenant and the bookable services on
// GET /api/customers/offerings; this adds only what neither carries:
//
//   * hours — the facility-wide union of active resources' operating
//     hours, one entry per weekday (src/lib/hours.js).
//   * plans — membership plans a visitor can actually buy. Same filter
//     as the member plan chooser (active AND has a Stripe price), so
//     the page never advertises a plan checkout would refuse.

import { mergeWeeklyHours } from '../lib/hours.js';

export async function getPublicHome(req, res, next) {
  try {
    const hoursRes = await req.db.query(
      `SELECT oh.day_of_week, oh.open_time, oh.close_time
         FROM operating_hours oh
         JOIN resources r
           ON r.tenant_id = oh.tenant_id AND r.id = oh.resource_id
        WHERE oh.tenant_id = $1
          AND r.active`,
      [req.tenant.id],
    );

    const plansRes = await req.db.query(
      `SELECT id, name, description, monthly_price_cents, credits_per_week
         FROM plans
        WHERE tenant_id = $1
          AND active
          AND stripe_price_id IS NOT NULL
        ORDER BY display_order ASC, monthly_price_cents ASC`,
      [req.tenant.id],
    );

    res.json({
      hours: mergeWeeklyHours(hoursRes.rows),
      plans: plansRes.rows,
    });
  } catch (err) {
    next(err);
  }
}
