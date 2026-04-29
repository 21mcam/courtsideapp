// Stripe webhook handler — Phase 5 slice 2.
//
// Mounted at POST /webhooks/stripe in app.js BEFORE express.json()
// using express.raw({ type: 'application/json' }) so the signature
// verification sees the exact bytes Stripe sent. Reversing the
// mount order breaks signature verification silently — gotcha #5
// in CLAUDE.md.
//
// Stripe POSTs from api.stripe.com, NOT a tenant subdomain. Tenant
// context bootstraps from the event payload via the SECURITY DEFINER
// function lookup_tenant_by_stripe_account(account_id) (migration
// 015), then the rest of the handler runs in tenant context just
// like a normal request.
//
// Slice 2 only handles `account.updated` (Connect onboarding state
// changes). Future slices add invoice.payment_succeeded,
// customer.subscription.*, etc. The dispatcher tolerates unknown
// types — we 200 silently rather than 4xx, otherwise Stripe's
// retry policy hammers us forever.

import { getStripe } from '../services/stripe.js';
import { pool } from '../db/pool.js';

export async function handleStripeWebhook(req, res, next) {
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      // Don't 500 — Stripe will retry and fill the dashboard with
      // failures. Log + 503 lets the operator see it.
      console.error('STRIPE_WEBHOOK_SECRET not configured');
      return res.status(503).json({ error: 'webhook not configured' });
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).json({ error: 'missing stripe-signature header' });
    }

    let event;
    try {
      event = getStripe().webhooks.constructEvent(
        req.body, // express.raw gives us a Buffer of the exact bytes
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      // Bad signature, expired timestamp, malformed payload, etc.
      // 400 tells Stripe to give up retrying — the secret or payload
      // is wrong, retrying won't fix it.
      return res
        .status(400)
        .json({ error: `webhook signature verification failed: ${err.message}` });
    }

    // Connect events have an `account` field at the top level
    // identifying which connected account fired them. Account
    // lifecycle events are scoped to the platform itself in some
    // cases — handle defensively.
    const accountId = event.account ?? event.data?.object?.id;
    if (!accountId) {
      // Nothing to scope to. Acknowledge so Stripe doesn't retry,
      // but log for the operator.
      console.warn(`stripe webhook ${event.type}: no account id; skipping`);
      return res.status(200).json({ received: true, skipped: 'no account scope' });
    }

    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event, accountId);
        break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event, accountId);
        break;
      default:
        // Quietly ignore. This is a well-trodden Stripe webhook
        // pattern — the same endpoint handles every subscription,
        // invoice, payment, account event Stripe might send. We
        // only react to types we've explicitly wired up.
        break;
    }

    res.status(200).json({ received: true, type: event.type });
  } catch (err) {
    next(err);
  }
}

