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
import {
  sendBookingConfirmation,
  sendMemberWelcome,
} from '../services/email.js';

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

    // Dedup: INSERT the event id; if 0 rows insert, we've already
    // processed this delivery. Some events are structurally
    // idempotent (account.updated just sets current state) and
    // would survive a duplicate without harm — but applying the
    // dedup uniformly means handlers don't have to think about it.
    const dedupRes = await pool.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, account_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type, event.account ?? null],
    );
    if (dedupRes.rows.length === 0) {
      return res
        .status(200)
        .json({ received: true, type: event.type, deduped: true });
    }

    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event, accountId);
        break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event, accountId);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event, accountId);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event, accountId);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event, accountId);
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

// Map Stripe subscription status → our internal status enum.
// Stripe statuses: incomplete, incomplete_expired, trialing, active,
// past_due, canceled, unpaid, paused. We collapse the Stripe space
// into our 5-state set documented in CLAUDE.md.
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing': // treat trial as active for booking access
      return 'active';
    case 'past_due':
    case 'unpaid':   // Stripe still trying to recover; treat as past_due
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    case 'incomplete':
    case 'paused':   // Stripe-paused subs are inactive but recoverable
      return 'incomplete';
    default:
      // Conservative fallback — keep the row but flag for ops.
      console.warn(`unknown stripe subscription status: ${stripeStatus}`);
      return 'incomplete';
  }
}

// Helper: convert Stripe Unix timestamp (seconds) to JS Date or null.
function tsOrNull(s) {
  if (s == null) return null;
  return new Date(s * 1000);
}

