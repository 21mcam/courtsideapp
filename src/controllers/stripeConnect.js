// Stripe Connect onboarding — Phase 5 slice 1.
//
// Two endpoints, both admin-only:
//
//   POST /api/admin/stripe/onboarding
//     If the tenant has no stripe_connections row, creates a Standard
//     Connect account on Stripe and inserts the row. Either way,
//     returns a fresh hosted onboarding URL the admin should open
//     to complete (or update) the Stripe-side identity flow.
//
//   GET  /api/admin/stripe/connection
//     Returns the current connection row (or null if none yet). If
//     `?refresh=true`, calls Stripe to pull current account state
//     and updates the local DB row before responding. Webhook-driven
//     state sync lands in slice 2 — for now the admin can re-fetch
//     to update flags after completing onboarding.

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';

const onboardingSchema = z.object({
  return_url: z.string().url(),
  refresh_url: z.string().url(),
});

export async function startOnboarding(req, res, next) {
  try {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { return_url, refresh_url } = parsed.data;
    const { tenant, db } = req;
    const stripe = getStripe();

    // Look up existing connection.
    const existing = await db.query(
      `SELECT stripe_account_id FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );

    let stripe_account_id;
    if (existing.rows.length > 0) {
      stripe_account_id = existing.rows[0].stripe_account_id;
    } else {
      // Create a fresh Standard Connect account. Pre-fill business_type
      // from the tenant — Stripe lets the user override during their
      // own onboarding form. We DO NOT pass capabilities; Standard
      // accounts get card_payments + transfers automatically.
      const account = await stripe.accounts.create({
        type: 'standard',
        email: req.user.email ?? undefined,
        country: 'US',
        metadata: {
          courtside_tenant_id: tenant.id,
          courtside_subdomain: tenant.subdomain,
        },
      });
      stripe_account_id = account.id;
      await db.query(
        `INSERT INTO stripe_connections (
           tenant_id, stripe_account_id,
           details_submitted, charges_enabled, payouts_enabled
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenant.id,
          stripe_account_id,
          account.details_submitted,
          account.charges_enabled,
          account.payouts_enabled,
        ],
      );
    }

    // Account links are short-lived (~5 min). Generate fresh on every
    // call — admins might revisit the page.
    const link = await stripe.accountLinks.create({
      account: stripe_account_id,
      type: 'account_onboarding',
      return_url,
      refresh_url,
    });

    res.json({
      stripe_account_id,
      onboarding_url: link.url,
      expires_at: link.expires_at,
    });
  } catch (err) {
    next(err);
  }
}

export async function getConnection(req, res, next) {
  try {
    const { tenant, db } = req;
    const refresh = String(req.query.refresh) === 'true';

    const r = await db.query(
      `SELECT stripe_account_id, details_submitted, charges_enabled,
              payouts_enabled, platform_fee_basis_points,
              connected_at, fully_onboarded_at
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (r.rows.length === 0) {
      return res.json({ connection: null });
    }
    let row = r.rows[0];

    if (refresh) {
      // Pull fresh state from Stripe and reconcile the DB. Useful
      // right after the admin returns from the Stripe-hosted
      // onboarding flow to see updated flags without waiting for
      // the webhook (slice 2).
      const stripe = getStripe();
      let account;
      try {
        account = await stripe.accounts.retrieve(row.stripe_account_id);
      } catch (err) {
        // If the Stripe account was deleted out from under us, surface
        // it but don't blow up — keep the cached row.
        return res.json({
          connection: row,
          refresh_error: err.message,
        });
      }

      const fully = account.details_submitted && account.charges_enabled;
      const upd = await db.query(
        `UPDATE stripe_connections
            SET details_submitted = $1,
                charges_enabled    = $2,
                payouts_enabled    = $3,
                fully_onboarded_at = COALESCE(fully_onboarded_at,
                                              CASE WHEN $4 THEN now() ELSE NULL END)
          WHERE tenant_id = $5
          RETURNING stripe_account_id, details_submitted, charges_enabled,
                    payouts_enabled, platform_fee_basis_points,
                    connected_at, fully_onboarded_at`,
        [
          account.details_submitted,
          account.charges_enabled,
          account.payouts_enabled,
          fully,
          tenant.id,
        ],
      );
      row = upd.rows[0];
    }

    res.json({ connection: row });
  } catch (err) {
    next(err);
  }
}
