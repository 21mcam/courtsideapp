// DB helpers for migration scripts.
//
// Migration scripts run as a privileged role (BYPASSRLS or postgres),
// not as `app_runtime`. Two reasons:
//
//   1. We INSERT into tables with FORCE ROW LEVEL SECURITY across many
//      tenants without setting the GUC per-row. The privileged role
//      sidesteps RLS so the import can run as one logical operation.
//
//   2. We seed `credit_ledger_entries` directly with reason='migration'.
//      The runtime role has SELECT but not INSERT on that table
//      (migration 011/014 privilege boundary). Bypass via privileged
//      pool is the explicit escape hatch documented in CLAUDE.md.
//
// Privileged credentials live in MIGRATION_DATABASE_URL (NOT the
// runtime DATABASE_URL). Set it to the postgres-role connection
// string for the duration of the cutover, unset afterwards.

import 'dotenv/config';
import pg from 'pg';

if (!process.env.MIGRATION_DATABASE_URL) {
  throw new Error(
    'MIGRATION_DATABASE_URL required (privileged postgres-role connection)',
  );
}

export const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  max: 4, // small pool — we're not running concurrent imports
});

pool.on('error', (err) => {
  console.error('migration pg pool error:', err);
});

// Run a callback inside one transaction. Rolls back on throw.
export async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
