// Platform billing — tenants paying Courtside (migration 025).
//
// Proves the full lifecycle against the in-process Stripe fake:
//
//   1. signup-tenant stamps a trial clock (PLATFORM_TRIAL_DAYS)
//   2. GET /api/admin/billing reads status through the GUC-guarded
//      SECURITY DEFINER function
//   3. checkout creates ONE platform customer (write-once, reused on
//      the second checkout) and a subscription-mode session on the
//      platform account (no stripeAccount)
//   4. the platform webhook (separate endpoint + secret) flips status
//      on checkout.session.completed / subscription.updated /
//      subscription.deleted, with dedup on replay
//   5. billing gating: past_due keeps the tenant online (grace),
//      cancelled 402s everything EXCEPT the billing-exempt paths
//      (/api/tenant, /api/auth/*, /api/me, /api/admin/billing*), so a
//      lapsed tenant's admin can still sign in and reactivate
//   6. invoice.payment_failed emails the owner admin (keyless →
//      recorded in the email service's skipped ring buffer)
//   7. the super-admin escape hatch comps / expires tenants
//
// Skips cleanly without DATABASE_URL_PRIVILEGED + SUPER_ADMIN_TOKEN.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import Stripe from 'stripe';

const PLATFORM_WEBHOOK_SECRET = 'whsec_platform_test_secret';
process.env.STRIPE_TEST_MODE = '1';
process.env.PLATFORM_STRIPE_WEBHOOK_SECRET = PLATFORM_WEBHOOK_SECRET;
process.env.PLATFORM_PRICE_ID = 'price_platform_monthly_test';
process.env.PLATFORM_MONTHLY_PRICE_CENTS = '12900';
process.env.PLATFORM_TRIAL_DAYS = '30';

const { app } = await import('../src/app.js');
const {
  FAKE_PLATFORM_ACCOUNT,
  __completeCheckoutSession,
  __getCheckoutSession,
} = await import('../src/services/stripe.js');
const { __getSkippedEmails, __clearSkippedEmails } = await import(
  '../src/services/email.js'
);

const skip =
  (!process.env.DATABASE_URL_PRIVILEGED || !process.env.SUPER_ADMIN_TOKEN) &&
  'DATABASE_URL_PRIVILEGED and SUPER_ADMIN_TOKEN required';
const enabled =
  process.env.DATABASE_URL_PRIVILEGED && process.env.SUPER_ADMIN_TOKEN;

let server;
let baseUrl;
let privilegedPool;
let adminToken;

const TENANT = `pbill-${randomUUID().slice(0, 8)}`;
const OWNER_EMAIL = `owner-${randomUUID().slice(0, 8)}@example.com`;
const OWNER_PASSWORD = 'correcthorsebatterystaple';

