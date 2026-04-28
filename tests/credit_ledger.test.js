// apply_credit_change tests — Phase 2, slice 1.
//
// Tests the SECURITY DEFINER function from migration 014 plus the
// privilege revocation. Every credit change in Phase 2+ goes through
// this function — so the contract here is load-bearing.
//
// Coverage:
//   1. Grant credits: balance increases, ledger entry created
//   2. Spend credits: balance decreases
//   3. Spend more than balance: 23514 (insufficient credits)
//   4. Cross-tenant: GUC mismatch with p_tenant_id rejected
//   5. Direct-INSERT into credit_ledger_entries by app_runtime
//      blocked at privilege layer (42501)
//   6. Direct-UPDATE on credit_balances by app_runtime blocked
//   7. weekly_reset reason updates last_reset_at; admin_adjustment
//      preserves it

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { pool } from '../src/db/pool.js';

const TENANT = 'verify-credit-ledger';
const OTHER_TENANT = 'verify-credit-ledger-other';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let privilegedPool;
let tenant_id;
let other_tenant_id;
let admin_user_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  // Two tenants — one for normal tests, one purely as a foil for the
  // cross-tenant assertion.
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, $2, 'America/New_York'),
            ($3, $4, 'America/New_York')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, 'Credit Ledger Tests', OTHER_TENANT, 'Other'],
  );
  const t = await privilegedPool.query(
    `SELECT subdomain, id FROM tenants WHERE subdomain IN ($1, $2)`,
    [TENANT, OTHER_TENANT],
  );
  for (const row of t.rows) {
    if (row.subdomain === TENANT) tenant_id = row.id;
    else if (row.subdomain === OTHER_TENANT) other_tenant_id = row.id;
  }

  // One user we can use as `granted_by` on adjustments. No FK, but the
  // value should be a real uuid for realistic test shape.
  const user = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, 'x', 'A', 'A') RETURNING id`,
    [tenant_id, `granter-${randomUUID()}@example.com`],
  );
  admin_user_id = user.rows[0].id;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain IN ($1, $2)`,
      [TENANT, OTHER_TENANT],
    );
    await privilegedPool.end();
  }
  await pool.end();
});

// Per-test member, so concurrent runs don't fight over balance state.
async function newMember(forTenant = tenant_id) {
  const m = await privilegedPool.query(
    `INSERT INTO members (tenant_id, email, first_name, last_name)
     VALUES ($1, $2, 'M', 'M') RETURNING id`,
    [forTenant, `m-${randomUUID()}@example.com`],
  );
  return m.rows[0].id;
}

// Calls apply_credit_change as the runtime role inside a transaction
// with the right GUC. Returns { entry_id, balance_after }.
async function applyCreditChange(
  tenantIdArg,
  memberIdArg,
  amount,
  reason,
  opts = {},
) {
  const gucTenant = opts.guc ?? tenantIdArg;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      gucTenant,
    ]);
    const result = await client.query(
      `SELECT entry_id, balance_after FROM apply_credit_change(
         $1, $2, $3, $4, $5, $6, $7, $8
       )`,
      [
        tenantIdArg,
        memberIdArg,
        amount,
        reason,
        opts.note ?? null,
        opts.grantedBy ?? null,
        opts.bookingId ?? null,
        opts.classBookingId ?? null,
      ],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

test('grant credits: balance increases, ledger entry created', { skip }, async () => {
  const member_id = await newMember();
  const result = await applyCreditChange(tenant_id, member_id, 10, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });
  assert.equal(result.balance_after, 10);
  assert.ok(result.entry_id);

  const balance = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, member_id],
  );
  assert.equal(balance.rows[0].current_credits, 10);

  const entry = await privilegedPool.query(
    `SELECT amount, balance_after, reason, granted_by
       FROM credit_ledger_entries WHERE id = $1`,
    [result.entry_id],
  );
  assert.equal(entry.rows[0].amount, 10);
  assert.equal(entry.rows[0].balance_after, 10);
  assert.equal(entry.rows[0].reason, 'admin_adjustment');
  assert.equal(entry.rows[0].granted_by, admin_user_id);
});

