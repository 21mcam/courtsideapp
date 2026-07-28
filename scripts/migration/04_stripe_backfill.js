// 04_stripe_backfill.js — adds courtside_* metadata to existing
// Stripe Customers + Subscriptions on Momentum's connected account.
//
// Why: migrated subscriptions were created by Momentum's old code and
// carry no courtside_* metadata. The RECURRING credit path doesn't
// need it — handleInvoicePaymentSucceeded resolves member + plan from
// our DB by stripe_subscription_id — but checkout.session.completed
// and any future code that routes by metadata does, and having the
// Courtside ids on the Stripe objects makes manual reconciliation
// (Stripe dashboard ↔ Courtside DB) possible at 6:30am. Cheap
// insurance; not the thing keeping weekly credits alive (that's the
// subscriptions + open plan_period rows from 03_load, gated by
// 05_verify's plan-period-join check).
//
// Strategy:
//   1. List all Courtside subscriptions with stripe ids.
//   2. Update the Stripe Subscription's metadata with
//      courtside_tenant_id + courtside_member_id + courtside_plan_id.
//   3. Same for the customer (less critical but cleaner).
//
// Idempotent: setting metadata that's already present is a no-op
// from Stripe's perspective. Safe to rerun.
//
// Failure policy: per-subscription errors are retried (with backoff
// on rate limits), then recorded. ANY unrecovered failure makes the
// script exit 1 — a backfill that silently half-succeeded must not
// look like a green step in the cutover run.

import { banner, info, warn, error as logError } from './shared/log.js';
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
  const failures = [];
  for (const row of subs.rows) {
    const meta = {
      courtside_tenant_id: tenant_id,
      courtside_member_id: row.member_id,
      ...(row.plan_id ? { courtside_plan_id: row.plan_id } : {}),
    };
    try {
      await withStripeRetry(() =>
        stripe.subscriptions.update(
          row.stripe_subscription_id,
          { metadata: meta },
          { stripeAccount },
        ),
      );
      if (row.stripe_customer_id) {
        await withStripeRetry(() =>
          stripe.customers.update(
            row.stripe_customer_id,
            {
              metadata: {
                courtside_tenant_id: tenant_id,
                courtside_member_id: row.member_id,
              },
            },
            { stripeAccount },
          ),
        );
      }
      updated += 1;
    } catch (err) {
      // Keep going so one bad row doesn't kill the batch — but record
      // it and fail the run at the end.
      failures.push({
        stripe_subscription_id: row.stripe_subscription_id,
        error: err.message,
      });
      warn('backfill error', {
        stripe_subscription_id: row.stripe_subscription_id,
        error: err.message,
      });
    }
  }

  info('backfill done', { updated, failed: failures.length, total: subs.rows.length });
  await pool.end();

  if (failures.length > 0) {
    logError('backfill INCOMPLETE — rerun after investigating', {
      failed: failures.length,
      failures: failures.slice(0, 20),
    });
    process.exitCode = 1;
  }
}

// Retry rate-limited Stripe calls with exponential backoff. Other
// errors propagate immediately — a missing subscription won't get
// better on attempt 3.
async function withStripeRetry(fn, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const rateLimited =
        err?.type === 'StripeRateLimitError' || err?.statusCode === 429;
      if (!rateLimited || attempt >= attempts) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1);
      warn('stripe rate limit — backing off', { attempt, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
