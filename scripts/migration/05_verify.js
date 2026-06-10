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
// Counts REQUIRE the source totals. Pass them via env:
//   EXPECT_MEMBERS=412
//   EXPECT_ACTIVE_SUBS=387
//   EXPECT_TOTAL_CREDITS=18540  (sum across all members)
//   EXPECT_BOOKINGS_FUTURE=64
//
// A count check with its EXPECT_* unset or non-numeric FAILS — the
// 6:30am failure mode this guards against is "operator forgot to set
// the expectations, gate waves everything through". To consciously
// run invariants-only (e.g. on a dev box), set ALLOW_MISSING_EXPECTS=1.
//
// Invariants are absolute (don't need source numbers).
//
// This gate covers the DB. Also check 03_load's reports in
// out/load_report/ — bookings_skipped.json must be reviewed (and
// ideally empty) before flipping DNS.

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

// Count comparison against an EXPECT_* env var. Missing/garbage env
// is a FAILURE unless ALLOW_MISSING_EXPECTS=1 explicitly downgrades
// it to a noted skip.
function compareExpected(name, actual) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    if (process.env.ALLOW_MISSING_EXPECTS === '1') {
      return { ok: true, actual, note: `${name} not set; skipped via ALLOW_MISSING_EXPECTS=1` };
    }
    return { ok: false, actual, reason: `${name} not set — set it from source counts (or ALLOW_MISSING_EXPECTS=1 to run invariants only)` };
  }
  const expected = Number(raw);
  if (!Number.isFinite(expected)) {
    return { ok: false, actual, reason: `${name}=${JSON.stringify(raw)} is not a number` };
  }
  return { ok: actual === expected, actual, expected };
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
      return compareExpected('EXPECT_MEMBERS', r.rows[0].n);
    }),

    check('active subscriptions count matches expected', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM subscriptions
          WHERE tenant_id = $1 AND status IN ('active', 'past_due', 'incomplete')`,
        [tenant_id],
      );
      return compareExpected('EXPECT_ACTIVE_SUBS', r.rows[0].n);
    }),

    check('total credits across all members matches expected', async () => {
      const r = await pool.query(
        `SELECT COALESCE(sum(current_credits), 0)::int AS total
           FROM credit_balances WHERE tenant_id = $1`,
        [tenant_id],
      );
      return compareExpected('EXPECT_TOTAL_CREDITS', r.rows[0].total);
    }),

    check('future confirmed bookings count matches expected', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM bookings
          WHERE tenant_id = $1
            AND status = 'confirmed'
            AND start_time > now()`,
        [tenant_id],
      );
      return compareExpected('EXPECT_BOOKINGS_FUTURE', r.rows[0].n);
    }),

    // Invariant: every NON-ZERO credit_balance has a latest ledger
    // row whose balance_after equals it. IS DISTINCT FROM (not a
    // COALESCE fallback) so a missing ledger row is a FAILURE — a
    // member whose balance loaded but whose ledger row didn't is the
    // exact partial-failure this gate exists to catch. Zero balances
    // legitimately have no ledger row (the ledger CHECK rejects
    // amount = 0); they're covered by the next check.
    check('non-zero credit_balances have matching latest ledger row', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM credit_balances cb
          WHERE cb.tenant_id = $1
            AND cb.current_credits <> 0
            AND cb.current_credits IS DISTINCT FROM (
              SELECT balance_after FROM credit_ledger_entries cle
                WHERE cle.tenant_id = cb.tenant_id
                  AND cle.member_id = cb.member_id
               ORDER BY entry_number DESC LIMIT 1
            )`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Invariant: wherever ledger rows DO exist, the latest one agrees
    // with the balance (catches zero balances whose ledger says
    // otherwise).
    check('no balance disagrees with its latest ledger row', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad
           FROM credit_balances cb
           JOIN LATERAL (
             SELECT balance_after FROM credit_ledger_entries cle
              WHERE cle.tenant_id = cb.tenant_id
                AND cle.member_id = cb.member_id
              ORDER BY entry_number DESC LIMIT 1
           ) latest ON true
          WHERE cb.tenant_id = $1
            AND cb.current_credits <> latest.balance_after`,
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

    // ...and that open period must join to a real plan. This is the
    // exact join handleInvoicePaymentSucceeded uses to grant weekly
    // credits — if it comes back empty the renewal grants NOTHING,
    // silently. The previous check counts periods; this one proves
    // the plan on the other end exists.
    check('active subscriptions resolve to a plan via open plan_period', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM subscriptions s
          WHERE s.tenant_id = $1
            AND s.status IN ('active', 'past_due', 'incomplete')
            AND NOT EXISTS (
              SELECT 1
                FROM subscription_plan_periods spp
                JOIN plans p
                  ON p.tenant_id = spp.tenant_id
                 AND p.id = spp.plan_id
               WHERE spp.tenant_id = s.tenant_id
                 AND spp.subscription_id = s.id
                 AND spp.ended_at IS NULL
            )`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Cancelled subscriptions must NOT have an open plan period — a
    // dead sub that still "has a plan" confuses webhook handlers and
    // the backfill's plan metadata.
    check('cancelled subscriptions have no open plan_period', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM subscriptions s
          WHERE s.tenant_id = $1
            AND s.status = 'cancelled'
            AND EXISTS (
              SELECT 1 FROM subscription_plan_periods spp
                WHERE spp.tenant_id = s.tenant_id
                  AND spp.subscription_id = s.id
                  AND spp.ended_at IS NULL
            )`,
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

    // Stripe connection exists + is charges-enabled. (03_load no
    // longer fabricates charges_enabled=true for missing values, so
    // this check is meaningful.)
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
  process.stdout.write('\nAll checks PASSED. Review out/load_report/*.json, then flip Stripe webhook URL + DNS.\n');
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