before(async () => {
  if (!enabled) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const signup = await fetch(`${baseUrl}/api/platform/signup-tenant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      subdomain: TENANT,
      name: 'Platform Billing Test Gym',
      timezone: 'America/New_York',
      owner_email: OWNER_EMAIL,
      owner_password: OWNER_PASSWORD,
      owner_first_name: 'Pat',
      owner_last_name: 'Owner',
    }),
  });
  if (!signup.ok) throw new Error(`signup failed: HTTP ${signup.status}`);

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  adminToken = (await login.json()).token;
});

after(async () => {
  if (!enabled) return;
  await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
    TENANT,
  ]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await privilegedPool?.end();
});

function adminFetch(path, opts = {}) {
  return fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}tenant=${TENANT}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(opts.headers ?? {}),
    },
  });
}

function superAdminPatchBilling(body) {
  return fetch(`${baseUrl}/api/platform/tenants/${TENANT}/billing`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Super-Admin-Token': process.env.SUPER_ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

async function postPlatformWebhook(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: PLATFORM_WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return fetch(`${baseUrl}/webhooks/stripe-platform`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature,
    },
    body: payload,
  });
}

async function tenantRow() {
  const r = await privilegedPool.query(
    `SELECT platform_stripe_customer_id, platform_stripe_subscription_id,
            platform_subscription_status, trial_ends_at
       FROM tenants WHERE subdomain = $1`,
    [TENANT],
  );
  return r.rows[0];
}

// Shared across sequential tests — captured from the checkout flow.
let checkoutSessionId;
let platformCustomerId;
let platformSubscriptionId;

// ============================================================
// trial stamping + billing read
// ============================================================

test('signup stamps trial_ends_at ≈ PLATFORM_TRIAL_DAYS out', { skip }, async () => {
  const row = await tenantRow();
  assert.equal(row.platform_subscription_status, 'trial');
  assert.ok(row.trial_ends_at, 'trial_ends_at should be set');
  const days = (new Date(row.trial_ends_at) - Date.now()) / 86_400_000;
  assert.ok(days > 29 && days < 31, `expected ~30 days, got ${days}`);
});

test('GET /api/admin/billing exposes status, trial, and config', { skip }, async () => {
  const res = await adminFetch('/api/admin/billing');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'trial');
  assert.ok(body.trial_ends_at);
  assert.equal(body.has_subscription, false);
  assert.equal(body.billing_configured, true);
  assert.equal(body.monthly_price_cents, 12900);
});

// ============================================================
// checkout: platform customer + session
// ============================================================

test('checkout creates a platform customer and a subscription session', { skip }, async () => {
  const res = await adminFetch('/api/admin/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({
      success_url: 'https://example.com/ok',
      cancel_url: 'https://example.com/no',
    }),
  });
  assert.equal(res.status, 201);
  const { checkout_url } = await res.json();
  assert.ok(checkout_url.includes('/checkout/'));
  checkoutSessionId = checkout_url.split('/checkout/')[1];

  const row = await tenantRow();
  assert.ok(row.platform_stripe_customer_id, 'customer id stored');
  platformCustomerId = row.platform_stripe_customer_id;

  // Session landed on the PLATFORM bucket of the fake, not a
  // connected account, in subscription mode with our price.
  const session = __getCheckoutSession(FAKE_PLATFORM_ACCOUNT, checkoutSessionId);
  assert.ok(session, 'session exists on the platform account');
  assert.equal(session.mode, 'subscription');
  assert.equal(session.customer, platformCustomerId);
  assert.equal(session.metadata.courtside_platform, '1');
  assert.equal(session.line_items[0].price, 'price_platform_monthly_test');
});

test('second checkout reuses the same platform customer', { skip }, async () => {
  const res = await adminFetch('/api/admin/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({
      success_url: 'https://example.com/ok',
      cancel_url: 'https://example.com/no',
    }),
  });
  assert.equal(res.status, 201);
  const row = await tenantRow();
  assert.equal(row.platform_stripe_customer_id, platformCustomerId);
});

test('checkout 503s when PLATFORM_PRICE_ID is unset', { skip }, async () => {
  const saved = process.env.PLATFORM_PRICE_ID;
  delete process.env.PLATFORM_PRICE_ID;
  try {
    const res = await adminFetch('/api/admin/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({
        success_url: 'https://example.com/ok',
        cancel_url: 'https://example.com/no',
      }),
    });
    assert.equal(res.status, 503);
  } finally {
    process.env.PLATFORM_PRICE_ID = saved;
  }
});

// ============================================================
// platform webhook lifecycle
// ============================================================

test('platform webhook rejects a missing signature', { skip }, async () => {
  const res = await fetch(`${baseUrl}/webhooks/stripe-platform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed' }),
  });
  assert.equal(res.status, 400);
});

test('checkout.session.completed activates the tenant; replay dedupes', { skip }, async () => {
  const { session } = __completeCheckoutSession(
    FAKE_PLATFORM_ACCOUNT,
    checkoutSessionId,
  );
  platformSubscriptionId = session.subscription;

  const event = {
    id: `evt_pb_checkout_${randomUUID().slice(0, 8)}`,
    type: 'checkout.session.completed',
    data: { object: session },
  };
  const res = await postPlatformWebhook(event);
  assert.equal(res.status, 200);

  const row = await tenantRow();
  assert.equal(row.platform_subscription_status, 'active');
  assert.equal(row.platform_stripe_subscription_id, platformSubscriptionId);

  const billing = await adminFetch('/api/admin/billing');
  assert.equal((await billing.json()).has_subscription, true);

  const replay = await postPlatformWebhook(event);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deduped, true);
});

