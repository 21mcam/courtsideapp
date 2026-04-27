// Express middleware that wraps every tenant-scoped request — including
// login and register, not just authenticated ones — in a Postgres
// transaction with `app.current_tenant_id` set as a transaction-local
// GUC. RLS policies on every tenant-scoped table reference this GUC,
// so without it queries return zero rows.
//
// Attaches `req.db` (a transaction-bound pg client). Routes use req.db
// for every query — raw `pool.query` in tenant-scoped code is a bug
// (CLAUDE.md).
//
// Mount AFTER resolveTenant. resolveTenant queries the unprivileged
// view `tenant_lookup` directly via the pool (no GUC needed), and
// populates req.tenant. This middleware then opens a tx with that
// tenant's ID as the GUC.
//
// COMMIT/ROLLBACK semantics:
//   * res.on('finish') with statusCode < 400  → COMMIT
//   * res.on('finish') with statusCode >= 400 → ROLLBACK (server errors
//     and client errors don't persist partial work)
//   * res.on('close') if response wasn't finished → ROLLBACK (client
//     dropped, error before send, etc.)
//
// KNOWN LIMITATION: 'finish' fires AFTER the response is flushed. If
// COMMIT fails (rare — typically only on connection loss), the client
// already has a success response with possibly-uncommitted data. For
// Phase 0–2 this is acceptable. Reliability-critical flows (booking
// confirmations, payment webhooks) will use the outbox pattern (TBD,
// see CLAUDE.md).

import { pool } from './pool.js';

export async function withTenantContext(req, res, next) {
  if (!req.tenant?.id) {
    return next(
      new Error('withTenantContext requires req.tenant; mount resolveTenant earlier'),
    );
  }

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    return next(err);
  }

  let finalized = false;
  const finalize = async (commit) => {
    if (finalized) return;
    finalized = true;
    try {
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      console.error(commit ? 'COMMIT failed:' : 'ROLLBACK failed:', err);
    } finally {
      client.release();
    }
  };

  res.on('finish', () => {
    finalize(res.statusCode < 400);
  });
  res.on('close', () => {
    finalize(false);
  });

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      req.tenant.id,
    ]);
    req.db = client;
    next();
  } catch (err) {
    await finalize(false);
    next(err);
  }
}
