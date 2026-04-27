// The load-bearing privilege smoke test. Asserts that the connection
// described by DATABASE_URL is a non-superuser, non-BYPASSRLS role
// (i.e. app_runtime, not postgres) and that migration 011's grant
// boundary is intact:
//
//   * runtime CANNOT read tenants.* (REVOKE in 011 must be in place)
//   * runtime CAN read tenant_lookup view (GRANT in 011 must be in place)
//   * runtime CAN use the credit-ledger sequence
//     (GRANT USAGE ON ALL SEQUENCES in 011 must be in place)
//
// Runs locally via `npm test` — uses the live Supabase DB through the
// pooler. All assertions are read-only or harmlessly advance a sequence
// (gaps in entry_number are allowed).
//
// Runs in CI (Checkpoint H) against a disposable Postgres service
// container that has just replayed migrations 001–011. Same code,
// different DB.
//
// The "connected role" guard at the top of the suite is critical: if
// DATABASE_URL is misconfigured to use postgres / superuser, the
// privilege tests below would silently pass (postgres can read
// everything). The guard fails loud in that case.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import pg from 'pg';

let pool;

before(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must be set to run the privilege smoke test ' +
        '(point it at the runtime role, not postgres)',
    );
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

after(async () => {
  await pool?.end();
});

test('connected role is not a superuser and not BYPASSRLS', async () => {
  const result = await pool.query(`
    SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
     WHERE rolname = current_user
  `);
  assert.equal(result.rows.length, 1, 'current_user should resolve to one row in pg_roles');
  const role = result.rows[0];
  assert.equal(
    role.rolsuper,
    false,
    `${role.rolname} is a superuser — DATABASE_URL must point at app_runtime, not a privileged role`,
  );
  assert.equal(
    role.rolbypassrls,
    false,
    `${role.rolname} has BYPASSRLS — DATABASE_URL must point at app_runtime, not a privileged role`,
  );
});

test('runtime role cannot SELECT from tenants (privilege boundary)', async () => {
  await assert.rejects(
    () => pool.query('SELECT platform_stripe_customer_id FROM tenants LIMIT 1'),
    (err) => {
      // 42501 = insufficient_privilege ("permission denied").
      // If you see ANY other code (or no error at all), migration 011's
      // REVOKE on tenants is missing or has been regressed.
      assert.equal(
        err.code,
        '42501',
        `expected 42501 (insufficient_privilege), got ${err.code}: ${err.message}`,
      );
      return true;
    },
    'app_runtime must NOT be able to SELECT from tenants — REVOKE in migration 011 missing or regressed',
  );
});

test('runtime role can SELECT from tenant_lookup view', async () => {
  // Result row count doesn't matter — we're proving the GRANT works,
  // not that the table has data. Empty tenants table is fine.
  const result = await pool.query(
    'SELECT id, subdomain, name, timezone, is_billing_ok FROM tenant_lookup LIMIT 1',
  );
  assert.ok(Array.isArray(result.rows), 'expected a rows array from tenant_lookup');
});

test('runtime role can use the credit-ledger sequence', async () => {
  // GRANT USAGE, SELECT ON ALL SEQUENCES from migration 011. Without
  // it, any INSERT into credit_ledger_entries fails at runtime with
  // "permission denied for sequence credit_ledger_entries_entry_number_seq".
  // nextval advances the sequence — harmless, gaps in entry_number
  // are allowed by design.
  const result = await pool.query(
    "SELECT nextval('credit_ledger_entries_entry_number_seq') AS n",
  );
  // pg returns bigint as a string by default. Either way we just want
  // a non-null value.
  assert.ok(
    result.rows[0]?.n != null,
    'nextval should return a value; got null/undefined',
  );
});
