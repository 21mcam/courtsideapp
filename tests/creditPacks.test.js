// One-time credit pack tests — credit-packs slice (migration 024).
//
// Covers:
//   * Admin CRUD: create / list / PATCH (partial update + soft
//     deactivate) with the usual 400/403/404 edges.
//   * Member storefront: GET /api/packs lists ACTIVE packs only;
//     checkout on a deactivated/unknown pack is rejected.
//   * POST /api/packs/:id/checkout mints a mode='payment' Checkout
//     Session with the pack_purchase metadata bridge.
//   * Webhook checkout.session.completed (courtside_type=
//     'pack_purchase'): grants credits via apply_credit_change
//     (reason 'pack_purchase', purchased_credits incremented), sends
//     a receipt email, and a replayed event id is deduped (no double
//     grant).
//   * Draw-down order: spends consume subscription-bucket credits
//     first; purchased_credits only clamp down once the balance dips
//     below them. Negative pack_purchase amounts are rejected.
//   * Weekly reset: run_weekly_credit_resets() lands the balance on
//     credits_per_week + unspent purchased credits — purchased
//     credits survive Monday.
//
// Isolation: this file owns tenant subdomain 'verify-credit-packs'.
// The weekly-reset test backdates ONLY this tenant's
// last_weekly_reset_at (other tests' tenants default to now() = not
// due) and restores it afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT = 'verify-credit-packs';
const WEBHOOK_SECRET = 'whsec_test_credit_packs';

process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
// Keyless email mode: sends are recorded in __getSkippedEmails.
delete process.env.RESEND_API_KEY;

const { app } = await import('../src/app.js');
const stripeFake = await import('../src/services/stripe.js');
const { __getSkippedEmails } = await import('../src/services/email.js');
import { pool } from '../src/db/pool.js';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let stripe_account_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Credit Pack Tests', 'UTC')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  // Charges-enabled Stripe connection + matching fake account state.
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

  const loginRes = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) throw new Error(`admin login failed: HTTP ${loginRes.status}`);
  adminToken = (await loginRes.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
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
  await pool.end();
});

// ============================================================
// helpers
// ============================================================

function tokenFetch(token, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

const adminFetch = (path, init) => tokenFetch(adminToken, path, init);

async function newMember() {
  const email = `member-${randomUUID()}@example.com`;
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'correcthorsebatterystaple',
        first_name: 'Pack',
        last_name: 'Buyer',
      }),
    },
  );
  if (!reg.ok) throw new Error(`register-member: HTTP ${reg.status}`);
  const body = await reg.json();
  return { ...body, email };
}

async function createPack(fields = {}) {
  const res = await adminFetch('/api/admin/packs', {
    method: 'POST',
    body: JSON.stringify({
      name: `Pack ${randomUUID().slice(0, 8)}`,
      credits: 10,
      price_cents: 9000,
      ...fields,
    }),
  });
  if (res.status !== 201) throw new Error(`createPack failed: HTTP ${res.status}`);
  return (await res.json()).pack;
}

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

// Run a callback on a privileged client with this tenant's GUC set.
async function withTenant(fn) {
  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
      tenant_id,
    ]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function applyChange(memberId, amount, reason) {
  return withTenant((c) =>
    c.query(
      `SELECT balance_after FROM apply_credit_change(
         $1, $2, $3, $4, NULL, NULL, NULL, NULL
       )`,
      [tenant_id, memberId, amount, reason],
    ),
  );
}

