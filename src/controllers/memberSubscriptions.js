// Member subscriptions — Phase 5 slice 4a.
//
// Two endpoints, both authenticated as a member:
//
//   GET  /api/me/subscriptions
//     Returns the member's current non-terminal subscription (if any)
//     joined with the active plan period and plan details. Used by
//     the member dashboard to show "you're subscribed to Pro" or
//     "you have no active subscription".
//
//   POST /api/me/subscriptions/checkout
//     Creates a Stripe Checkout Session in subscription mode on the
//     tenant's connected account. Returns the hosted URL. The
//     post-checkout INSERT into `subscriptions` happens in the
//     webhook handler (checkout.session.completed) — we don't insert
//     a `pending` row here because the GiST/partial-unique check
//     `subscriptions_one_active_per_member` would block re-checkout
//     if the member abandoned the Stripe-hosted page.
//
// Customer reuse: a member who's had a previous (now-cancelled)
// subscription has a stripe_customer_id on file. We reuse it instead
// of creating a duplicate. New members get a fresh customer on the
// connected account.

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';

// GET /api/me/plans — member-readable list of plans they can subscribe
// to. Filters: active=true AND stripe_price_id IS NOT NULL (only synced
// plans can actually accept a checkout).
export async function listAvailablePlans(req, res, next) {
  try {
    const { tenant, db } = req;
    const r = await db.query(
      `SELECT id, name, description, monthly_price_cents, credits_per_week,
              allowed_categories::text[] AS allowed_categories,
              display_order
         FROM plans
        WHERE tenant_id = $1
          AND active = true
          AND stripe_price_id IS NOT NULL
        ORDER BY display_order ASC, monthly_price_cents ASC`,
      [tenant.id],
    );
    res.json({ plans: r.rows });
  } catch (err) {
    next(err);
  }
}

export async function getMySubscription(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member' });
    }
    const { tenant, db, user } = req;

    // Pull the (at most one) non-terminal subscription + its current
    // plan. The partial unique index guarantees ≤1 row matches.
    const r = await db.query(
      `SELECT s.id, s.status, s.stripe_subscription_id, s.stripe_customer_id,
              s.current_period_start, s.current_period_end,
              s.cancel_at_period_end, s.scheduled_deactivation_at,
              s.activated_at, s.ended_at, s.created_at,
              p.id AS plan_id,
              p.name AS plan_name,
              p.monthly_price_cents,
              p.credits_per_week,
              p.allowed_categories::text[] AS plan_allowed_categories
         FROM subscriptions s
         LEFT JOIN subscription_plan_periods spp
           ON spp.tenant_id = s.tenant_id
          AND spp.subscription_id = s.id
          AND spp.ended_at IS NULL
         LEFT JOIN plans p
           ON p.tenant_id = spp.tenant_id
          AND p.id = spp.plan_id
        WHERE s.tenant_id = $1
          AND s.member_id = $2
          AND s.status IN ('pending', 'active', 'past_due', 'incomplete')
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [tenant.id, user.member_id],
    );
    res.json({ subscription: r.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
}

const checkoutSchema = z.object({
  plan_id: z.string().uuid(),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

export async function startSubscriptionCheckout(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member' });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { plan_id, success_url, cancel_url } = parsed.data;
    const { tenant, db, user } = req;

    // 1. Member must not already have a non-terminal subscription.
    const existing = await db.query(
      `SELECT 1 FROM subscriptions
        WHERE tenant_id = $1 AND member_id = $2
          AND status IN ('pending', 'active', 'past_due', 'incomplete')
        LIMIT 1`,
      [tenant.id, user.member_id],
    );
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'member already has an active subscription' });
    }

    // 2. Plan must be active + synced to Stripe.
    const planRes = await db.query(
      `SELECT id, name, stripe_price_id, active
         FROM plans WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, plan_id],
    );
    if (planRes.rows.length === 0) {
      return res.status(404).json({ error: 'plan not found' });
    }
    const plan = planRes.rows[0];
    if (!plan.active) {
      return res.status(409).json({ error: 'plan is inactive' });
    }
    if (!plan.stripe_price_id) {
      return res
        .status(409)
        .json({ error: 'plan is not synced to Stripe; admin must sync first' });
    }

    // 3. Connection must be charges-enabled.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0 || !connRes.rows[0].charges_enabled) {
      return res
        .status(409)
        .json({ error: 'tenant not yet ready to accept payments' });
    }
    const conn = connRes.rows[0];

    // 4. Look up an existing stripe_customer_id from a prior
    //    subscription (cancelled etc.) to reuse. Falls back to
    //    creating a new customer on the connected account.
    const memberRes = await db.query(
      `SELECT email, first_name, last_name FROM members
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, user.member_id],
    );
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'member record missing' });
    }
    const member = memberRes.rows[0];

    const priorCustomerRes = await db.query(
      `SELECT stripe_customer_id FROM subscriptions
        WHERE tenant_id = $1 AND member_id = $2
          AND stripe_customer_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [tenant.id, user.member_id],
    );

    const stripe = getStripe();
    const opts = { stripeAccount: conn.stripe_account_id };

    let stripe_customer_id = priorCustomerRes.rows[0]?.stripe_customer_id;
    try {
      if (!stripe_customer_id) {
        const customer = await stripe.customers.create(
          {
            email: member.email,
            name: `${member.first_name} ${member.last_name}`,
            metadata: {
              courtside_member_id: user.member_id,
              courtside_tenant_id: tenant.id,
            },
          },
          opts,
        );
        stripe_customer_id = customer.id;
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: stripe_customer_id,
          line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
          success_url,
          cancel_url,
          // Metadata is the bridge between Stripe-issued IDs and our
          // domain. The webhook reads these to know which member +
          // plan to write into the subscriptions table.
          metadata: {
            courtside_tenant_id: tenant.id,
            courtside_member_id: user.member_id,
            courtside_plan_id: plan.id,
          },
        },
        opts,
      );

      res.status(201).json({
        url: session.url,
        session_id: session.id,
      });
    } catch (err) {
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }
  } catch (err) {
    next(err);
  }
}
