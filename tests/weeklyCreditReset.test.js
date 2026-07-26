// Weekly credit reset tests — run_weekly_credit_resets() (migration 022).
//
// The core semantic under test: every Monday 00:00 in the TENANT's
// timezone, each member with an ACTIVE subscription has their balance
// SET (not added) to their plan's credits_per_week, through
// apply_credit_change (reason 'weekly_reset') so the ledger invariant
// holds. Idempotent per tenant-week via tenants.last_weekly_reset_at.
//
// Coverage:
//   1. SET semantics: above-allotment balances reset DOWN,
//      below-allotment reset UP, exact-allotment writes no ledger row;
//      past_due / cancelled / no-subscription members are skipped.
//   2. Idempotency: an immediate second run is a no-op (no new ledger
//      rows, last_weekly_reset_at untouched).
//   3. Tenant-timezone boundary: two tenants in far-apart timezones
//      (UTC+14 vs UTC-11) with the SAME last_weekly_reset_at instant
//      get different due-ness, because Monday 00:00 is evaluated on
//      each tenant's own local clock.
//
// All function invocations go through the runtime pool (app_runtime),
// which doubles as the EXECUTE-grant check — the Node fallback
// scheduler in src/server.js calls it exactly this way.
//
// Isolation note: the function loops ALL tenants, but every tenant
// created by other test files carries last_weekly_reset_at DEFAULT
// now() and is therefore never due — only the tenants this file
// explicitly backdates get touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { pool } from '../src/db/pool.js';

const TENANT_A = 'verify-weekly-reset-a';
const TZ_A = 'Pacific/Kiritimati'; // UTC+14 — earliest clock on Earth
const TENANT_B = 'verify-weekly-reset-b';
const TZ_B = 'Pacific/Pago_Pago'; // UTC-11 — 25 hours behind Kiritimati

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let privilegedPool;
let tenant_a_id;
let tenant_b_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Weekly Reset A', $2), ($3, 'Weekly Reset B', $4)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT_A, TZ_A, TENANT_B, TZ_B],
  );
  const t = await privilegedPool.query(
    `SELECT subdomain, id FROM tenants WHERE subdomain IN ($1, $2)`,
    [TENANT_A, TENANT_B],
  );
  for (const row of t.rows) {
    if (row.subdomain === TENANT_A) tenant_a_id = row.id;
    else tenant_b_id = row.id;
  }
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain IN ($1, $2)`,
      [TENANT_A, TENANT_B],
    );
    await privilegedPool.end();
  }
  await pool.end();
});

// ============================================================
// helpers
// ============================================================

// Run a callback on a privileged client with the tenant GUC set.
async function withTenant(tenantId, fn) {
  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
      tenantId,
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

// Member + plan (+ optionally a subscription with a plan period).
// status=null seeds no subscription at all.
async function seedMember(tenantId, { credits_per_week, status = 'active' }) {
  return withTenant(tenantId, async (c) => {
    const memberId = (
      await c.query(
        `INSERT INTO members (tenant_id, email, first_name, last_name)
         VALUES ($1, $2, 'Reset', 'Member') RETURNING id`,
        [tenantId, `m-${randomUUID()}@example.com`],
      )
    ).rows[0].id;
    if (status === null) return { memberId };

    const planId = (
      await c.query(
        `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
         VALUES ($1, $2, 5000, $3) RETURNING id`,
        [tenantId, `Plan ${randomUUID().slice(0, 6)}`, credits_per_week],
      )
    ).rows[0].id;
    const subId = (
      await c.query(
        `INSERT INTO subscriptions
           (tenant_id, member_id, status, activated_at, ended_at)
         VALUES ($1, $2, $3, now() - interval '30 days',
                 CASE WHEN $3 = 'cancelled' THEN now() ELSE NULL END)
         RETURNING id`,
        [tenantId, memberId, status],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO subscription_plan_periods
         (tenant_id, subscription_id, plan_id, started_at)
       VALUES ($1, $2, $3, now() - interval '30 days')`,
      [tenantId, subId, planId],
    );
    return { memberId, planId, subId };
  });
}