test('subscription past_due keeps the tenant online (grace)', { skip }, async () => {
  const res = await postPlatformWebhook({
    id: `evt_pb_pastdue_${randomUUID().slice(0, 8)}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: platformSubscriptionId,
        customer: platformCustomerId,
        status: 'past_due',
        metadata: { courtside_platform: '1' },
      },
    },
  });
  assert.equal(res.status, 200);

  const row = await tenantRow();
  assert.equal(row.platform_subscription_status, 'past_due');

  // Grace: the whole API stays reachable, not just exempt paths.
  const t = await fetch(`${baseUrl}/api/tenant?tenant=${TENANT}`);
  assert.equal(t.status, 200);
  assert.equal((await t.json()).billing_blocked, false);
  const members = await adminFetch('/api/admin/members');
  assert.equal(members.status, 200);
});

test('invoice.payment_failed emails the owner admin', { skip }, async () => {
  __clearSkippedEmails();
  const res = await postPlatformWebhook({
    id: `evt_pb_payfail_${randomUUID().slice(0, 8)}`,
    type: 'invoice.payment_failed',
    data: { object: { customer: platformCustomerId } },
  });
  assert.equal(res.status, 200);
  // The send is post-response fire-and-forget — give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  const sent = __getSkippedEmails().find((e) =>
    /courtside payment failed/i.test(e.subject),
  );
  assert.ok(sent, 'payment-failed email queued');
  assert.equal(sent.to, OWNER_EMAIL);
  // Platform → operator mail: never the tenant's member-facing reply-to.
  assert.equal(sent.replyTo, null);
});

test('subscription.deleted cancels; only billing-exempt paths survive', { skip }, async () => {
  const res = await postPlatformWebhook({
    id: `evt_pb_deleted_${randomUUID().slice(0, 8)}`,
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: platformSubscriptionId,
        customer: platformCustomerId,
        status: 'canceled',
        metadata: { courtside_platform: '1' },
      },
    },
  });
  assert.equal(res.status, 200);
  assert.equal((await tenantRow()).platform_subscription_status, 'cancelled');

  // Normal API → 402.
  const members = await adminFetch('/api/admin/members');
  assert.equal(members.status, 402);
  const avail = await fetch(`${baseUrl}/api/availability?tenant=${TENANT}`);
  assert.equal(avail.status, 402);

  // Exempt: bootstrap flags the hold instead of erroring…
  const t = await fetch(`${baseUrl}/api/tenant?tenant=${TENANT}`);
  assert.equal(t.status, 200);
  assert.equal((await t.json()).billing_blocked, true);

  // …login still works…
  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  assert.equal(login.status, 200);

  // …and the billing routes still work, so the admin can reactivate.
  const billing = await adminFetch('/api/admin/billing');
  assert.equal(billing.status, 200);
  assert.equal((await billing.json()).status, 'cancelled');
  const checkout = await adminFetch('/api/admin/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({
      success_url: 'https://example.com/ok',
      cancel_url: 'https://example.com/no',
    }),
  });
  assert.equal(checkout.status, 201);
});

// ============================================================
// super-admin escape hatch + trial expiry
// ============================================================

test('super-admin can comp the tenant (trial, no expiry)', { skip }, async () => {
  const res = await superAdminPatchBilling({
    status: 'trial',
    trial_ends_at: null,
  });
  assert.equal(res.status, 200);

  const row = await tenantRow();
  assert.equal(row.platform_subscription_status, 'trial');
  assert.equal(row.trial_ends_at, null);

  const members = await adminFetch('/api/admin/members');
  assert.equal(members.status, 200);
});

test('an expired trial 402s except billing-exempt paths', { skip }, async () => {
  const res = await superAdminPatchBilling({
    trial_ends_at: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(res.status, 200);

  const members = await adminFetch('/api/admin/members');
  assert.equal(members.status, 402);
  const billing = await adminFetch('/api/admin/billing');
  assert.equal(billing.status, 200);

  // Restore for any later suites touching this tenant.
  await superAdminPatchBilling({ trial_ends_at: null });
});

test('super-admin billing PATCH requires the token', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/platform/tenants/${TENANT}/billing`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active' }),
  });
  assert.equal(res.status, 401);
});
