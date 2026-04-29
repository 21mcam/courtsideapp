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

// ============================================================
// POST /api/admin/plans/:id/stripe-sync — Phase 5 slice 3
// ============================================================
//
// Creates a Stripe Product + recurring Price on the tenant's
// connected account and stores the resulting price_id back on the
// plan. Idempotent: if the plan already has a stripe_price_id, this
// is a no-op (returning the existing id).
//
// Why per-tenant Products: each tenant runs Connect Standard, which
// means they're independent merchants on Stripe. A Price ID created
// on tenant A's account is meaningless to tenant B. The platform
// itself never owns plan Products — it just stores the references.
//
// Re-pricing: if a tenant changes monthly_price_cents on an
// already-synced plan, this endpoint does NOT replace the Stripe
// Price (Stripe immutability — prices can't be edited). For now,
// document the workflow as: deactivate old plan → create new plan
// with the new price → re-sync. Phase 5 slice 5+ may add a "rotate
// price" helper when subscriptions are in flight.
export async function syncPlanToStripe(req, res, next) {
  try {
    const { tenant, db } = req;
    const planId = req.params.id;

    // Pull plan + connection state in parallel-ish (still one client
    // because we're inside withTenantContext's transaction).
    const planRes = await db.query(
      `SELECT id, name, description, monthly_price_cents, active, stripe_price_id
         FROM plans WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, planId],
    );
    if (planRes.rows.length === 0) {
      return res.status(404).json({ error: 'plan not found' });
    }
    const plan = planRes.rows[0];

    // Already synced — return existing id without touching Stripe.
    if (plan.stripe_price_id) {
      return res.json({ plan, synced: false, reason: 'already synced' });
    }

    if (plan.monthly_price_cents <= 0) {
      return res
        .status(409)
        .json({ error: 'cannot sync a free plan to Stripe (no recurring price)' });
    }
    if (!plan.active) {
      return res
        .status(409)
        .json({ error: 'cannot sync an inactive plan; activate it first' });
    }

    // Pull connection. Must be present + charges_enabled before we
    // call Stripe. Otherwise the Price.create would 400 from Stripe
    // anyway with a less helpful error.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0) {
      return res.status(409).json({
        error: 'tenant has not connected a Stripe account; finish onboarding first',
      });
    }
    const conn = connRes.rows[0];
    if (!conn.charges_enabled) {
      return res.status(409).json({
        error: 'Stripe account is not yet charges-enabled; finish onboarding first',
      });
    }

    const stripe = getStripe();
    // Connect: every API call below must specify { stripeAccount }.
    const opts = { stripeAccount: conn.stripe_account_id };

    let priceId;
    try {
      const product = await stripe.products.create(
        {
          name: plan.name,
          description: plan.description ?? undefined,
          metadata: {
            courtside_plan_id: plan.id,
            courtside_tenant_id: tenant.id,
          },
        },
        opts,
      );
      const price = await stripe.prices.create(
        {
          product: product.id,
          unit_amount: plan.monthly_price_cents,
          currency: 'usd',
          recurring: { interval: 'month' },
          metadata: {
            courtside_plan_id: plan.id,
            courtside_tenant_id: tenant.id,
          },
        },
        opts,
      );
      priceId = price.id;
    } catch (err) {
      // Stripe-side failure (account not ready, validation, etc.).
      // Surface the message — admin needs to know what to fix.
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }

    // Store the price_id back on the plan. The unique index
    // plans_stripe_price_unique catches a same-id collision (would
    // only happen on a buggy/double call); we already short-circuited
    // above when stripe_price_id was already set, so a 23505 here is
    // a genuine bug, not a normal case.
    const updRes = await db.query(
      `UPDATE plans
          SET stripe_price_id = $1
        WHERE tenant_id = $2 AND id = $3
        RETURNING id, name, description, monthly_price_cents,
                  credits_per_week,
                  allowed_categories::text[] AS allowed_categories,
                  stripe_price_id, active, display_order,
                  created_at, updated_at`,
      [priceId, tenant.id, planId],
    );

    res.json({ plan: updRes.rows[0], synced: true });
  } catch (err) {
    next(err);
  }
}

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