// Run a callback inside a transaction with the tenant GUC set. Used
// by webhook handlers that bootstrapped tenant context from
// event.account.
async function withTenantContextById(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Load the tenant fields the email service needs (name, subdomain,
// timezone, theme_accent, reply_to_email). Webhooks have no
// req.tenant — Stripe POSTs from api.stripe.com — so we read the
// unprivileged tenant_lookup view directly via the pool, same as
// resolveTenant does for subdomains. Returns null if the tenant is
// gone (nothing to email about).
async function loadTenantEmailContext(tenantId) {
  const r = await pool.query(`SELECT * FROM tenant_lookup WHERE id = $1`, [
    tenantId,
  ]);
  return r.rows[0] ?? null;
}

// Resolve tenant from event.account; returns null + logs if there's
// no row (Stripe sent us an event for an account we don't know).
async function resolveTenantFromAccount(accountId, eventType) {
  const r = await pool.query(
    `SELECT lookup_tenant_by_stripe_account($1) AS tenant_id`,
    [accountId],
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    console.warn(
      `${eventType}: no stripe_connections row for ${accountId}; skipping`,
    );
  }
  return tenantId;
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
  if (session.mode === 'payment') {
    // Walk-in / one-off booking payment (slice 7).
    return handleCustomerBookingPaid(session, accountId);
  }
  if (session.mode !== 'subscription') {
    // Other modes (setup, etc.) we don't currently use.
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
  // `welcome` is populated inside the tx when this is the member's
  // FIRST subscription; the email itself goes out after COMMIT.
  let welcome = null;
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

    // Welcome email gate: first subscription ever for this member
    // (history rows count — an upgrade/resubscribe isn't a welcome).
    // Checked BEFORE our INSERT adds a row. DB reads only; the send
    // happens post-commit.
    const priorSubRes = await client.query(
      `SELECT 1 FROM subscriptions
        WHERE tenant_id = $1 AND member_id = $2 LIMIT 1`,
      [tenantId, memberId],
    );
    if (priorSubRes.rows.length === 0) {
      const contactRes = await client.query(
        `SELECT email, first_name FROM members
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, memberId],
      );
      if (contactRes.rows[0]?.email) {
        welcome = contactRes.rows[0];
      }
    }

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

    // Grant the initial week of credits if the plan has any. Reason
    // 'weekly_reset' bumps last_reset_at so this reads as the
    // member's first weekly allotment; every subsequent replenishment
    // comes from run_weekly_credit_resets() (Monday 00:00
    // tenant-local), NOT from invoice renewals. Grant uses
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

  // Post-commit: welcome the member on their first subscription.
  // Fire-and-forget — a lost welcome email must never fail the
  // webhook (Stripe would retry and the dedup log blocks the retry
  // from re-running the handler anyway).
  // TODO: outbox for reliability-critical delivery.
  if (welcome) {
    const tenantCtx = await loadTenantEmailContext(tenantId);
    if (tenantCtx) {
      sendMemberWelcome({
        tenant: tenantCtx,
        to: welcome.email,
        firstName: welcome.first_name,
      }).catch((err) =>
        console.error('[email] member welcome send failed:', err),
      );
    }
  }
}

// checkout.session.completed (mode='payment') — Phase 5 slice 7.
//
// Walk-in customer paid for their booking on Stripe-hosted Checkout.
// Flip the booking from 'pending_payment' to 'confirmed' + 'paid',
// stamp the payment_intent id and amount_paid_cents.
//
// Status guard: WHERE status = 'pending_payment' means a booking
// that was cancelled in the meantime (admin override, hold expiry
// janitor) won't get re-confirmed. If we paid an expired booking,
// we'll need to refund — slice 6 / future hardening.
async function handleCustomerBookingPaid(session, accountId) {
  const md = session.metadata ?? {};
  const tenantIdFromMd = md.courtside_tenant_id;
  const bookingId = md.courtside_booking_id;
  if (!tenantIdFromMd || !bookingId) {
    console.warn(
      'checkout.session.completed (payment): missing courtside metadata; skipping',
    );
    return;
  }

  const tenantIdFromAcct = await resolveTenantFromAccount(
    accountId,
    'checkout.session.completed (payment)',
  );
  if (!tenantIdFromAcct) return;
  if (tenantIdFromAcct !== tenantIdFromMd) {
    console.error(
      `checkout.session.completed (payment): tenant mismatch ` +
        `(account=${tenantIdFromAcct}, metadata=${tenantIdFromMd})`,
    );
    return;
  }

  const confirmed = await withTenantContextById(
    tenantIdFromAcct,
    async (client) => {
      const r = await client.query(
        `UPDATE bookings
            SET status = 'confirmed',
                payment_status = 'paid',
                amount_paid_cents = $1,
                stripe_payment_intent_id = $2
          WHERE tenant_id = $3
            AND id = $4
            AND status = 'pending_payment'
          RETURNING id, offering_id, resource_id, start_time,
                    customer_first_name, customer_email,
                    amount_paid_cents`,
        [
          session.amount_total ?? 0,
          session.payment_intent ?? null,
          tenantIdFromAcct,
          bookingId,
        ],
      );
      if (r.rows.length === 0) {
        // Booking moved out of pending_payment between our INSERT and
        // the payment landing. Most likely: admin cancelled, or hold
        // expired and a janitor closed it. Slice 6 / hardening will
        // add a refund flow for this edge.
        console.warn(
          `checkout.session.completed (payment): booking ${bookingId} not in pending_payment state; payment held without confirmation`,
        );
        return null;
      }
      const booking = r.rows[0];

      // Names for the confirmation email — still DB work, still
      // inside the tx.
      const namesRes = await client.query(
        `SELECT o.name AS offering_name, r.name AS resource_name
           FROM offerings o
           JOIN resources r
             ON r.tenant_id = o.tenant_id AND r.id = $3
          WHERE o.tenant_id = $1 AND o.id = $2`,
        [tenantIdFromAcct, booking.offering_id, booking.resource_id],
      );
      return { ...booking, ...(namesRes.rows[0] ?? {}) };
    },
  );

  // Post-commit: confirm to the walk-in customer. Fire-and-forget —
  // email failure must never fail the webhook.
  // TODO: outbox for reliability-critical delivery.
  if (confirmed?.customer_email) {
    const tenantCtx = await loadTenantEmailContext(tenantIdFromAcct);
    if (tenantCtx) {
      sendBookingConfirmation({
        tenant: tenantCtx,
        to: confirmed.customer_email,
        recipientName: confirmed.customer_first_name,
        offeringName: confirmed.offering_name,
        resourceName: confirmed.resource_name,
        startTime: confirmed.start_time,
        amountPaidCents: confirmed.amount_paid_cents,
      }).catch((err) =>
        console.error('[email] walk-in booking confirmation send failed:', err),
      );
    }
  }
}

// customer.subscription.updated — Phase 5 slice 4b.
//
// Status changes (active → past_due, etc.) and field updates
// (cancel_at_period_end toggle, period bounds advance) come through
// here. We reconcile our row with whatever Stripe says.
//
// Status mapping is in mapStripeStatus(). Some Stripe states (paused,
// unpaid) don't have direct analogues in our 5-state set — see the
// mapper for the chosen translation.
async function handleSubscriptionUpdated(event, accountId) {
  const sub = event.data?.object;
  if (!sub?.id) return;

  const tenantId = await resolveTenantFromAccount(accountId, event.type);
  if (!tenantId) return;

  const internalStatus = mapStripeStatus(sub.status);
  const periodStart = tsOrNull(sub.current_period_start);
  const periodEnd = tsOrNull(sub.current_period_end);
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

  await withTenantContextById(tenantId, async (client) => {
    // ended_at is set only on terminal transitions; this handler
    // covers active/past_due/incomplete moves which DO NOT close
    // the row. customer.subscription.deleted is the cancel handler.
    const r = await client.query(
      `UPDATE subscriptions
          SET status = $1,
              current_period_start = COALESCE($2, current_period_start),
              current_period_end   = COALESCE($3, current_period_end),
              cancel_at_period_end = $4,
              activated_at = COALESCE(activated_at,
                CASE WHEN $1 = 'active' THEN now() ELSE NULL END)
        WHERE tenant_id = $5 AND stripe_subscription_id = $6
        RETURNING id`,
      [
        internalStatus,
        periodStart,
        periodEnd,
        cancelAtPeriodEnd,
        tenantId,
        sub.id,
      ],
    );
    if (r.rows.length === 0) {
      console.warn(
        `customer.subscription.updated: no subscription row for stripe id ${sub.id}`,
      );
    }
  });
}

// customer.subscription.deleted — Phase 5 slice 4b.
//
// Terminal cancel. Flip status to 'cancelled', stamp ended_at, close
// the active subscription_plan_periods row. Does NOT touch credits
// (member keeps any unused credits per business decision; revisit if
// that changes).
async function handleSubscriptionDeleted(event, accountId) {
  const sub = event.data?.object;
  if (!sub?.id) return;

  const tenantId = await resolveTenantFromAccount(accountId, event.type);
  if (!tenantId) return;

  await withTenantContextById(tenantId, async (client) => {
    const r = await client.query(
      `UPDATE subscriptions
          SET status = 'cancelled',
              ended_at = now()
        WHERE tenant_id = $1
          AND stripe_subscription_id = $2
          AND status <> 'cancelled'
        RETURNING id`,
      [tenantId, sub.id],
    );
    if (r.rows.length === 0) {
      console.warn(
        `customer.subscription.deleted: no active subscription for stripe id ${sub.id}`,
      );
      return;
    }
    const subscriptionId = r.rows[0].id;

    // Close the active plan period (ended_at IS NULL). The period
    // record stays for billing-history audits.
    await client.query(
      `UPDATE subscription_plan_periods
          SET ended_at = now()
        WHERE tenant_id = $1
          AND subscription_id = $2
          AND ended_at IS NULL`,
      [tenantId, subscriptionId],
    );
  });
}

// invoice.payment_succeeded — Phase 5 slice 4b.
//
// Stripe fires this for every successful invoice. We reconcile
// period bounds from it and flip past_due subscriptions back to
// active. We do NOT grant credits here — not for
// billing_reason='subscription_create' (the checkout.session.
// completed handler grants the first week) and not for
// 'subscription_cycle' either: credit replenishment is owned by the
// weekly reset (run_weekly_credit_resets(), migration 022), which
// SETs each active subscriber's balance to their plan's
// credits_per_week every Monday 00:00 tenant-local. Monthly renewal
// grants would double-pay and drift off the weekly cadence.
async function handleInvoicePaymentSucceeded(event, accountId) {
  const invoice = event.data?.object;
  if (!invoice) return;

  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return; // one-off invoices don't apply

  const tenantId = await resolveTenantFromAccount(accountId, event.type);
  if (!tenantId) return;

  await withTenantContextById(tenantId, async (client) => {
    const subRes = await client.query(
      `SELECT id AS subscription_id
         FROM subscriptions
        WHERE tenant_id = $1
          AND stripe_subscription_id = $2`,
      [tenantId, subscriptionId],
    );
    if (subRes.rows.length === 0) {
      console.warn(
        `invoice.payment_succeeded: no subscription for stripe id ${subscriptionId}`,
      );
      return;
    }
    const row = subRes.rows[0];

    // Reconcile period bounds + status from the invoice's lines (the
    // cleanest source). The invoice has period.start/period.end as
    // Unix timestamps for subscription_cycle invoices; for
    // subscription_create those reflect the first period as well.
    const periodStart = tsOrNull(invoice.period_start);
    const periodEnd = tsOrNull(invoice.period_end);
    if (periodStart && periodEnd) {
      await client.query(
        `UPDATE subscriptions
            SET current_period_start = $1,
                current_period_end   = $2,
                status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END
          WHERE tenant_id = $3 AND id = $4`,
        [periodStart, periodEnd, tenantId, row.subscription_id],
      );
    }
  });
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
