// Subscription lifecycle webhook tests — Phase 5 slice 4b.
//
// Covers the three lifecycle event handlers:
//   * customer.subscription.updated — status + period + cancel_at_period_end
//   * customer.subscription.deleted — status='cancelled', plan_period closed
//   * invoice.payment_succeeded — period bounds reconciled; subscription_cycle
//     grants fresh credits, subscription_create does NOT (already done by
//     checkout.session.completed in slice 4a)
//
// Plus the new dedup table behavior: duplicate event_id → handler skipped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT = 'verify-sub-lifecycle';
const TZ = 'UTC';
const WEBHOOK_SECRET = 'whsec_test_lifecycle';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let stripe_account_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Sub Lifecycle Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  // Stripe connection (fully onboarded)
  stripeFake.__resetStripeFake();
  stripe_account_id = `acct_test_${randomUUID().slice(0, 8)}`;
  stripeFake.__setAccountState(stripe_account_id, {
    id: stripe_account_id,
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
  });
  await privilegedPool.query(
    `INSERT INTO stripe_connections (
       tenant_id, stripe_account_id,
       details_submitted, charges_enabled, payouts_enabled
     ) VALUES ($1, $2, true, true, true)`,
    [tenant_id, stripe_account_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    // Clean up dedup rows for this run
    await privilegedPool.query(
      `DELETE FROM stripe_webhook_events WHERE account_id = $1`,
      [stripe_account_id],
    );
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain = $1`,
      [TENANT],
    );
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
// ============================================================

function signedWebhook(eventBody) {
  const payload = JSON.stringify(eventBody);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { body: payload, signature };
}

async function postWebhook(eventBody) {
  const { body, signature } = signedWebhook(eventBody);
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
}

// Plant a member + an active subscription via privileged pool. Sets
// the GUC inside a transaction so the inserts respect FORCE RLS.
async function seedSubscription({ stripe_subscription_id, credits_per_week = 5 }) {
  const memberEmail = `m-${randomUUID()}@example.com`;
  const planId = randomUUID();
  const subId = randomUUID();
  const memberId = randomUUID();

  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);

    await c.query(
      `INSERT INTO members (id, tenant_id, email, first_name, last_name)
       VALUES ($1, $2, $3, 'Sub', 'Member')`,
      [memberId, tenant_id, memberEmail],
    );
    await c.query(
      `INSERT INTO plans (id, tenant_id, name, monthly_price_cents, credits_per_week,
                          stripe_price_id, active)
       VALUES ($1, $2, $3, 5000, $4, $5, true)`,
      [
        planId,
        tenant_id,
        `Plan ${randomUUID().slice(0, 6)}`,
        credits_per_week,
        `price_test_${randomUUID().slice(0, 6)}`,
      ],
    );
    await c.query(
      `INSERT INTO subscriptions (
         id, tenant_id, member_id, status,
         stripe_subscription_id, stripe_customer_id,
         current_period_start, current_period_end,
         activated_at
       ) VALUES ($1, $2, $3, 'active', $4, $5, now() - interval '15 days',
                 now() + interval '15 days', now() - interval '15 days')`,
      [
        subId,
        tenant_id,
        memberId,
        stripe_subscription_id,
        `cus_test_${randomUUID().slice(0, 6)}`,
      ],
    );
    await c.query(
      `INSERT INTO subscription_plan_periods
         (tenant_id, subscription_id, plan_id, started_at)
       VALUES ($1, $2, $3, now() - interval '15 days')`,
      [tenant_id, subId, planId],
    );

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  return { memberId, planId, subId };
}

// ============================================================
// customer.subscription.updated
// ============================================================

test('subscription.updated → status mapped, period bounds + cancel_at_period_end synced', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({ stripe_subscription_id: stripeSubId });

  const newStart = Math.floor(Date.now() / 1000);
  const newEnd = newStart + 30 * 24 * 60 * 60;
  const event = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.updated',
    account: stripe_account_id,
    data: {
      object: {
        id: stripeSubId,
        status: 'past_due',
        current_period_start: newStart,
        current_period_end: newEnd,
        cancel_at_period_end: true,
      },
    },
  };

  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const r = await privilegedPool.query(
    `SELECT status, current_period_start, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(r.rows[0].status, 'past_due');
  assert.equal(r.rows[0].cancel_at_period_end, true);
  assert.equal(
    new Date(r.rows[0].current_period_end).getTime(),
    new Date(newEnd * 1000).getTime(),
  );
});

