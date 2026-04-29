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
