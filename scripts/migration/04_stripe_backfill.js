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
// Idempotent: setting metadata that's already present is a no-op
// from Stripe's perspective. Safe to rerun.

import { banner, info } from './shared/log.js';
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

  // Pull every Courtside subscription with stripe ids
  const subs = await pool.query(
    `SELECT s.id, s.member_id, s.stripe_subscription_id, s.stripe_customer_id,
            spp.plan_id
       FROM subscriptions s
       LEFT JOIN subscription_plan_periods spp
         ON spp.tenant_id = s.tenant_id
        AND spp.subscription_id = s.id
        AND spp.ended_at IS NULL
      WHERE s.tenant_id = $1
        AND s.stripe_subscription_id IS NOT NULL`,
    [tenant_id],
  );
  info('subscriptions to backfill', { count: subs.rows.length });

  let updated = 0;
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
      // Continue past per-subscription errors so one bad row
      // doesn't kill the batch. Log for follow-up.
      info('backfill error', {
        stripe_subscription_id: row.stripe_subscription_id,
        error: err.message,
      });
    }
  }
  info('backfill done', { updated, total: subs.rows.length });
  await pool.end();
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
