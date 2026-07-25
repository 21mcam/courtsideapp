// Stripe webhook tests — Phase 5 slice 2.
//
// Tests don't hit the Stripe network — `STRIPE_TEST_MODE=1` swaps in
// the in-memory fake from src/services/stripe.js. The fake exposes
// the real Stripe SDK's `webhooks` object (constructEvent +
// generateTestHeaderString are pure HMAC, no API call), so signing
// and verifying use the same code path as production.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT_SUBDOMAIN = 'verify-stripe-webhook';
const WEBHOOK_SECRET = 'whsec_test_secret_for_webhook_tests';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');

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
     VALUES ($1, 'Webhook Tests', 'UTC')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT_SUBDOMAIN],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT_SUBDOMAIN],
    )
  ).rows[0].id;

  // Need at least one user/admin so the test bootstraps cleanly,
  // even though the webhook endpoint itself doesn't touch users.
  const adminEmail = `admin-${randomUUID()}@example.com`;
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash('password', 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // This file signs events with FIXED ids (evt_test_*). The dedup
  // table stripe_webhook_events is global (no tenant_id — see
  // migration 016) so those rows survive the tenant teardown below,
  // and a rerun against the same DB would treat every event as a
  // duplicate and skip the handlers. Clear our fixed ids up front.
  await privilegedPool.query(
    `DELETE FROM stripe_webhook_events WHERE event_id LIKE 'evt_test_%'`,
  );

  // Pre-seed a stripe_connections row. This is what the webhook
  // looks up to bootstrap tenant context.
  stripe_account_id = `acct_test_${randomUUID().slice(0, 8)}`;
  await privilegedPool.query(
    `INSERT INTO stripe_connections (tenant_id, stripe_account_id)
     VALUES ($1, $2)`,
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
    await privilegedPool.query(
      `DELETE FROM stripe_connections WHERE tenant_id = $1`,
      [tenant_id],
    );
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain = $1`,
      [TENANT_SUBDOMAIN],
    );
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// Build a signed webhook request for `event`. Returns { body, signature }
// where body is a Buffer (matching what express.raw produces) and
// signature is the Stripe-Signature header value.
function signedRequest(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { body: payload, signature };
}

// ============================================================
// signature verification
// ============================================================

test('rejects request with no Stripe-Signature header → 400', { skip }, async () => {
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'evt_x', type: 'account.updated' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /missing stripe-signature/i);
});

test('rejects request with bad signature → 400', { skip }, async () => {
  const event = {
    id: 'evt_test_bad',
    type: 'account.updated',
    account: stripe_account_id,
    data: { object: { id: stripe_account_id, details_submitted: true } },
  };
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=12345,v1=deadbeef',
    },
    body: JSON.stringify(event),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /signature verification failed/i);
});

// ============================================================
// account.updated dispatch
// ============================================================

test('account.updated updates stripe_connections + stamps fully_onboarded_at', { skip }, async () => {
  // Reset row to unsubmitted state
  await privilegedPool.query(
    `UPDATE stripe_connections
        SET details_submitted = false, charges_enabled = false,
            payouts_enabled = false, fully_onboarded_at = NULL
      WHERE tenant_id = $1`,
    [tenant_id],
  );

  const event = {
    id: 'evt_test_account_upd',
    type: 'account.updated',
    account: stripe_account_id,
    data: {
      object: {
        id: stripe_account_id,
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
      },
    },
  };
  const { body, signature } = signedRequest(event);
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
  assert.equal(res.status, 200);
  const respBody = await res.json();
  assert.equal(respBody.received, true);
  assert.equal(respBody.type, 'account.updated');

  const r = await privilegedPool.query(
    `SELECT details_submitted, charges_enabled, payouts_enabled, fully_onboarded_at
       FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  assert.equal(r.rows[0].details_submitted, true);
  assert.equal(r.rows[0].charges_enabled, true);
  assert.equal(r.rows[0].payouts_enabled, true);
  assert.ok(r.rows[0].fully_onboarded_at, 'fully_onboarded_at should stamp');
});

test('account.updated for unknown account is silently dropped (200, no DB change)', { skip }, async () => {
  const unknownAccount = 'acct_does_not_exist_in_db';
  const event = {
    id: 'evt_test_unknown',
    type: 'account.updated',
    account: unknownAccount,
    data: {
      object: { id: unknownAccount, details_submitted: true },
    },
  };
  const { body, signature } = signedRequest(event);
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
  // 200 because the signature was valid; we just had no row for the
  // account. The handler logs + skips so Stripe doesn't keep
  // retrying.
  assert.equal(res.status, 200);
});

// ============================================================
// non-account events
// ============================================================

