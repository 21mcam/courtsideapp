// Stale-state cleanup — Phase 5 slice 6.
//
// Two categories of "stuck" rows accumulate as customers and members
// abandon checkout flows:
//
//   1. bookings with status='pending_payment' whose hold_expires_at
//      has passed. The pending row holds the slot under the partial
//      GiST exclusion (status <> 'cancelled'), so left alone it would
//      block any other booking on that resource for the original
//      slot. Cancel them with cancelled_by_type='system'.
//
//   2. subscriptions stuck at status='incomplete' or 'pending' more
//      than STALE_INCOMPLETE_HOURS old. The subscriptions_one_active_
//      per_member partial unique index includes 'incomplete' and
//      'pending' as non-terminal states, so a stuck row prevents the
//      member from retrying checkout. Cancel them + close the active
//      plan_period.
//
// POST /api/admin/cleanup runs both per-tenant. Admins can hit it
// manually if they see stuck state; ops should also schedule it
// nightly per tenant via cron / GitHub Actions / Supabase pg_cron.
// Cross-tenant batch runs (single super-admin call iterating all
// tenants) are a future operational layer.

const STALE_INCOMPLETE_HOURS = 24;

export async function runTenantCleanup(req, res, next) {
  try {
    const { tenant, db } = req;

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
      [tenant.id],
    );
    const bookings_cancelled = bookingsRes.rows.length;

    // 2. Cancel stale incomplete/pending subscriptions.
    //    Stripe usually fires `customer.subscription.deleted` (or
    //    moves to `incomplete_expired`) on its own at 24h, but our
    //    cleanup is the safety net. The interval is hard-coded as
    //    a literal in the SQL since Postgres doesn't accept it as
    //    a parameter — STALE_INCOMPLETE_HOURS controls the number.
    const subsRes = await db.query(
      `UPDATE subscriptions
          SET status = 'cancelled',
              ended_at = now()
        WHERE tenant_id = $1
          AND status IN ('incomplete', 'pending')
          AND created_at < now() - ($2 * interval '1 hour')
        RETURNING id`,
      [tenant.id, STALE_INCOMPLETE_HOURS],
    );
    const subscriptions_cancelled = subsRes.rows.length;

    // 3. For each cancelled subscription, close any open plan_period.
    if (subsRes.rows.length > 0) {
      await db.query(
        `UPDATE subscription_plan_periods
            SET ended_at = now()
          WHERE tenant_id = $1
            AND subscription_id = ANY($2::uuid[])
            AND ended_at IS NULL`,
        [tenant.id, subsRes.rows.map((r) => r.id)],
      );
    }

    res.json({
      bookings_cancelled,
      subscriptions_cancelled,
      stale_incomplete_hours: STALE_INCOMPLETE_HOURS,
    });
  } catch (err) {
    next(err);
  }
}