async function getBalance(memberId) {
  const r = await privilegedPool.query(
    `SELECT current_credits, purchased_credits FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, memberId],
  );
  return r.rows[0] ?? null;
}

async function ledgerRows(memberId, reason) {
  const r = await privilegedPool.query(
    `SELECT amount, balance_after, reason, note
       FROM credit_ledger_entries
      WHERE tenant_id = $1 AND member_id = $2 AND reason = $3
      ORDER BY entry_number ASC`,
    [tenant_id, memberId, reason],
  );
  return r.rows;
}

// Fire-and-forget sends land after the webhook response — poll.
async function eventually(fn, what) {
  for (let i = 0; i < 40; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Full purchase round-trip: member starts checkout, the fake session
// "completes", and the signed webhook event is delivered. Returns
// { pack, member, session, eventId, res }.
async function purchasePack({ pack, member, eventId = `evt_${randomUUID()}` }) {
  const checkoutRes = await tokenFetch(
    member.token,
    `/api/packs/${pack.id}/checkout`,
    {
      method: 'POST',
      body: JSON.stringify({
        success_url: 'https://example.com/plans?pack_success=1',
        cancel_url: 'https://example.com/plans',
      }),
    },
  );
  if (checkoutRes.status !== 201) {
    throw new Error(`checkout failed: HTTP ${checkoutRes.status}`);
  }
  const { session_id } = await checkoutRes.json();
  const { session } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    session_id,
  );
  const res = await postWebhook({
    id: eventId,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: { object: session },
  });
  return { pack, member, session, eventId, res };
}

// ============================================================
// admin CRUD
// ============================================================

test('POST /api/admin/packs creates a pack', { skip }, async () => {
  const res = await adminFetch('/api/admin/packs', {
    method: 'POST',
    body: JSON.stringify({ name: '10-Pack', credits: 10, price_cents: 9000 }),
  });
  assert.equal(res.status, 201);
  const { pack } = await res.json();
  assert.equal(pack.name, '10-Pack');
  assert.equal(pack.credits, 10);
  assert.equal(pack.price_cents, 9000);
  assert.equal(pack.active, true);
  assert.ok(pack.id);
});

test('POST /api/admin/packs rejects invalid input', { skip }, async () => {
  for (const bad of [
    { name: 'Zero credits', credits: 0, price_cents: 1000 },
    { name: 'Free pack', credits: 5, price_cents: 0 },
    { name: '   ', credits: 5, price_cents: 1000 },
    { credits: 5, price_cents: 1000 },
  ]) {
    const res = await adminFetch('/api/admin/packs', {
      method: 'POST',
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

test('PATCH /api/admin/packs/:id updates fields and soft-deactivates', { skip }, async () => {
  const pack = await createPack();

  const upd = await adminFetch(`/api/admin/packs/${pack.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Mega Pack', credits: 25, price_cents: 20000 }),
  });
  assert.equal(upd.status, 200);
  const updated = (await upd.json()).pack;
  assert.equal(updated.name, 'Mega Pack');
  assert.equal(updated.credits, 25);
  assert.equal(updated.price_cents, 20000);
  assert.equal(updated.active, true);

  const deact = await adminFetch(`/api/admin/packs/${pack.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
  assert.equal(deact.status, 200);
  assert.equal((await deact.json()).pack.active, false);

  // Admin list still shows it (inactive sorts after active).
  const list = await adminFetch('/api/admin/packs');
  assert.equal(list.status, 200);
  const { packs } = await list.json();
  assert.ok(packs.some((p) => p.id === pack.id && p.active === false));
});

test('PATCH /api/admin/packs/:id edge cases: 404 unknown/malformed, 400 empty body', { skip }, async () => {
  const unknown = await adminFetch(`/api/admin/packs/${randomUUID()}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'X' }),
  });
  assert.equal(unknown.status, 404);

  const malformed = await adminFetch(`/api/admin/packs/not-a-uuid`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'X' }),
  });
  assert.equal(malformed.status, 404);

  const pack = await createPack();
  const empty = await adminFetch(`/api/admin/packs/${pack.id}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  const badValue = await adminFetch(`/api/admin/packs/${pack.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ credits: 0 }),
  });
  assert.equal(badValue.status, 400);
});

test('admin pack endpoints reject member tokens', { skip }, async () => {
  const member = await newMember();
  const res = await tokenFetch(member.token, '/api/admin/packs', {
    method: 'POST',
    body: JSON.stringify({ name: 'Nope', credits: 1, price_cents: 100 }),
  });
  assert.equal(res.status, 403);
});

// ============================================================
// member storefront
// ============================================================

