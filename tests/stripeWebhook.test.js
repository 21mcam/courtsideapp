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