async function grantCredits(tenantId, memberId, amount) {
  await withTenant(tenantId, (c) =>
    c.query(
      `SELECT apply_credit_change($1, $2, $3, 'admin_adjustment',
                                  NULL, NULL, NULL, NULL)`,
      [tenantId, memberId, amount],
    ),
  );
}

async function getBalance(tenantId, memberId) {
  const r = await privilegedPool.query(
    `SELECT current_credits, last_reset_at FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenantId, memberId],
  );
  return r.rows[0] ?? null;
}

async function weeklyResetEntries(memberId) {
  const r = await privilegedPool.query(
    `SELECT amount, balance_after FROM credit_ledger_entries
      WHERE member_id = $1 AND reason = 'weekly_reset'
      ORDER BY entry_number ASC`,
    [memberId],
  );
  return r.rows;
}

// The most recent Monday 00:00 on the given timezone's clock, as an
// absolute instant — same expression the SQL function uses.
async function weekStart(tz) {
  const r = await privilegedPool.query(
    `SELECT (date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1) AS ws`,
    [tz],
  );
  return new Date(r.rows[0].ws);
}

async function setLastReset(tenantId, value) {
  await privilegedPool.query(
    `UPDATE tenants SET last_weekly_reset_at = $2 WHERE id = $1`,
    [tenantId, value],
  );
}

async function getLastReset(tenantId) {
  const r = await privilegedPool.query(
    `SELECT last_weekly_reset_at FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return new Date(r.rows[0].last_weekly_reset_at);
}

// Invoke via the RUNTIME pool — proves the app_runtime EXECUTE grant
// and mirrors the Node fallback scheduler exactly.
async function runResets() {
  const r = await pool.query(`SELECT * FROM run_weekly_credit_resets()`);
  return r.rows;
}

// ============================================================
// 1. SET semantics + status filtering
// ============================================================

test('reset SETS balances to the plan allotment; inactive/no-sub members skipped', { skip }, async () => {
  const over = await seedMember(tenant_a_id, { credits_per_week: 10 });
  const under = await seedMember(tenant_a_id, { credits_per_week: 10 });
  const exact = await seedMember(tenant_a_id, { credits_per_week: 10 });
  const pastDue = await seedMember(tenant_a_id, {
    credits_per_week: 10,
    status: 'past_due',
  });
  const cancelled = await seedMember(tenant_a_id, {
    credits_per_week: 10,
    status: 'cancelled',
  });
  const noSub = await seedMember(tenant_a_id, {
    credits_per_week: 0,
    status: null,
  });

  await grantCredits(tenant_a_id, over.memberId, 25);
  await grantCredits(tenant_a_id, under.memberId, 3);
  await grantCredits(tenant_a_id, exact.memberId, 10);
  await grantCredits(tenant_a_id, pastDue.memberId, 4);
  await grantCredits(tenant_a_id, cancelled.memberId, 4);
  await grantCredits(tenant_a_id, noSub.memberId, 4);

  // Make tenant A due (well past any Monday boundary).
  await setLastReset(tenant_a_id, new Date(Date.now() - 8 * 86400 * 1000));

  const rows = await runResets();
  const aRow = rows.find((r) => r.reset_tenant_id === tenant_a_id);
  assert.ok(aRow, 'tenant A should have been reset');
  // over + under + exact are the only ACTIVE subscribers.
  assert.equal(aRow.members_reset, 3);

  // Above allotment → reset DOWN (non-rollover; admin grants included).
  const overBal = await getBalance(tenant_a_id, over.memberId);
  assert.equal(overBal.current_credits, 10);
  assert.ok(overBal.last_reset_at, 'weekly_reset should stamp last_reset_at');
  assert.deepEqual(await weeklyResetEntries(over.memberId), [
    { amount: -15, balance_after: 10 },
  ]);

  // Below allotment → reset UP.
  assert.equal((await getBalance(tenant_a_id, under.memberId)).current_credits, 10);
  assert.deepEqual(await weeklyResetEntries(under.memberId), [
    { amount: 7, balance_after: 10 },
  ]);

  // Exactly at allotment → balance kept, NO ledger row (amount 0 is
  // never written; the ledger stays meaningful).
  assert.equal((await getBalance(tenant_a_id, exact.memberId)).current_credits, 10);
  assert.equal((await weeklyResetEntries(exact.memberId)).length, 0);

  // past_due / cancelled / no-subscription: untouched.
  for (const m of [pastDue, cancelled, noSub]) {
    assert.equal((await getBalance(tenant_a_id, m.memberId)).current_credits, 4);
    assert.equal((await weeklyResetEntries(m.memberId)).length, 0);
  }

  // Bookkeeping stamp advanced to ~now.
  const last = await getLastReset(tenant_a_id);
  assert.ok(
    Date.now() - last.getTime() < 60_000,
    'last_weekly_reset_at should be stamped to the run time',
  );
});

// ============================================================
// 2. Idempotency
// ============================================================

test('repeated runs within the same tenant-week are no-ops', { skip }, async () => {
  const m = await seedMember(tenant_a_id, { credits_per_week: 5 });
  await setLastReset(tenant_a_id, new Date(Date.now() - 8 * 86400 * 1000));

  const firstRows = await runResets();
  assert.ok(firstRows.some((r) => r.reset_tenant_id === tenant_a_id));
  assert.equal((await getBalance(tenant_a_id, m.memberId)).current_credits, 5);
  assert.equal((await weeklyResetEntries(m.memberId)).length, 1);
  const stamp = await getLastReset(tenant_a_id);

  // Immediate second run: tenant no longer due — nothing changes.
  const secondRows = await runResets();
  assert.ok(
    !secondRows.some((r) => r.reset_tenant_id === tenant_a_id),
    'second run must not touch tenant A again',
  );
  assert.equal((await weeklyResetEntries(m.memberId)).length, 1);
  assert.equal(
    (await getLastReset(tenant_a_id)).getTime(),
    stamp.getTime(),
    'last_weekly_reset_at must not be re-stamped',
  );
});

// ============================================================
// 3. Tenant-timezone Monday boundary
// ============================================================

test('Monday 00:00 boundary is evaluated on each TENANT\'s local clock', { skip }, async () => {
  const wsA = await weekStart(TZ_A); // Kiritimati's most recent local Monday 00:00
  const wsB = await weekStart(TZ_B); // Pago Pago's — a different absolute instant
  assert.notEqual(
    wsA.getTime(),
    wsB.getTime(),
    'the two timezones must have distinct Monday-boundary instants',
  );

  // Same last-reset INSTANT for both tenants, chosen strictly between
  // the two boundaries: the tenant with the LATER local boundary has
  // crossed Monday since then (due); the other has not (not due).
  // Only a per-tenant-timezone evaluation produces that split.
  const mid = new Date((wsA.getTime() + wsB.getTime()) / 2);
  const dueTenant = wsA > wsB ? tenant_a_id : tenant_b_id;
  const notDueTenant = wsA > wsB ? tenant_b_id : tenant_a_id;

  const dueMember = await seedMember(dueTenant, { credits_per_week: 7 });
  const notDueMember = await seedMember(notDueTenant, { credits_per_week: 7 });
  await grantCredits(dueTenant, dueMember.memberId, 2);
  await grantCredits(notDueTenant, notDueMember.memberId, 2);

  await setLastReset(dueTenant, mid);
  await setLastReset(notDueTenant, mid);

  const rows = await runResets();
  assert.ok(
    rows.some((r) => r.reset_tenant_id === dueTenant),
    'tenant past its local Monday boundary must reset',
  );
  assert.ok(
    !rows.some((r) => r.reset_tenant_id === notDueTenant),
    'tenant not yet past its local Monday boundary must be skipped',
  );

  assert.equal(
    (await getBalance(dueTenant, dueMember.memberId)).current_credits,
    7,
    'due tenant member reset to allotment',
  );
  assert.equal(
    (await getBalance(notDueTenant, notDueMember.memberId)).current_credits,
    2,
    'not-due tenant member untouched',
  );

  // Leave both tenants not-due so later runs (from any test) no-op.
  await setLastReset(dueTenant, new Date());
  await setLastReset(notDueTenant, new Date());
});
