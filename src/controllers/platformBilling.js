// Platform billing — what the tenant pays Courtside.
//
// Money flows to the PLATFORM's own Stripe account (STRIPE_SECRET_KEY,
// no { stripeAccount } option) — this is the one flow that is not
// Stripe Connect. The tenant's connected account is never involved.
//
// The runtime role has REVOKE ALL on tenants (migration 011), so
// every read/write of the billing columns goes through the SECURITY
// DEFINER functions from migration 025 (get_platform_billing,
// set_platform_customer). All of them are GUC-guarded, so they run
// on req.db inside the tenant transaction like everything else.
//
// Config (all platform-level env, documented in .env.example):
//   PLATFORM_PRICE_ID            Stripe Price for the monthly SaaS fee.
//                                Unset = billing not configured; the
//                                admin UI shows a "contact us" state
//                                and checkout 503s.
//   PLATFORM_MONTHLY_PRICE_CENTS Display-only price for the UI.
//   PLATFORM_TRIAL_DAYS          Trial length for NEW tenants
//                                (default 30; '0' = no trial clock,
//                                trial never expires).

import { z } from 'zod';

import { getStripe } from '../services/stripe.js';

function billingConfigured() {
  return Boolean(process.env.PLATFORM_PRICE_ID);
}

function monthlyPriceCents() {
  const raw = process.env.PLATFORM_MONTHLY_PRICE_CENTS;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function platformTrialEndsAt(now = new Date()) {
  const raw = process.env.PLATFORM_TRIAL_DAYS ?? '30';
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0) return null; // no trial clock
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

async function readBilling(db, tenantId) {
  const res = await db.query(
    `SELECT status, trial_ends_at, stripe_customer_id, has_subscription
       FROM get_platform_billing($1)`,
    [tenantId],
  );
  return res.rows[0] ?? null;
}

// GET /api/admin/billing
export async function getBilling(req, res, next) {
  try {
    const row = await readBilling(req.db, req.tenant.id);
    if (!row) return res.status(404).json({ error: 'tenant not found' });

    res.json({
      status: row.status,
      trial_ends_at: row.trial_ends_at,
      has_subscription: row.has_subscription,
      billing_configured: billingConfigured(),
      monthly_price_cents: monthlyPriceCents(),
    });
  } catch (err) {
    next(err);
  }
}

const checkoutSchema = z.object({
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

// POST /api/admin/billing/checkout — start (or restart) the platform
// subscription via Stripe Checkout on the platform account.
export async function startBillingCheckout(req, res, next) {
  try {
    if (!billingConfigured()) {
      return res
        .status(503)
        .json({ error: 'platform billing is not configured' });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { success_url, cancel_url } = parsed.data;
    const { tenant, db, user } = req;

    const billing = await readBilling(db, tenant.id);
    if (!billing) return res.status(404).json({ error: 'tenant not found' });
    if (billing.status === 'active' && billing.has_subscription) {
      return res
        .status(409)
        .json({ error: 'tenant already has an active subscription' });
    }

    // Reuse the platform customer across checkouts; create on first
    // use. set_platform_customer is write-once, so a concurrent first
    // checkout loses the race loudly (23505/exception → 500 → retry
    // succeeds with the stored id) instead of minting duplicates
    // silently.
    //
    // Stripe call inside the request transaction matches the
    // pre-existing checkout convention (memberSubscriptions, packs).
    let customerId = billing.stripe_customer_id;
    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: user.email,
        name: tenant.name,
        metadata: { courtside_tenant_id: tenant.id },
      });
      customerId = customer.id;
      await db.query(`SELECT set_platform_customer($1, $2)`, [
        tenant.id,
        customerId,
      ]);
    }

    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.PLATFORM_PRICE_ID, quantity: 1 }],
      success_url,
      cancel_url,
      metadata: {
        courtside_platform: '1',
        tenant_id: tenant.id,
      },
      subscription_data: {
        metadata: {
          courtside_platform: '1',
          tenant_id: tenant.id,
        },
      },
    });

    res.status(201).json({ checkout_url: session.url });
  } catch (err) {
    next(err);
  }
}

const portalSchema = z.object({
  return_url: z.string().url(),
});

// POST /api/admin/billing/portal — Stripe Billing Portal for the
// platform customer (update card, cancel, download invoices).
export async function openBillingPortal(req, res, next) {
  try {
    const parsed = portalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const billing = await readBilling(req.db, req.tenant.id);
    if (!billing?.stripe_customer_id) {
      return res
        .status(409)
        .json({ error: 'no billing account yet — subscribe first' });
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: parsed.data.return_url,
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    next(err);
  }
}
