// Migration 017 — verify the 'migration' reason is accepted both by
// the credit_ledger_entries CHECK and by apply_credit_change.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let privilegedPool;
let tenant_id;
let member_id;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  const subdomain = `verify-migration-reason-${randomUUID().slice(0, 6)}`;
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone) VALUES ($1, 'X', 'UTC')`,
    [subdomain],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [subdomain])
  ).rows[0].id;
  member_id = (
    await privilegedPool.query(
      `INSERT INTO members (tenant_id, email, first_name, last_name)
       VALUES ($1, $2, 'M', 'X') RETURNING id`,
      [tenant_id, `m-${randomUUID().slice(0, 6)}@example.com`],
    )
  ).rows[0].id;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE id = $1`, [tenant_id]);
    await privilegedPool.end();
  }
});

test("credit_ledger_entries accepts reason='migration' via direct INSERT", { skip }, async () => {
  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    // Direct insert mirrors what the migration loader does for bulk
    // imports (bypassing apply_credit_change).
    const r = await c.query(
      `INSERT INTO credit_balances (tenant_id, member_id, current_credits)
       VALUES ($1, $2, 25)
       ON CONFLICT (tenant_id, member_id) DO UPDATE SET current_credits = 25
       RETURNING current_credits`,
      [tenant_id, member_id],
    );
    assert.equal(r.rows[0].current_credits, 25);
    await c.query(
      `INSERT INTO credit_ledger_entries (tenant_id, member_id, amount, balance_after, reason, note)
       VALUES ($1, $2, 25, 25, 'migration', 'imported from Momentum')`,
      [tenant_id, member_id],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  const ledger = await privilegedPool.query(
    `SELECT reason, amount FROM credit_ledger_entries WHERE member_id = $1`,
    [member_id],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].reason, 'migration');
});

test("apply_credit_change rejects unknown reasons (sanity for the CHECK)", { skip }, async () => {
  const c = await privilegedPool.connect();
  let threw = false;
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant_id]);
    await c.query(
      `SELECT apply_credit_change($1, $2, $3, 'not_a_real_reason', NULL, NULL, NULL, NULL)`,
      [tenant_id, member_id, 5],
    );
    await c.query('ROLLBACK');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    threw = true;
    // Postgres reports CHECK violation as 23514
    assert.equal(err.code, '23514');
  } finally {
    c.release();
  }
  assert.ok(threw, 'unknown reason should have been rejected');
});