test('events for unwired types return 200 without modifying state', { skip }, async () => {
  // Reset the row to a known state
  await privilegedPool.query(
    `UPDATE stripe_connections
        SET details_submitted = true, charges_enabled = true,
            payouts_enabled = true
      WHERE tenant_id = $1`,
    [tenant_id],
  );

  const event = {
    id: 'evt_test_unwired',
    type: 'invoice.payment_succeeded',
    account: stripe_account_id,
    data: { object: { id: 'in_test', amount_paid: 1000 } },
  };
  const { body, signature } = signedRequest(event);
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
  assert.equal(res.status, 200);

  // Row unchanged
  const r = await privilegedPool.query(
    `SELECT details_submitted, charges_enabled FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  assert.equal(r.rows[0].details_submitted, true);
  assert.equal(r.rows[0].charges_enabled, true);
});

// ============================================================
// fully_onboarded_at preservation
// ============================================================

test('subsequent account.updated does NOT overwrite fully_onboarded_at', { skip }, async () => {
  // Make sure a stamp exists from a prior test
  await privilegedPool.query(
    `UPDATE stripe_connections
        SET details_submitted = true, charges_enabled = true,
            payouts_enabled = true,
            fully_onboarded_at = COALESCE(fully_onboarded_at, now())
      WHERE tenant_id = $1`,
    [tenant_id],
  );
  const before_ = await privilegedPool.query(
    `SELECT fully_onboarded_at FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  const stamp1 = before_.rows[0].fully_onboarded_at;

  // Send another account.updated
  const event = {
    id: 'evt_test_again',
    type: 'account.updated',
    account: stripe_account_id,
    data: {
      object: {
        id: stripe_account_id,
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
      },
    },
  };
  const { body, signature } = signedRequest(event);
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  });
  assert.equal(res.status, 200);

  const after_ = await privilegedPool.query(
    `SELECT fully_onboarded_at FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  assert.equal(
    new Date(after_.rows[0].fully_onboarded_at).toISOString(),
    new Date(stamp1).toISOString(),
    'fully_onboarded_at should be preserved across subsequent updates',
  );
});

// ============================================================
// dedup release on handler failure (review fix)
// ============================================================
//
// The dedup row is inserted (autocommit) BEFORE the handler runs. If
// the handler then fails, the dispatcher must DELETE the dedup row so
// Stripe's retry actually re-runs the handler — otherwise a transient
// failure permanently loses the event (e.g. a paid pack purchase
// whose credits are never granted).

test('handler failure releases the dedup row so a retry re-processes the event', { skip }, async () => {
  // Plan exists; member does NOT (yet) — the subscriptions INSERT
  // hits the members FK and the handler throws (a stand-in for any
  // transient failure).
  const planRes = await privilegedPool.query(
    `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
     VALUES ($1, 'Dedup Test Plan', 5000, 7) RETURNING id`,
    [tenant_id],
  );
  const planId = planRes.rows[0].id;
  const memberId = randomUUID();
  const stripeSubId = `sub_test_dedup_${randomUUID().slice(0, 6)}`;

  const event = {
    id: `evt_test_dedup_release_${randomUUID().slice(0, 6)}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: 'cs_test_dedup_release',
        mode: 'subscription',
        subscription: stripeSubId,
        customer: 'cus_test_dedup',
        metadata: {
          courtside_tenant_id: tenant_id,
          courtside_member_id: memberId,
          courtside_plan_id: planId,
        },
      },
    },
  };

  const post = async () => {
    const { body, signature } = signedRequest(event);
    return fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body,
    });
  };

  // First delivery: handler throws (FK violation) → 500, and the
  // dedup row must be gone so the retry isn't answered "deduped".
  const res1 = await post();
  assert.equal(res1.status, 500);
  const dedup1 = await privilegedPool.query(
    `SELECT 1 FROM stripe_webhook_events WHERE event_id = $1`,
    [event.id],
  );
  assert.equal(
    dedup1.rows.length,
    0,
    'dedup row must be released when the handler fails',
  );

  // "Transient" cause resolved: the member now exists.
  await privilegedPool.query(
    `INSERT INTO members (id, tenant_id, email, first_name, last_name)
     VALUES ($1, $2, $3, 'Dedup', 'Member')`,
    [memberId, tenant_id, `dedup-${randomUUID()}@example.com`],
  );

  // Stripe retry of the SAME event id: re-runs the handler and the
  // subscription lands this time.
  const res2 = await post();
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.ok(!body2.deduped, 'retry must not be answered as a duplicate');

  const subRow = await privilegedPool.query(
    `SELECT status FROM subscriptions
      WHERE tenant_id = $1 AND stripe_subscription_id = $2`,
    [tenant_id, stripeSubId],
  );
  assert.equal(subRow.rows.length, 1, 'retry must create the subscription');
  assert.equal(subRow.rows[0].status, 'active');

  // And now the dedup row is in place: a THIRD delivery is deduped.
  const res3 = await post();
  const body3 = await res3.json();
  assert.equal(body3.deduped, true);
});