test('subscription.updated maps trialing → active', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({ stripe_subscription_id: stripeSubId });

  const event = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.updated',
    account: stripe_account_id,
    data: {
      object: {
        id: stripeSubId,
        status: 'trialing',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 7 * 86400,
        cancel_at_period_end: false,
      },
    },
  };

  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const r = await privilegedPool.query(
    `SELECT status FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(r.rows[0].status, 'active');
});

test('subscription.updated for unknown stripe_subscription_id is silently dropped', { skip }, async () => {
  const event = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.updated',
    account: stripe_account_id,
    data: {
      object: {
        id: `sub_does_not_exist_${randomUUID().slice(0, 6)}`,
        status: 'past_due',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        cancel_at_period_end: false,
      },
    },
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);
});

// ============================================================
// customer.subscription.deleted
// ============================================================

test('subscription.deleted → status=cancelled, ended_at stamped, plan_period closed', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({ stripe_subscription_id: stripeSubId });

  const event = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.deleted',
    account: stripe_account_id,
    data: {
      object: { id: stripeSubId, status: 'canceled' },
    },
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const subRow = await privilegedPool.query(
    `SELECT status, ended_at FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(subRow.rows[0].status, 'cancelled');
  assert.ok(subRow.rows[0].ended_at);

  const periodRow = await privilegedPool.query(
    `SELECT ended_at FROM subscription_plan_periods
      WHERE subscription_id = $1`,
    [seeded.subId],
  );
  assert.ok(
    periodRow.rows[0].ended_at,
    'active plan period should have been closed',
  );
});

test('subscription.deleted is idempotent (running twice doesn\'t re-stamp ended_at)', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({ stripe_subscription_id: stripeSubId });

  // First delivery
  const event1 = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.deleted',
    account: stripe_account_id,
    data: { object: { id: stripeSubId } },
  };
  await postWebhook(event1);

  const before_ = await privilegedPool.query(
    `SELECT ended_at FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );

  // Second delivery (different event id so dedup doesn't catch it;
  // handler's "WHERE status <> 'cancelled'" should make it a no-op)
  const event2 = {
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.deleted',
    account: stripe_account_id,
    data: { object: { id: stripeSubId } },
  };
  await postWebhook(event2);

  const after_ = await privilegedPool.query(
    `SELECT status, ended_at FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(after_.rows[0].status, 'cancelled');
  assert.equal(
    new Date(after_.rows[0].ended_at).toISOString(),
    new Date(before_.rows[0].ended_at).toISOString(),
    'ended_at should not have been re-stamped',
  );
});

// ============================================================
// invoice.payment_succeeded
// ============================================================