test('GET /api/packs lists active packs only, requires auth', { skip }, async () => {
  const active = await createPack({ name: `Active ${randomUUID().slice(0, 6)}` });
  const inactive = await createPack({ name: `Hidden ${randomUUID().slice(0, 6)}` });
  await adminFetch(`/api/admin/packs/${inactive.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });

  const member = await newMember();
  const res = await tokenFetch(member.token, '/api/packs');
  assert.equal(res.status, 200);
  const { packs } = await res.json();
  assert.ok(packs.some((p) => p.id === active.id));
  assert.ok(!packs.some((p) => p.id === inactive.id));
  // Storefront shape: no created_at/updated_at noise, price + credits.
  const row = packs.find((p) => p.id === active.id);
  assert.deepEqual(Object.keys(row).sort(), ['credits', 'id', 'name', 'price_cents']);

  const anon = await fetch(`${baseUrl}/api/packs?tenant=${TENANT}`);
  assert.equal(anon.status, 401);
});

test('POST /api/packs/:id/checkout: 404 unknown, 409 deactivated, 403 non-member', { skip }, async () => {
  const member = await newMember();
  const body = JSON.stringify({
    success_url: 'https://example.com/plans?pack_success=1',
    cancel_url: 'https://example.com/plans',
  });

  const unknown = await tokenFetch(member.token, `/api/packs/${randomUUID()}/checkout`, {
    method: 'POST',
    body,
  });
  assert.equal(unknown.status, 404);

  const malformed = await tokenFetch(member.token, `/api/packs/nope/checkout`, {
    method: 'POST',
    body,
  });
  assert.equal(malformed.status, 404);

  const pack = await createPack();
  await adminFetch(`/api/admin/packs/${pack.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
  const inactive = await tokenFetch(member.token, `/api/packs/${pack.id}/checkout`, {
    method: 'POST',
    body,
  });
  assert.equal(inactive.status, 409);

  // Admin token has no member identity → 403.
  const admin = await adminFetch(`/api/packs/${pack.id}/checkout`, {
    method: 'POST',
    body,
  });
  assert.equal(admin.status, 403);
});

test('checkout mints a mode=payment session with the pack_purchase metadata bridge', { skip }, async () => {
  const pack = await createPack({ credits: 12, price_cents: 11000 });
  const member = await newMember();

  const res = await tokenFetch(member.token, `/api/packs/${pack.id}/checkout`, {
    method: 'POST',
    body: JSON.stringify({
      success_url: 'https://example.com/plans?pack_success=1',
      cancel_url: 'https://example.com/plans',
    }),
  });
  assert.equal(res.status, 201);
  const bodyJson = await res.json();
  assert.ok(bodyJson.url);
  assert.ok(bodyJson.session_id);

  const { session } = stripeFake.__completeCheckoutSession(
    stripe_account_id,
    bodyJson.session_id,
  );
  assert.equal(session.mode, 'payment');
  assert.equal(session.amount_total, 11000);
  assert.equal(session.customer_email, member.email);
  assert.deepEqual(session.metadata, {
    courtside_type: 'pack_purchase',
    courtside_tenant_id: tenant_id,
    courtside_pack_id: pack.id,
    courtside_member_id: member.member_id,
    courtside_credits: '12',
  });
});

// ============================================================
// webhook grant + idempotent replay + receipt email
// ============================================================

test('webhook grants pack credits (purchased_credits tracked) + sends receipt; replay is deduped', { skip }, async () => {
  const pack = await createPack({ name: 'Receipt Pack', credits: 10, price_cents: 9000 });
  const member = await newMember();

  const { res, eventId, session } = await purchasePack({ pack, member });
  assert.equal(res.status, 200);
  const resBody = await res.json();
  assert.ok(!resBody.deduped);

  const bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 10);
  assert.equal(bal.purchased_credits, 10);

  const rows = await ledgerRows(member.member_id, 'pack_purchase');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 10);
  assert.equal(rows[0].balance_after, 10);
  assert.match(rows[0].note, /Receipt Pack/);

  // Receipt email (keyless mode records it) — post-commit and
  // fire-and-forget, so poll.
  const receipt = await eventually(
    () =>
      __getSkippedEmails().find(
        (e) => e.to === member.email && /Receipt: Receipt Pack/.test(e.subject),
      ),
    'pack receipt email',
  );
  assert.match(receipt.text, /10 credits/);
  assert.match(receipt.text, /\$90\.00/);
  assert.match(receipt.text, /roll over/i);

  // Replay the SAME event id: deduped at the dispatcher, no regrant.
  const replay = await postWebhook({
    id: eventId,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: { object: session },
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deduped, true);

  assert.equal((await getBalance(member.member_id)).current_credits, 10);
  assert.equal((await ledgerRows(member.member_id, 'pack_purchase')).length, 1);
});

test('webhook with tenant mismatch or bad credits metadata grants nothing', { skip }, async () => {
  const pack = await createPack();
  const member = await newMember();

  // Tenant mismatch: metadata names a different tenant than the
  // account resolves to.
  const mismatch = await postWebhook({
    id: `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: `cs_test_${randomUUID().slice(0, 8)}`,
        mode: 'payment',
        amount_total: 9000,
        metadata: {
          courtside_type: 'pack_purchase',
          courtside_tenant_id: randomUUID(),
          courtside_pack_id: pack.id,
          courtside_member_id: member.member_id,
          courtside_credits: '10',
        },
      },
    },
  });
  assert.equal(mismatch.status, 200); // acknowledged, not applied

  // Corrupt credits snapshot.
  const badCredits = await postWebhook({
    id: `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: `cs_test_${randomUUID().slice(0, 8)}`,
        mode: 'payment',
        amount_total: 9000,
        metadata: {
          courtside_type: 'pack_purchase',
          courtside_tenant_id: tenant_id,
          courtside_pack_id: pack.id,
          courtside_member_id: member.member_id,
          courtside_credits: '-5',
        },
      },
    },
  });
  assert.equal(badCredits.status, 200);

  assert.equal(await getBalance(member.member_id), null);
  assert.equal((await ledgerRows(member.member_id, 'pack_purchase')).length, 0);
});