// checkout.session.completed (mode='subscription') — Phase 5 slice 4a.
//
// Member finished Stripe-hosted Checkout; Stripe has created the
// subscription on the connected account. Our job here:
//   1. Resolve tenant from event.account
//   2. Resolve member + plan from session.metadata (we stashed those
//      when creating the session)
//   3. INSERT subscriptions (status='active') + subscription_plan_periods
//      + grant initial credits via apply_credit_change(reason='weekly_reset')
//
// Idempotency: the subscriptions_stripe_unique partial unique index
// on stripe_subscription_id catches duplicate deliveries — second
// INSERT throws 23505 and we early-return. We DON'T grant credits
// twice in that case.
async function handleCheckoutSessionCompleted(event, accountId) {
  const session = event.data?.object;
  if (!session) {
    console.warn('checkout.session.completed: no data.object payload');
    return;
  }
  if (session.mode !== 'subscription') {
    // mode='payment' is for one-off PaymentIntents (slice 7); not
    // relevant here.
    return;
  }
  if (!session.subscription) {
    console.warn('checkout.session.completed: no subscription on session');
    return;
  }

  const md = session.metadata ?? {};
  const tenantIdFromMd = md.courtside_tenant_id;
  const memberId = md.courtside_member_id;
  const planId = md.courtside_plan_id;
  if (!tenantIdFromMd || !memberId || !planId) {
    console.warn(
      'checkout.session.completed: missing courtside metadata; skipping',
      { has_tenant: !!tenantIdFromMd, has_member: !!memberId, has_plan: !!planId },
    );
    return;
  }

  // Cross-check the tenant from event.account against metadata. If
  // they disagree, something is very wrong — bail loudly.
  const lookupRes = await pool.query(
    `SELECT lookup_tenant_by_stripe_account($1) AS tenant_id`,
    [accountId],
  );
  const tenantIdFromAcct = lookupRes.rows[0]?.tenant_id;
  if (!tenantIdFromAcct) {
    console.warn(
      `checkout.session.completed: no stripe_connections row for ${accountId}; skipping`,
    );
    return;
  }
  if (tenantIdFromAcct !== tenantIdFromMd) {
    console.error(
      `checkout.session.completed: tenant mismatch (account=${tenantIdFromAcct}, metadata=${tenantIdFromMd})`,
    );
    return;
  }

  const tenantId = tenantIdFromAcct;

  // All work below runs inside one transaction with the tenant GUC
  // set, so RLS applies + apply_credit_change's GUC check passes.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId],
    );

    // Look up plan to know credits_per_week + name.
    const planRes = await client.query(
      `SELECT id, credits_per_week FROM plans WHERE tenant_id = $1 AND id = $2`,
      [tenantId, planId],
    );
    if (planRes.rows.length === 0) {
      // Plan deleted between checkout and webhook? Bail; admin needs
      // to investigate manually.
      console.warn(
        `checkout.session.completed: plan ${planId} not found; skipping`,
      );
      await client.query('ROLLBACK');
      return;
    }
    const plan = planRes.rows[0];

    // Insert the subscription. The partial unique index
    // subscriptions_stripe_unique catches duplicate webhook delivery
    // (idempotent). subscriptions_one_active_per_member ALSO catches
    // a buggy member-already-has-subscription state — we treat both
    // the same: log + skip the rest.
    let subscriptionId;
    try {
      const subRes = await client.query(
        `INSERT INTO subscriptions (
           tenant_id, member_id, status,
           stripe_subscription_id, stripe_customer_id,
           current_period_start, current_period_end,
           cancel_at_period_end, activated_at
         ) VALUES (
           $1, $2, 'active', $3, $4, $5, $6, $7, now()
         )
         RETURNING id`,
        [
          tenantId,
          memberId,
          session.subscription,
          session.customer,
          // Stripe sends period bounds at the subscription object,
          // not on the session. For slice 4a we approximate: now +
          // 30 days. Slice 4b's invoice.payment_succeeded handler
          // will reconcile real values from the subscription object.
          new Date(),
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          false,
        ],
      );
      subscriptionId = subRes.rows[0].id;
    } catch (err) {
      if (err.code === '23505') {
        // Duplicate delivery (or already-subscribed conflict). Either
        // way: we're done, no credit grant.
        console.warn(
          `checkout.session.completed: duplicate or conflicting subscription; skipping`,
          { stripe_subscription_id: session.subscription },
        );
        await client.query('ROLLBACK');
        return;
      }
      throw err;
    }

    // Open a plan period for this subscription.
    await client.query(
      `INSERT INTO subscription_plan_periods (
         tenant_id, subscription_id, plan_id, started_at
       ) VALUES ($1, $2, $3, now())`,
      [tenantId, subscriptionId, plan.id],
    );

    // Grant initial week of credits if the plan has any. Reason
    // 'weekly_reset' bumps last_reset_at so the (future) weekly
    // resetter knows when this member's clock starts. Grant uses
    // member.user_id as granted_by — but webhooks don't have a
    // user_id, so use NULL. apply_credit_change accepts NULL there.
    if (plan.credits_per_week > 0) {
      await client.query(
        `SELECT entry_id FROM apply_credit_change(
           $1, $2, $3, 'weekly_reset', NULL, NULL, NULL, NULL
         )`,
        [tenantId, memberId, plan.credits_per_week],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Bootstrap tenant context from event.account, then run the UPDATE
// inside that scope so RLS applies. Connection lifecycle mirrors
// withTenantContext: BEGIN, set GUC, do work, COMMIT/ROLLBACK.
async function handleAccountUpdated(event, accountId) {
  const account = event.data?.object;
  if (!account) {
    console.warn('account.updated: no data.object payload');
    return;
  }

  // Look up tenant via SECURITY DEFINER function. Returns NULL if
  // we don't know about this account — could be a webhook from a
  // platform-level event (no specific tenant) or for an account
  // that was created before our DB row was inserted (race window
  // around onboarding).
  const lookupRes = await pool.query(
    `SELECT lookup_tenant_by_stripe_account($1) AS tenant_id`,
    [accountId],
  );
  const tenantId = lookupRes.rows[0]?.tenant_id;
  if (!tenantId) {
    console.warn(
      `account.updated: no stripe_connections row for ${accountId}; skipping`,
    );
    return;
  }

  // Run the reconcile inside a tenant-scoped transaction so RLS
  // applies on stripe_connections.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId],
    );

    const fully = !!account.details_submitted && !!account.charges_enabled;
    await client.query(
      `UPDATE stripe_connections
          SET details_submitted = $1,
              charges_enabled    = $2,
              payouts_enabled    = $3,
              fully_onboarded_at = COALESCE(
                fully_onboarded_at,
                CASE WHEN $4 THEN now() ELSE NULL END
              )
        WHERE tenant_id = $5`,
      [
        !!account.details_submitted,
        !!account.charges_enabled,
        !!account.payouts_enabled,
        fully,
        tenantId,
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
