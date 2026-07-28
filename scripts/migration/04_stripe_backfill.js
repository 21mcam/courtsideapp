// 04_stripe_backfill.js — adds courtside_* metadata to existing
// Stripe Customers + Subscriptions on Momentum's connected account.
//
// Why: our webhook handlers route events using
// session.metadata.courtside_member_id (and friends). Subscriptions
// migrated from Momentum don't have those fields — they were created
// by Momentum's old code that didn't know about Courtside.
//
// Without this backfill, the next invoice.payment_succeeded event for
// a migrated subscription has NO metadata and our handler logs +
// skips it. Members would silently stop getting weekly credits.
//
// Strategy:
//   1. List all subscriptions on Momentum's connected account.
//   2. For each, look up the Courtside subscription by
//      stripe_subscription_id.
//   3. Update the Stripe Subscription's metadata with
//      courtside_tenant_id + courtside_member_id + courtside_plan_id.
//   4. Same for the customer (less critical but cleaner).
//
// Fail-closed: per-subscription errors are collected (the batch keeps
// going so one bad row doesn't hide the rest), then every failure is
// logged and the script exits nonzero. A partial backfill must never
// report success — any subscription left without courtside_* metadata
// means that member silently stops receiving weekly credits, which is
// exactly the failure mode this script exists to prevent.
//
// Idempotent: setting metadata that's already present is a no-op
// from Stripe's perspective. Safe to rerun after fixing failures.

import { banner, info, error as logError } from './shared/log.js';
import { pool } from './shared/db.js';
import { getStripe } from '../../src/services/stripe.js';

async function main() {
  banner('04 stripe metadata backfill');

  const tenant_id = process.env.MIGRATION_TENANT_ID;
  if (!tenant_id) {
    throw new Error('MIGRATION_TENANT_ID required (the Courtside tenant id receiving the import)');
  }

  // Get the connected account id for this tenant
  const connRes = await pool.query(
    `SELECT stripe_account_id FROM stripe_connections WHERE tenant_id = $1`,
    [tenant_id],
  );
  if (connRes.rows.length === 0) {
    throw new Error(`no stripe_connections row for tenant ${tenant_id}; run 03_load first`);
  }
  const stripeAccount = connRes.rows[0].stripe_account_id;
  info('using connected account', { stripeAccount });

  const stripe = getStripe();

  // Pull every non-terminal Courtside subscription with stripe ids.
  // Terminal subscriptions (cancelled) emit no further billing
  // webhooks, so they need no metadata — and Stripe refuses the
  // metadata update on a canceled subscription anyway, which would
  // guarantee exit 1 for any tenant with churn history.
  const subs = await pool.query(
    `SELECT s.id, s.member_id, s.stripe_subscription_id, s.stripe_customer_id,
            spp.plan_id
       FROM subscriptions s
       LEFT JOIN subscription_plan_periods spp
         ON spp.tenant_id = s.tenant_id
        AND spp.subscription_id = s.id
        AND spp.ended_at IS NULL
      WHERE s.tenant_id = $1
        AND s.stripe_subscription_id IS NOT NULL
        AND s.status IN ('pending', 'active', 'past_due', 'incomplete')`,
    [tenant_id],
  );
  info('subscriptions to backfill', { count: subs.rows.length });

  let updated = 0;
  const failures = [];
  for (const row of subs.rows) {
    const meta = {
      courtside_tenant_id: tenant_id,
      courtside_member_id: row.member_id,
      ...(row.plan_id ? { courtside_plan_id: row.plan_id } : {}),
    };
    try {
      await stripe.subscriptions.update(
        row.stripe_subscription_id,
        { metadata: meta },
        { stripeAccount },
      );
      if (row.stripe_customer_id) {
        await stripe.customers.update(
          row.stripe_customer_id,
          {
            metadata: {
              courtside_tenant_id: tenant_id,
              courtside_member_id: row.member_id,
            },
          },
          { stripeAccount },
        );
      }
      updated += 1;
    } catch (err) {
      // Continue past per-subscription errors so one bad row doesn't
      // kill the batch — the operator should see EVERY failure in one
      // run, not one per rerun. But remember it: a swallowed failure
      // here means a member who silently stops getting weekly credits.
      failures.push({
        stripe_subscription_id: row.stripe_subscription_id,
        error: err.message,
      });
    }
  }
  info('backfill done', {
    updated,
    failed: failures.length,
    total: subs.rows.length,
  });
  await pool.end();

  if (failures.length > 0) {
    for (const f of failures) {
      logError('backfill failure', f);
    }
    process.stderr.write(
      `\n${failures.length} subscription(s) failed to backfill — fix and ` +
        `rerun; metadata updates are idempotent so rerunning is safe.\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
