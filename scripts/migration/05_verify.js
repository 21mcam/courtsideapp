// 05_verify.js — post-load sanity checks against the Courtside DB.
//
// Runs read-only SELECTs and prints PASS/FAIL for each. Designed to
// run as the gate between "load complete" and "Stripe webhook URL
// flipped" during cutover. If any check fails, abort the cutover
// and investigate.
//
// Two classes of checks:
//   * Counts — are the right numbers of rows there?
//   * Invariants — do internal consistency rules hold?
//
// Counts depend on knowing the source totals. Pass them via env:
//   EXPECT_MEMBERS=412
//   EXPECT_ACTIVE_SUBS=387
//   EXPECT_TOTAL_CREDITS=18540  (sum across all members)
//   EXPECT_BOOKINGS_FUTURE=64
//
// Invariants are absolute (don't need source numbers).

import { banner, info, error as logError } from './shared/log.js';
import { pool } from './shared/db.js';

let failed = 0;

function check(name, fn) {
  return fn().then(
    (result) => {
      if (result.ok) {
        info(`PASS · ${name}`, result);
      } else {
        failed += 1;
        logError(`FAIL · ${name}`, result);
      }
    },
    (err) => {
      failed += 1;
      logError(`ERROR · ${name}`, { error: err.message });
    },
  );
}

async function main() {
  banner('05 verify');

  const tenant_id = process.env.MIGRATION_TENANT_ID;
  if (!tenant_id) {
    throw new Error('MIGRATION_TENANT_ID required');
  }

  await Promise.all([
    check('members count matches expected', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM members WHERE tenant_id = $1`,
        [tenant_id],
      );
      const expected = numFromEnv('EXPECT_MEMBERS');
      if (expected == null) return { ok: true, count: r.rows[0].n, note: 'EXPECT_MEMBERS not set; skipping numeric compare' };
      return { ok: r.rows[0].n === expected, count: r.rows[0].n, expected };
    }),

    check('active subscriptions count matches expected', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM subscriptions
          WHERE tenant_id = $1 AND status IN ('active', 'past_due', 'incomplete')`,
        [tenant_id],
      );
      const expected = numFromEnv('EXPECT_ACTIVE_SUBS');
      if (expected == null) return { ok: true, count: r.rows[0].n, note: 'EXPECT_ACTIVE_SUBS not set' };
      return { ok: r.rows[0].n === expected, count: r.rows[0].n, expected };
    }),

    check('total credits across all members matches expected', async () => {
      const r = await pool.query(
        `SELECT COALESCE(sum(current_credits), 0)::int AS total
           FROM credit_balances WHERE tenant_id = $1`,
        [tenant_id],
      );
      const expected = numFromEnv('EXPECT_TOTAL_CREDITS');
      if (expected == null) return { ok: true, total: r.rows[0].total, note: 'EXPECT_TOTAL_CREDITS not set' };
      return { ok: r.rows[0].total === expected, total: r.rows[0].total, expected };
    }),

    check('future confirmed bookings count matches expected', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM bookings
          WHERE tenant_id = $1
            AND status = 'confirmed'
            AND start_time > now()`,
        [tenant_id],
      );
      const expected = numFromEnv('EXPECT_BOOKINGS_FUTURE');
      if (expected == null) return { ok: true, count: r.rows[0].n, note: 'EXPECT_BOOKINGS_FUTURE not set' };
      return { ok: r.rows[0].n === expected, count: r.rows[0].n, expected };
    }),

    // Invariant: every credit_balance.current_credits matches the
    // latest ledger row's balance_after for that member. This is the
    // ledger contract — if it's violated the import is broken.
    check('credit_balance == latest ledger balance_after', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM credit_balances cb
          WHERE cb.tenant_id = $1
            AND cb.current_credits <> COALESCE((
              SELECT balance_after FROM credit_ledger_entries cle
                WHERE cle.tenant_id = cb.tenant_id
                  AND cle.member_id = cb.member_id
               ORDER BY entry_number DESC LIMIT 1
            ), cb.current_credits)`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Every active subscription has exactly one open plan period.
    check('active subscriptions have exactly one open plan_period', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM subscriptions s
          WHERE s.tenant_id = $1
            AND s.status IN ('active', 'past_due', 'incomplete')
            AND (
              SELECT count(*) FROM subscription_plan_periods spp
                WHERE spp.tenant_id = s.tenant_id
                  AND spp.subscription_id = s.id
                  AND spp.ended_at IS NULL
            ) <> 1`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Every member has at most one non-terminal subscription.
    check('partial unique subscriptions_one_active_per_member upheld', async () => {
      const r = await pool.query(
        `SELECT member_id, count(*)::int AS n
           FROM subscriptions
          WHERE tenant_id = $1
            AND status IN ('pending', 'active', 'past_due', 'incomplete')
          GROUP BY member_id
         HAVING count(*) > 1`,
        [tenant_id],
      );
      return { ok: r.rows.length === 0, violations: r.rows };
    }),

    // No bookings with both member_id and customer_* set (mutual
    // exclusion CHECK is in the schema; this is belt-and-suspenders).
    check('booking identity is member XOR customer', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM bookings
          WHERE tenant_id = $1
            AND member_id IS NOT NULL
            AND (customer_first_name IS NOT NULL OR customer_email IS NOT NULL)`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Every active subscription has a stripe_subscription_id.
    check('active subscriptions have stripe_subscription_id', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS missing FROM subscriptions
          WHERE tenant_id = $1
            AND status IN ('active', 'past_due', 'incomplete')
            AND stripe_subscription_id IS NULL`,
        [tenant_id],
      );
      return { ok: r.rows[0].missing === 0, missing: r.rows[0].missing };
    }),

    // Stripe connection exists + is charges-enabled.
    check('tenant Stripe connection is charges-enabled', async () => {
      const r = await pool.query(
        `SELECT charges_enabled FROM stripe_connections WHERE tenant_id = $1`,
        [tenant_id],
      );
      if (r.rows.length === 0) return { ok: false, reason: 'no stripe_connections row' };
      return { ok: r.rows[0].charges_enabled === true, charges_enabled: r.rows[0].charges_enabled };
    }),
  ]);

  await pool.end();

  if (failed > 0) {
    process.stderr.write(`\n${failed} verification check(s) FAILED — abort the cutover.\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll checks PASSED. Safe to flip Stripe webhook URL + DNS.\n');
}

function numFromEnv(name) {
  const v = process.env[name];
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
