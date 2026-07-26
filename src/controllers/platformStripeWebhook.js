// Platform Stripe webhook — events from the PLATFORM's own Stripe
// account (tenants paying Courtside). Distinct from
// stripeWebhook.js, which receives Connect events from tenants'
// connected accounts:
//
//   * Separate Stripe webhook endpoint in the dashboard → separate
//     signing secret (PLATFORM_STRIPE_WEBHOOK_SECRET).
//   * Events carry no event.account — they're ours. Tenant context
//     bootstraps from lookup_tenant_by_platform_customer (migration
//     025) instead of lookup_tenant_by_stripe_account.
//
// Mounted at POST /webhooks/stripe-platform in app.js BEFORE
// express.json() with express.raw — CLAUDE.md gotcha #5 applies
// identically here.
//
// Dedup shares the global stripe_webhook_events table with the
// Connect webhook (event ids are globally unique) including its
// release-on-failure semantics: the dedup row is deleted when a
// handler throws so Stripe's retry re-drives the work.

import Stripe from 'stripe';

import { pool } from '../db/pool.js';
import {
  withTenantContextById,
  loadTenantEmailContext,
} from './stripeWebhook.js';
import { sendPlatformPaymentFailed } from '../services/email.js';

export async function handlePlatformStripeWebhook(req, res, next) {
  try {
    if (!process.env.PLATFORM_STRIPE_WEBHOOK_SECRET) {
      console.error('PLATFORM_STRIPE_WEBHOOK_SECRET not configured');
      return res.status(503).json({ error: 'webhook not configured' });
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).json({ error: 'missing stripe-signature header' });
    }

    let event;
    try {
      // Purely local HMAC math — same static verify as the Connect
      // webhook, different secret.
      event = Stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.PLATFORM_STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return res.status(400).json({ error: 'invalid signature' });
    }

    const dedupRes = await pool.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, account_id)
       VALUES ($1, $2, NULL)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type],
    );
    if (dedupRes.rows.length === 0) {
      return res
        .status(200)
        .json({ received: true, type: event.type, deduped: true });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handlePlatformCheckoutCompleted(event);
          break;
        case 'customer.subscription.updated':
          await handlePlatformSubscriptionChange(event);
          break;
        case 'customer.subscription.deleted':
          await handlePlatformSubscriptionChange(event, {
            forceStatus: 'cancelled',
          });
          break;
        case 'invoice.payment_failed':
          await handlePlatformPaymentFailed(event);
          break;
        default:
          break; // quietly ignore types we haven't wired up
      }
    } catch (handlerErr) {
      await pool
        .query(`DELETE FROM stripe_webhook_events WHERE event_id = $1`, [
          event.id,
        ])
        .catch((delErr) =>
          console.error(
            `platform webhook ${event.id}: handler failed AND dedup row could not be released — event will not be retried:`,
            delErr,
          ),
        );
      throw handlerErr;
    }

    res.status(200).json({ received: true, type: event.type });
  } catch (err) {
    next(err);
  }
}

// Map a Stripe subscription status onto tenants.
// platform_subscription_status ('trial','active','past_due',
// 'cancelled','suspended'). Returns null for statuses we deliberately
// don't act on (incomplete = checkout still in flight).
export function mapPlatformStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    case 'paused':
      return 'suspended';
    case 'incomplete':
      return null;
    default:
      console.warn(`unknown platform subscription status: ${stripeStatus}`);
      return null;
  }
}

async function resolveTenantFromPlatformCustomer(customerId, eventType) {
  if (!customerId) return null;
  const r = await pool.query(
    `SELECT lookup_tenant_by_platform_customer($1) AS tenant_id`,
    [customerId],
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    console.warn(
      `${eventType}: no tenant for platform customer ${customerId}; skipping`,
    );
  }
  return tenantId;
}

// checkout.session.completed — the tenant just subscribed. Link the
// subscription id and flip status to active.
async function handlePlatformCheckoutCompleted(event) {
  const session = event.data?.object;
  if (session?.mode !== 'subscription') return;
  if (session?.metadata?.courtside_platform !== '1') return;
  if (!session.subscription) return;

  // Resolve by customer, then cross-check the metadata tenant_id —
  // both were set by us at session creation, so a mismatch means
  // something is deeply wrong (or forged); skip loudly.
  const tenantId = await resolveTenantFromPlatformCustomer(
    session.customer,
    event.type,
  );
  if (!tenantId) return;
  if (session.metadata?.tenant_id && session.metadata.tenant_id !== tenantId) {
    console.error(
      `platform checkout ${session.id}: metadata tenant ${session.metadata.tenant_id} != customer's tenant ${tenantId}; skipping`,
    );
    return;
  }

  await withTenantContextById(tenantId, async (client) => {
    await client.query(`SELECT set_platform_subscription($1, $2, 'active')`, [
      tenantId,
      session.subscription,
    ]);
  });
}

// customer.subscription.updated / .deleted — keep
// platform_subscription_status in sync with Stripe.
async function handlePlatformSubscriptionChange(event, { forceStatus } = {}) {
  const sub = event.data?.object;
  if (!sub?.id) return;
  if (sub.metadata?.courtside_platform !== '1') return;

  const status = forceStatus ?? mapPlatformStatus(sub.status);
  if (!status) return;

  const tenantId = await resolveTenantFromPlatformCustomer(
    sub.customer,
    event.type,
  );
  if (!tenantId) return;

  await withTenantContextById(tenantId, async (client) => {
    await client.query(`SELECT set_platform_subscription($1, $2, $3)`, [
      tenantId,
      sub.id,
      status,
    ]);
  });
}

// invoice.payment_failed — the status flip to past_due arrives via
// customer.subscription.updated; this handler only notifies. Sent to
// the tenant's owner admin (falling back to any admin) — NOT the
// tenant's reply_to_email, which is their member-facing address.
async function handlePlatformPaymentFailed(event) {
  const invoice = event.data?.object;
  const tenantId = await resolveTenantFromPlatformCustomer(
    invoice?.customer,
    event.type,
  );
  if (!tenantId) return;

  const recipient = await withTenantContextById(tenantId, async (client) => {
    const r = await client.query(
      `SELECT u.email
         FROM tenant_admins ta
         JOIN users u ON u.tenant_id = ta.tenant_id AND u.id = ta.user_id
        WHERE ta.tenant_id = $1
        ORDER BY (ta.role = 'owner') DESC, ta.created_at ASC
        LIMIT 1`,
      [tenantId],
    );
    return r.rows[0]?.email ?? null;
  });
  if (!recipient) return;

  const tenant = await loadTenantEmailContext(tenantId);
  if (!tenant) return;

  // Post-COMMIT fire-and-forget, matching every other webhook email.
  // TODO: outbox.
  sendPlatformPaymentFailed({ tenant, to: recipient }).catch((err) =>
    console.error('platform payment-failed email:', err),
  );
}
