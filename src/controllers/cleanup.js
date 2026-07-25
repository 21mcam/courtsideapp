// Stale-state cleanup — Phase 5 slice 6, extended in the demo-hygiene
// slice with booking auto-completion + a scheduled cross-tenant sweep.
//
// Three categories of "stuck" rows accumulate over time:
//
//   1. bookings with status='pending_payment' whose hold_expires_at
//      has passed. The pending row holds the slot under the partial
//      GiST exclusion (status <> 'cancelled'), so left alone it would
//      block any other booking on that resource for the original
//      slot. Cancel them with cancelled_by_type='system'.
//
//   2. bookings still 'confirmed' AUTO_COMPLETE_AFTER_HOURS after
//      their end_time has passed. The booking happened; settle it to
//      'completed' (state machine: confirmed → completed). no_show
//      remains a MANUAL admin action — the sweep never marks
//      no-shows, and it never touches rows an admin already moved to
//      no_show or cancelled. The 24h grace window exists precisely so
//      staff CAN mark no-shows: front desks do an end-of-day pass, and
//      markBookingNoShow only accepts 'confirmed' rows, so completing
//      immediately at end_time would foreclose the no-show workflow.
//
//   3. subscriptions stuck at status='incomplete' or 'pending' more
//      than STALE_INCOMPLETE_HOURS old. The subscriptions_one_active_
//      per_member partial unique index includes 'incomplete' and
//      'pending' as non-terminal states, so a stuck row prevents the
//      member from retrying checkout. Cancel them + close the active
//      plan_period.
//
// Entry points:
//   * POST /api/admin/cleanup (runTenantCleanup) — manual, per-tenant,
//     kept for "something looks stuck" moments.
//   * runCleanupSweep() — cross-tenant, called every 10 minutes from
//     src/server.js under the SCHEDULER_ENABLED guard. Iterates
//     tenant_lookup and opens a per-tenant transaction with the RLS
//     GUC set, so isolation is identical to a normal request.
//     TODO: outbox/pg_cron — replace the Node interval with pg_cron
//     once enabled in Supabase (the sweep is idempotent, so both can
//     coexist during the transition).

import { pool } from '../db/pool.js';

export const STALE_INCOMPLETE_HOURS = 24;

// Grace window between a booking's end_time and the sweep settling it
// to 'completed'. Keeps the confirmed → no_show transition available
// for the front desk's end-of-day pass (see header).
export const AUTO_COMPLETE_AFTER_HOURS = 24;

// Core per-tenant cleanup. `db` must be a transaction-bound client
// with app.current_tenant_id already set (req.db in the admin route,
// or the sweep's own transaction). Idempotent: every UPDATE is
// guarded by the state it transitions FROM, so re-running is a no-op.
export async function cleanupTenantData(db, tenantId) {
  // 1. Cancel stale pending_payment bookings.
  //    cancelled_by_type='system' is allowed by the schema CHECK
  //    (member, customer, admin, system); 'admin' would require
  //    cancelled_by_user_id set, which we don't have for an
  //    automated sweep. Money fields are left as-is — the
  //    pending → cancelled transition keeps payment_status='pending'
  //    intact (still satisfies the CHECK because amount_due > 0,
  //    amount_paid = 0, amount_refunded = 0). Refund flows for
  //    "paid but cancelled" land in a future hardening pass.
  const bookingsRes = await db.query(
    `UPDATE bookings
        SET status = 'cancelled',
            cancelled_at = now(),
            cancelled_by_type = 'system',
            cancellation_reason = 'pending_payment hold expired'
      WHERE tenant_id = $1
        AND status = 'pending_payment'
        AND hold_expires_at < now()
      RETURNING id`,
    [tenantId],
  );
  const bookings_cancelled = bookingsRes.rows.length;

  // 2. Auto-complete confirmed bookings whose end_time passed more
  //    than AUTO_COMPLETE_AFTER_HOURS ago. Runs AFTER the expired-hold
  //    pass so the two never race on the same row (they can't anyway —
  //    disjoint FROM states). no_show and cancelled rows are
  //    untouched; future and recent bookings are untouched. Admins
  //    mark no-shows between start_time and the grace window closing —
  //    after that the booking is history.
  const completedRes = await db.query(
    `UPDATE bookings
        SET status = 'completed'
      WHERE tenant_id = $1
        AND status = 'confirmed'
        AND end_time <= now() - ($2 * interval '1 hour')
      RETURNING id`,
    [tenantId, AUTO_COMPLETE_AFTER_HOURS],
  );
  const bookings_completed = completedRes.rows.length;

  // 3. Cancel stale incomplete/pending subscriptions.
  //    Stripe usually fires `customer.subscription.deleted` (or
  //    moves to `incomplete_expired`) on its own at 24h, but our
  //    cleanup is the safety net.
  const subsRes = await db.query(
    `UPDATE subscriptions
        SET status = 'cancelled',
            ended_at = now()
      WHERE tenant_id = $1
        AND status IN ('incomplete', 'pending')
        AND created_at < now() - ($2 * interval '1 hour')
      RETURNING id`,
    [tenantId, STALE_INCOMPLETE_HOURS],
  );
  const subscriptions_cancelled = subsRes.rows.length;

  // 4. For each cancelled subscription, close any open plan_period.
  if (subsRes.rows.length > 0) {
    await db.query(
      `UPDATE subscription_plan_periods
          SET ended_at = now()
        WHERE tenant_id = $1
          AND subscription_id = ANY($2::uuid[])
          AND ended_at IS NULL`,
      [tenantId, subsRes.rows.map((r) => r.id)],
    );
  }

  return { bookings_cancelled, bookings_completed, subscriptions_cancelled };
}

// POST /api/admin/cleanup — manual per-tenant run.
export async function runTenantCleanup(req, res, next) {
  try {
    const counts = await cleanupTenantData(req.db, req.tenant.id);
    res.json({
      ...counts,
      stale_incomplete_hours: STALE_INCOMPLETE_HOURS,
    });
  } catch (err) {
    next(err);
  }
}

// Cross-tenant sweep for the scheduler. Each tenant gets its own
// transaction with the RLS GUC set; one tenant failing is logged and
// does not stop the others. Pass { tenantId } to scope to a single
// tenant (used by tests so a suite never mutates another suite's
// fixtures).
export async function runCleanupSweep({ tenantId } = {}) {
  const tenantsRes = tenantId
    ? await pool.query('SELECT id FROM tenant_lookup WHERE id = $1', [tenantId])
    : await pool.query('SELECT id FROM tenant_lookup');

  const results = [];
  for (const t of tenantsRes.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [t.id],
      );
      const counts = await cleanupTenantData(client, t.id);
      await client.query('COMMIT');
      results.push({ tenant_id: t.id, ...counts });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[scheduler] cleanup failed for tenant ${t.id}:`, err);
    } finally {
      client.release();
    }
  }
  return results;
}
