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
// COMMIT/ROLLBACK timing — the careful bit:
//   * We override res.end to await the COMMIT/ROLLBACK BEFORE the
//     response actually flushes to the client. This means the next
//     request's read will see the prior request's writes, both in
//     real browser usage AND in-process tests. The earlier
//     res.on('finish') pattern committed AFTER flush, which only
//     worked in production because network latency hid the race.
//   * res.end stays synchronous from the caller's perspective (it
//     still returns res for chaining); the async commit+flush runs
//     on the next tick. Express handlers don't await res.send, so
//     this is invisible to them.
//   * The connection's release() runs after both commit and flush
//     have been initiated.

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
      // TODO (pre-Phase-3, before bookings/payments): a COMMIT failure
      // here currently logs and lets the prepared success response
      // flush. Rare in practice (DB connection drop mid-commit), but
      // for credits/bookings we want commit failure to surface as a
      // 500 so the client doesn't think a write succeeded when it
      // didn't. Path: capture res.json/send body before flush,
      // override status to 500 on COMMIT failure.
      console.error(commit ? 'COMMIT failed:' : 'ROLLBACK failed:', err);
    } finally {
      client.release();
    }
  };

  // Override res.end so the COMMIT/ROLLBACK lands before bytes hit
  // the wire. Without this, an await fetch() in tests can return
  // BEFORE the prior request's commit flushes, causing a read of
  // the next request to miss writes.
  const origEnd = res.end.bind(res);
  res.end = function patchedEnd(...args) {
    if (finalized) return origEnd(...args);
    const shouldCommit = res.statusCode < 400;
    // Run finalize async, then call origEnd. We return res sync so
    // Express's chaining contract is preserved. The actual flush is
    // delayed by one DB roundtrip — typically <5ms locally.
    (async () => {
      await finalize(shouldCommit);
      origEnd(...args);
    })();
    return res;
  };

  // Defensive: if the connection drops without res.end firing
  // (mid-response error, abrupt close), still ROLLBACK.
  res.on('close', () => {
    if (!finalized) {
      void finalize(false);
    }
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