test('invoice.payment_succeeded subscription_cycle grants fresh credits + reconciles period', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({
    stripe_subscription_id: stripeSubId,
    credits_per_week: 12,
  });

  // Bootstrap a balance to validate the increment
  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    await c.query(
      `SELECT apply_credit_change($1, $2, $3, 'admin_adjustment', NULL, NULL, NULL, NULL)`,
      [tenant_id, seeded.memberId, 5],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }

  const periodStart = Math.floor(Date.now() / 1000);
  const periodEnd = periodStart + 30 * 86400;
  const event = {
    id: `evt_${randomUUID()}`,
    type: 'invoice.payment_succeeded',
    account: stripe_account_id,
    data: {
      object: {
        id: `in_test_${randomUUID().slice(0, 6)}`,
        subscription: stripeSubId,
        billing_reason: 'subscription_cycle',
        period_start: periodStart,
        period_end: periodEnd,
      },
    },
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  // Balance: 5 starting + 12 from renewal = 17
  const balRow = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [seeded.memberId],
  );
  assert.equal(balRow.rows[0].current_credits, 17);

  // Ledger has the weekly_reset entry for 12
  const ledger = await privilegedPool.query(
    `SELECT amount, reason FROM credit_ledger_entries
      WHERE member_id = $1 AND reason = 'weekly_reset'
      ORDER BY entry_number DESC LIMIT 1`,
    [seeded.memberId],
  );
  assert.equal(ledger.rows[0].amount, 12);

  // Period bounds advanced
  const subRow = await privilegedPool.query(
    `SELECT current_period_end FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(
    new Date(subRow.rows[0].current_period_end).getTime(),
    new Date(periodEnd * 1000).getTime(),
  );
});

test('invoice.payment_succeeded subscription_create does NOT grant credits (already done by checkout)', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({
    stripe_subscription_id: stripeSubId,
    credits_per_week: 8,
  });

  // Member starts at 0 credits (no balance row). Send a
  // subscription_create invoice; we expect NO credit grant.
  const event = {
    id: `evt_${randomUUID()}`,
    type: 'invoice.payment_succeeded',
    account: stripe_account_id,
    data: {
      object: {
        id: `in_test_${randomUUID().slice(0, 6)}`,
        subscription: stripeSubId,
        billing_reason: 'subscription_create',
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  // No balance row created (or 0 credits if exists)
  const balRow = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances WHERE member_id = $1`,
    [seeded.memberId],
  );
  if (balRow.rows.length > 0) {
    assert.equal(balRow.rows[0].current_credits, 0);
  }

  // No weekly_reset ledger entries
  const ledger = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM credit_ledger_entries
      WHERE member_id = $1 AND reason = 'weekly_reset'`,
    [seeded.memberId],
  );
  assert.equal(ledger.rows[0].n, 0);
});

test('invoice.payment_succeeded for past_due subscription flips it back to active', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({ stripe_subscription_id: stripeSubId });
  await privilegedPool.query(
    `UPDATE subscriptions SET status = 'past_due' WHERE id = $1`,
    [seeded.subId],
  );

  const event = {
    id: `evt_${randomUUID()}`,
    type: 'invoice.payment_succeeded',
    account: stripe_account_id,
    data: {
      object: {
        id: `in_test_${randomUUID().slice(0, 6)}`,
        subscription: stripeSubId,
        billing_reason: 'subscription_cycle',
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };
  const res = await postWebhook(event);
  assert.equal(res.status, 200);

  const r = await privilegedPool.query(
    `SELECT status FROM subscriptions WHERE id = $1`,
    [seeded.subId],
  );
  assert.equal(r.rows[0].status, 'active');
});

// ============================================================
// dedup
// ============================================================

test('duplicate event delivery is deduped at the controller boundary', { skip }, async () => {
  const stripeSubId = `sub_test_${randomUUID().slice(0, 8)}`;
  const seeded = await seedSubscription({
    stripe_subscription_id: stripeSubId,
    credits_per_week: 4,
  });

  const eventId = `evt_${randomUUID()}`;
  const event = {
    id: eventId,
    type: 'invoice.payment_succeeded',
    account: stripe_account_id,
    data: {
      object: {
        id: `in_test_${randomUUID().slice(0, 6)}`,
        subscription: stripeSubId,
        billing_reason: 'subscription_cycle',
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };

  const r1 = await postWebhook(event);
  assert.equal(r1.status, 200);
  const body1 = await r1.json();
  assert.ok(!body1.deduped);

  // Same event id → dedup'd
  const r2 = await postWebhook(event);
  assert.equal(r2.status, 200);
  const body2 = await r2.json();
  assert.equal(body2.deduped, true);

  // Only ONE credit grant for the duplicated delivery
  const ledger = await privilegedPool.query(
    `SELECT count(*)::int AS n FROM credit_ledger_entries
      WHERE member_id = $1 AND reason = 'weekly_reset'`,
    [seeded.memberId],
  );
  assert.equal(ledger.rows[0].n, 1);
});