test('spend credits: balance decreases monotonically', { skip }, async () => {
  const member_id = await newMember();
  await applyCreditChange(tenant_id, member_id, 20, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });
  const after = await applyCreditChange(tenant_id, member_id, -7, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });
  assert.equal(after.balance_after, 13);
});

test('spend more than balance: 23514 insufficient credits', { skip }, async () => {
  const member_id = await newMember();
  await applyCreditChange(tenant_id, member_id, 5, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });
  await assert.rejects(
    () =>
      applyCreditChange(tenant_id, member_id, -100, 'admin_adjustment', {
        grantedBy: admin_user_id,
      }),
    (err) => {
      assert.equal(err.code, '23514', `expected 23514 got ${err.code}: ${err.message}`);
      return true;
    },
  );

  // Balance unchanged — the function rejected before the UPDATE.
  const balance = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, member_id],
  );
  assert.equal(balance.rows[0].current_credits, 5);
});

test('cross-tenant: GUC mismatch with p_tenant_id rejected', { skip }, async () => {
  const member_id = await newMember();
  // GUC says other tenant, p_tenant_id says first tenant. Even with a
  // valid member_id, function must refuse.
  await assert.rejects(
    () =>
      applyCreditChange(tenant_id, member_id, 5, 'admin_adjustment', {
        grantedBy: admin_user_id,
        guc: other_tenant_id,
      }),
    (err) => {
      assert.equal(err.code, '23514');
      return true;
    },
  );
});

test('runtime cannot direct-INSERT into credit_ledger_entries (42501)', { skip }, async () => {
  const member_id = await newMember();
  // Need to set GUC for RLS to even consider the row, but the privilege
  // check fires first regardless — runtime has no INSERT grant.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      tenant_id,
    ]);
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO credit_ledger_entries
             (tenant_id, member_id, amount, balance_after, reason)
           VALUES ($1, $2, 1, 1, 'manual')`,
          [tenant_id, member_id],
        ),
      (err) => {
        assert.equal(err.code, '42501', `expected 42501 got ${err.code}`);
        return true;
      },
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('runtime cannot direct-UPDATE on credit_balances (42501)', { skip }, async () => {
  const member_id = await newMember();
  await applyCreditChange(tenant_id, member_id, 5, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      tenant_id,
    ]);
    await assert.rejects(
      () =>
        client.query(
          `UPDATE credit_balances SET current_credits = 999
            WHERE tenant_id = $1 AND member_id = $2`,
          [tenant_id, member_id],
        ),
      (err) => {
        assert.equal(err.code, '42501');
        return true;
      },
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('weekly_reset updates last_reset_at; admin_adjustment preserves it', { skip }, async () => {
  const member_id = await newMember();

  // Initial reset stamps last_reset_at.
  await applyCreditChange(tenant_id, member_id, 20, 'weekly_reset');
  const r1 = await privilegedPool.query(
    `SELECT last_reset_at FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, member_id],
  );
  assert.ok(r1.rows[0].last_reset_at, 'weekly_reset should set last_reset_at');
  const stamp1 = r1.rows[0].last_reset_at;

  // Subsequent admin_adjustment must NOT bump last_reset_at — the
  // weekly job is the only thing that advances it.
  await applyCreditChange(tenant_id, member_id, 1, 'admin_adjustment', {
    grantedBy: admin_user_id,
  });
  const r2 = await privilegedPool.query(
    `SELECT last_reset_at FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, member_id],
  );
  assert.equal(
    r2.rows[0].last_reset_at.getTime(),
    stamp1.getTime(),
    'admin_adjustment must not change last_reset_at',
  );

  // Another weekly_reset DOES advance it.
  await new Promise((r) => setTimeout(r, 5));
  await applyCreditChange(tenant_id, member_id, 5, 'weekly_reset');
  const r3 = await privilegedPool.query(
    `SELECT last_reset_at FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, member_id],
  );
  assert.ok(
    r3.rows[0].last_reset_at.getTime() > stamp1.getTime(),
    'second weekly_reset should advance last_reset_at',
  );
});