// ============================================================
// draw-down order
// ============================================================

test('spends drain subscription credits first, purchased credits last', { skip }, async () => {
  const member = await newMember();

  await applyChange(member.member_id, 10, 'admin_adjustment'); // subscription bucket
  await applyChange(member.member_id, 5, 'pack_purchase');     // purchased bucket
  let bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 15);
  assert.equal(bal.purchased_credits, 5);

  // Spend 8: comes entirely out of the subscription bucket.
  await applyChange(member.member_id, -8, 'admin_adjustment');
  bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 7);
  assert.equal(bal.purchased_credits, 5);

  // Spend 4 more: balance (3) dips below purchased (5) → clamp.
  await applyChange(member.member_id, -4, 'admin_adjustment');
  bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 3);
  assert.equal(bal.purchased_credits, 3);

  // A later positive non-pack change does NOT restore purchased
  // (documented v1 simplification).
  await applyChange(member.member_id, 6, 'admin_adjustment');
  bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 9);
  assert.equal(bal.purchased_credits, 3);
});

test('apply_credit_change rejects non-positive pack_purchase amounts', { skip }, async () => {
  const member = await newMember();
  await assert.rejects(
    () => applyChange(member.member_id, -1, 'pack_purchase'),
    /pack_purchase amount must be positive/,
  );
});

// ============================================================
// weekly reset preserves purchased credits
// ============================================================

test('run_weekly_credit_resets lands on credits_per_week + unspent purchased credits', { skip }, async () => {
  // Active subscriber on a 10-credits/week plan.
  const member = await newMember();
  await withTenant(async (c) => {
    const planId = (
      await c.query(
        `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
         VALUES ($1, $2, 5000, 10) RETURNING id`,
        [tenant_id, `Reset Plan ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id;
    const subId = (
      await c.query(
        `INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
         VALUES ($1, $2, 'active', now()) RETURNING id`,
        [tenant_id, member.member_id],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id)
       VALUES ($1, $2, $3)`,
      [tenant_id, subId, planId],
    );
  });

  // Week's allotment + a 5-pack, then spend 12: 15 → 3 total, 3 purchased.
  await applyChange(member.member_id, 10, 'weekly_reset');
  await applyChange(member.member_id, 5, 'pack_purchase');
  await applyChange(member.member_id, -12, 'admin_adjustment');
  let bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 3);
  assert.equal(bal.purchased_credits, 3);

  // Make the tenant due and run the resetter via the RUNTIME pool
  // (mirrors the scheduler + proves the EXECUTE grant).
  await privilegedPool.query(
    `UPDATE tenants SET last_weekly_reset_at = now() - interval '8 days'
      WHERE id = $1`,
    [tenant_id],
  );
  try {
    const r = await pool.query(`SELECT * FROM run_weekly_credit_resets()`);
    assert.ok(
      r.rows.some((row) => row.reset_tenant_id === tenant_id),
      'tenant should have been reset',
    );
  } finally {
    // Not-due again so later suite runs never touch this tenant.
    await privilegedPool.query(
      `UPDATE tenants SET last_weekly_reset_at = now() WHERE id = $1`,
      [tenant_id],
    );
  }

  // 10 (plan) + 3 (unspent purchased) = 13; purchased untouched.
  bal = await getBalance(member.member_id);
  assert.equal(bal.current_credits, 13);
  assert.equal(bal.purchased_credits, 3);

  // The reset wrote a single weekly_reset delta of +10 on top of the
  // initial allotment grant.
  const resets = await ledgerRows(member.member_id, 'weekly_reset');
  assert.deepEqual(
    resets.map((r) => ({ amount: r.amount, balance_after: r.balance_after })),
    [
      { amount: 10, balance_after: 10 },
      { amount: 10, balance_after: 13 },
    ],
  );
});
