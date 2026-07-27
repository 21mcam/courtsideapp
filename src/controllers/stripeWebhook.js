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

import crypto from 'node:crypto';

import { getStripe } from '../services/stripe.js';
import { pool } from '../db/pool.js';
import {
  sendBookingConfirmation,
  sendMemberWelcome,
  sendPackReceipt,
  buildManageUrl,
} from '../services/email.js';
import { hashManageToken } from './customerBookings.js';

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
    //
    // The row commits BEFORE the handler runs (autocommit), so a
    // handler failure must NOT leave it behind: Stripe's retry would
    // be answered "deduped" without the work ever having happened —
    // for money paths (pack purchase → credit grant, walk-in payment
    // → confirmation) that's a permanently lost, paid-for effect. The
    // catch below deletes the dedup row on handler error so the retry
    // re-drives the handler; handlers stay individually idempotent
    // (unique indexes / status guards) for the partial-commit cases.
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

    try {
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
    } catch (handlerErr) {
      // Release the dedup slot so Stripe's retry re-runs the handler
      // (we're about to 500). If this DELETE itself fails the event
      // is stuck deduped — log loudly for manual reconciliation.
      await pool
        .query(`DELETE FROM stripe_webhook_events WHERE event_id = $1`, [
          event.id,
        ])
        .catch((delErr) =>
          console.error(
            `stripe webhook ${event.id}: handler failed AND dedup row could not be released — event will not be retried:`,
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
// Exported for the platform webhook (platformStripeWebhook.js), which
// bootstraps tenant context the same way from a different event source.
export async function withTenantContextById(tenantId, fn) {
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
export async function loadTenantEmailContext(tenantId) {
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
    // mode='payment' covers two flows — branch on the metadata type
    // stamped at session creation.
    if ((session.metadata ?? {}).courtside_type === 'pack_purchase') {
      // Member bought a one-time credit pack (credit-packs slice).
      return handlePackPurchasePaid(session, accountId);
    }
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
  // webhook (failing here would release the dedup row and make
  // Stripe redeliver an event whose DB work already committed).
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

// checkout.session.completed (mode='payment',
// metadata.courtside_type='pack_purchase') — credit-packs slice.
//
// Member paid for a one-time credit pack on Stripe-hosted Checkout.
// Grant the credits via apply_credit_change (reason 'pack_purchase'),
// which also increments credit_balances.purchased_credits so the
// weekly reset preserves them (draw-down order documented in
// CLAUDE.md).
//
// Credits granted = the snapshot taken at checkout time
// (metadata.courtside_credits) — an admin editing the pack while the
// member sits on the Stripe page can't change what they paid for.
// The pack row is only consulted for its name (ledger note + receipt
// copy) and may even be deactivated by now; the paid-for grant still
// lands.
//
// Idempotency: the stripe_webhook_events dedup at the dispatcher
// boundary — a SUCCESSFULLY handled event id never reaches this
// handler again, so credits can't be granted twice. If the grant
// transaction fails, the dispatcher releases the dedup row and
// Stripe's retry re-drives the grant (at-least-once, with the grant
// itself atomic in one transaction).
async function handlePackPurchasePaid(session, accountId) {
  const md = session.metadata ?? {};
  const tenantIdFromMd = md.courtside_tenant_id;
  const packId = md.courtside_pack_id;
  const memberId = md.courtside_member_id;
  const credits = Number.parseInt(md.courtside_credits, 10);
  if (
    !tenantIdFromMd ||
    !packId ||
    !memberId ||
    !Number.isInteger(credits) ||
    credits <= 0
  ) {
    console.warn(
      'checkout.session.completed (pack_purchase): missing/invalid courtside metadata; skipping',
      {
        has_tenant: !!tenantIdFromMd,
        has_pack: !!packId,
        has_member: !!memberId,
        credits: md.courtside_credits,
      },
    );
    return;
  }

  const tenantId = await resolveTenantFromAccount(
    accountId,
    'checkout.session.completed (pack_purchase)',
  );
  if (!tenantId) return;
  if (tenantId !== tenantIdFromMd) {
    console.error(
      `checkout.session.completed (pack_purchase): tenant mismatch ` +
        `(account=${tenantId}, metadata=${tenantIdFromMd})`,
    );
    return;
  }

  // Grant inside a tenant-scoped transaction (RLS +
  // apply_credit_change's GUC check). Receipt details come back out
  // for the post-commit email.
  const receipt = await withTenantContextById(tenantId, async (client) => {
    const memberRes = await client.query(
      `SELECT email, first_name FROM members
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, memberId],
    );
    if (memberRes.rows.length === 0) {
      // Member deleted between checkout and webhook. The money moved
      // on Stripe; ops must reconcile manually — log loudly.
      console.error(
        `checkout.session.completed (pack_purchase): member ${memberId} not found; payment held without credit grant`,
      );
      return null;
    }
    const member = memberRes.rows[0];

    const packRes = await client.query(
      `SELECT name FROM credit_packs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, packId],
    );
    const packName = packRes.rows[0]?.name ?? 'Credit pack';

    const grantRes = await client.query(
      `SELECT balance_after FROM apply_credit_change(
         $1, $2, $3, 'pack_purchase', $4, NULL, NULL, NULL
       )`,
      [tenantId, memberId, credits, `pack purchase: ${packName}`],
    );

    return {
      email: member.email,
      first_name: member.first_name,
      pack_name: packName,
      credits,
      amount_paid_cents: session.amount_total ?? 0,
      balance_after: grantRes.rows[0].balance_after,
    };
  });

  // Post-commit: purchase receipt. Fire-and-forget — a lost receipt
  // must never fail the webhook (failing here would release the
  // dedup row and a retry would re-grant already-granted credits).
  // TODO: outbox for reliability-critical delivery.
  if (receipt?.email) {
    const tenantCtx = await loadTenantEmailContext(tenantId);
    if (tenantCtx) {
      sendPackReceipt({
        tenant: tenantCtx,
        to: receipt.email,
        firstName: receipt.first_name,
        packName: receipt.pack_name,
        credits: receipt.credits,
        amountPaidCents: receipt.amount_paid_cents,
        balanceAfter: receipt.balance_after,
      }).catch((err) =>
        console.error('[email] pack receipt send failed:', err),
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
// janitor) won't get re-confirmed. When that happens the customer's
// money moved on Stripe for a booking we can't honor (the slot may
// already be re-booked) — refund the payment_intent immediately and
// stamp the refund on the booking row. A refund failure throws so
// the dispatcher releases the dedup row and Stripe's retry re-drives
// the refund.
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

  // Mint the no-login manage capability here — the only place it can
  // be born. Only confirmed+paid walk-ins ever get one (abandoned
  // pending_payment holds never do), and the raw token exists solely
  // in this webhook's memory until it's embedded in the confirmation
  // email; the DB stores only the sha256. The status='pending_payment'
  // guard on the UPDATE means a Stripe redelivery can't overwrite an
  // existing hash (zero rows → refund path, no token).
  const manageToken = crypto.randomBytes(32).toString('base64url');

  const confirmed = await withTenantContextById(
    tenantIdFromAcct,
    async (client) => {
      const r = await client.query(
        `UPDATE bookings
            SET status = 'confirmed',
                payment_status = 'paid',
                amount_paid_cents = $1,
                stripe_payment_intent_id = $2,
                manage_token_hash = $3
          WHERE tenant_id = $4
            AND id = $5
            AND status = 'pending_payment'
          RETURNING id, offering_id, resource_id, start_time,
                    customer_first_name, customer_email, customer_note,
                    amount_paid_cents`,
        [
          session.amount_total ?? 0,
          session.payment_intent ?? null,
          hashManageToken(manageToken),
          tenantIdFromAcct,
          bookingId,
        ],
      );
      if (r.rows.length === 0) {
        // Booking moved out of pending_payment between our INSERT and
        // the payment landing. Most likely: admin cancelled, or hold
        // expired and the janitor sweep closed it. Refunded below,
        // after this transaction ends (no external calls inside an
        // open tx — CLAUDE.md gotcha #9).
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

  if (!confirmed) {
    await refundUnconfirmablePayment(session, tenantIdFromAcct, bookingId, accountId);
    return;
  }

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
        manageUrl: buildManageUrl(tenantCtx.subdomain, manageToken),
        customerNote: confirmed.customer_note,
      }).catch((err) =>
        console.error('[email] walk-in booking confirmation send failed:', err),
      );
    }
  }
}

// A walk-in paid for a booking that is no longer in pending_payment
// (janitor-cancelled expired hold, or admin cancel while they sat on
// the Stripe-hosted page). Refund the payment on the connected
// account and stamp the refund on the booking row so the money trail
// is admin-visible. Called OUTSIDE any open transaction.
//
// Failure semantics: a refund error is rethrown → the webhook 500s →
// the dispatcher releases the dedup row → Stripe redelivers and the
// refund is retried. An already-refunded charge (retry after a
// partial failure) is treated as success.
async function refundUnconfirmablePayment(session, tenantId, bookingId, accountId) {
  console.warn(
    `checkout.session.completed (payment): booking ${bookingId} not in pending_payment state; refunding payment ${session.payment_intent ?? '(none)'}`,
  );
  if (!session.payment_intent) {
    // Nothing refundable on the session — should not happen for a
    // completed mode='payment' session. Manual reconciliation.
    console.error(
      `checkout.session.completed (payment): booking ${bookingId} paid but session has no payment_intent; manual reconciliation required`,
    );
    return;
  }

  try {
    await getStripe().refunds.create(
      { payment_intent: session.payment_intent },
      { stripeAccount: accountId },
    );
  } catch (err) {
    if (err?.code !== 'charge_already_refunded') throw err;
  }

  // Record the refund on the booking (fresh tenant transaction — the
  // Stripe call above ran outside any open tx). payment_status
  // 'refunded' requires paid == refunded > 0 per the schema CHECK;
  // the guard on 'pending' keeps this idempotent across retries.
  const amount = session.amount_total ?? 0;
  if (amount > 0) {
    await withTenantContextById(tenantId, async (client) => {
      await client.query(
        `UPDATE bookings
            SET amount_paid_cents = $1,
                amount_refunded_cents = $1,
                payment_status = 'refunded',
                stripe_payment_intent_id = $2
          WHERE tenant_id = $3
            AND id = $4
            AND status <> 'pending_payment'
            AND payment_status = 'pending'`,
        [amount, session.payment_intent, tenantId, bookingId],
      );
    });
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
