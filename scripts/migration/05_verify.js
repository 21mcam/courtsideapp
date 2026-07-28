// 05_verify.js — the fail-closed cutover gate between "load complete"
// and "Stripe webhook URL flipped".
//
// Three REQUIRED inputs. Missing, unparseable, or wrong-kind is a
// fatal error before a single check runs — an absent expectation must
// never auto-pass (that was the P0 hole in the previous version:
// unset EXPECT_* env vars silently turned the count checks into
// no-ops):
//
//   out/source/manifest.json       (kind 'source') — what 01 actually
//     snapshotted, used to prove every source member is accounted for.
//   out/transformed/manifest.json  (kind 'transformed') — carries the
//     `expected` reconciliation numbers and the `blockers` list; its
//     tenant_id must equal MIGRATION_TENANT_ID.
//   out/load_report.json           (kind 'load') — what 03 actually
//     inserted/updated/skipped, including booking overlap conflicts.
//
// Lineage chain (fatal preamble checks): the transformed manifest
// records the sha256 of the source manifest's raw bytes, and the load
// report records the sha256 of the transformed manifest's raw bytes.
// Both are recomputed here — a mismatch means a stale artifact from a
// DIFFERENT pipeline run is sitting in out/, and verifying against it
// would prove nothing.
//
// Blocker gate: any transformed-manifest blocker that was not
// acknowledged at transform time (manifest.acknowledged_blockers) and
// is not acknowledged now (MIGRATION_ACK_BLOCKERS env var) FAILs the
// run. A synthetic 'booking_conflicts' blocker is added when the load
// report recorded any overlap conflicts — skipped bookings are an
// operator decision, never a silent drop.
//
// Three classes of checks, PASS/FAIL per check so failures itemize:
//   * Reconciliation — live DB counts EXACTLY equal the transformed
//     manifest's `expected` numbers. Verify runs inside the cutover
//     freeze; exactness is the point. "Close enough" is a failed
//     migration.
//   * Invariants — internal consistency rules that hold regardless of
//     source numbers (ledger contract, subscription uniqueness, ...).
//   * Optional operator cross-checks — EXPECT_MEMBERS,
//     EXPECT_ACTIVE_SUBS, EXPECT_TOTAL_CREDITS, EXPECT_BOOKINGS_FUTURE
//     env vars: independently sourced numbers (e.g. read off the
//     Momentum admin UI) compared exactly when set, and reported as
//     SKIP — visibly, never as a silent pass — when unset.
//
// Any FAIL → exit 1 and abort the cutover. All pass → prints the
// source → loaded reconciliation table and the safe-to-flip message.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info, warn, error as logError } from './shared/log.js';
import { pool } from './shared/db.js';
import {
  MANIFEST_VERSION,
  MANIFEST_NAME,
  readManifest,
  sha256File,
} from './shared/manifest.js';

const OUT_DIR = new URL('./out/', import.meta.url).pathname;
const SOURCE_DIR = join(OUT_DIR, 'source');
const TRANSFORMED_DIR = join(OUT_DIR, 'transformed');
const LOAD_REPORT_PATH = join(OUT_DIR, 'load_report.json');

let failed = 0;

function check(name, fn) {
  return fn().then(
    (result) => {
      if (result.skip) {
        // Visible skip — an optional check that didn't run must say
        // so, not masquerade as a pass.
        warn(`SKIP · ${name}`, result);
      } else if (result.ok) {
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

  // ------------------------------------------------------------
  // Required inputs — fatal BEFORE the check battery. readManifest
  // already refuses missing files, version drift, and kind mismatch;
  // the load report isn't a manifest.json so we validate it by hand.
  // ------------------------------------------------------------
  const sourceManifest = await readManifest(SOURCE_DIR, 'source');
  const transformedManifest = await readManifest(TRANSFORMED_DIR, 'transformed');
  if (transformedManifest.tenant_id !== tenant_id) {
    throw new Error(
      `transformed manifest is for tenant ${transformedManifest.tenant_id}, ` +
        `but MIGRATION_TENANT_ID=${tenant_id} — refusing to verify against ` +
        `another tenant's expectations`,
    );
  }
  const loadReport = await readLoadReport(LOAD_REPORT_PATH);
  if (loadReport.tenant_id !== tenant_id) {
    throw new Error(
      `load report is for tenant ${loadReport.tenant_id}, but ` +
        `MIGRATION_TENANT_ID=${tenant_id} — refusing to verify a different load`,
    );
  }

  // Lineage chain — recompute each manifest's raw-byte hash and match
  // it against what the consuming stage recorded (see header). An
  // absent field fails too: a manifest predating the chain is exactly
  // the stale-artifact case the chain exists to catch.
  const sourceSha = await sha256File(join(SOURCE_DIR, MANIFEST_NAME));
  if (sourceSha !== transformedManifest.source_manifest_sha256) {
    throw new Error(
      `lineage broken: out/source/manifest.json hashes to ${sourceSha}, but the ` +
        `transformed manifest recorded ` +
        `${transformedManifest.source_manifest_sha256 ?? '(absent)'} — the ` +
        `transform consumed a different snapshot than the one on disk; ` +
        `rerun the pipeline in order (01 → 02 → 03) before verifying`,
    );
  }
  const transformedSha = await sha256File(join(TRANSFORMED_DIR, MANIFEST_NAME));
  if (transformedSha !== loadReport.transformed_manifest_sha256) {
    throw new Error(
      `lineage broken: out/transformed/manifest.json hashes to ${transformedSha}, ` +
        `but the load report recorded ` +
        `${loadReport.transformed_manifest_sha256 ?? '(absent)'} — the load ` +
        `consumed a different transform than the one on disk; rerun 03_load ` +
        `against the current transform before verifying`,
    );
  }

  const expected = transformedManifest.expected;
  if (!expected) {
    throw new Error(
      'transformed manifest has no `expected` block — 02_transform did not ' +
        'complete; nothing to reconcile against',
    );
  }

  const bookingsPhase = loadReport.phases?.bookings ?? {};
  const inserted = bookingsPhase.inserted ?? 0;
  const alreadyPresent = bookingsPhase.already_present ?? 0;
  const overlapConflicts = bookingsPhase.overlap_conflicts ?? [];

  // Acknowledgement sets — shared by the blocker gate and by the
  // active_without_stripe tolerance check below.
  const ackedAtTransform = new Set(transformedManifest.acknowledged_blockers ?? []);
  const ackedNow = new Set(
    (process.env.MIGRATION_ACK_BLOCKERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Live counts collected by the checks below, for the final
  // reconciliation table (only printed when everything passed).
  const live = { subs: {} };

  await Promise.all([
    // ----------------------------------------------------------
    // Blocker gate
    // ----------------------------------------------------------
    //
    // Blockers acked at transform time (recorded in the manifest) or
    // right now via MIGRATION_ACK_BLOCKERS pass; everything else is a
    // FAIL. Booking overlap conflicts from the load become a
    // synthetic blocker so a skipped booking can't slide through
    // just because 03 finished.
    check('blocker gate: all blockers resolved or acknowledged', async () => {
      const blockers = [...(transformedManifest.blockers ?? [])];
      if (overlapConflicts.length > 0) {
        blockers.push({
          code: 'booking_conflicts',
          count: overlapConflicts.length,
          detail_file: 'load_report.json',
        });
      }
      const unacked = blockers.filter(
        (b) => !ackedAtTransform.has(b.code) && !ackedNow.has(b.code),
      );
      return {
        ok: unacked.length === 0,
        unacknowledged: unacked.map((b) => `${b.code} (${b.count}) — ${b.detail_file}`),
      };
    }),

    // ----------------------------------------------------------
    // Reconciliation — exact equality against `expected`
    // ----------------------------------------------------------
    check('members count == expected.members', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM members WHERE tenant_id = $1`,
        [tenant_id],
      );
      live.members = r.rows[0].n;
      return { ok: r.rows[0].n === expected.members, count: r.rows[0].n, expected: expected.members };
    }),

    // Every source member accounted for, duplicate-tolerant: snapshot
    // rows must equal the kept members PLUS the rows transform DROPPED
    // as duplicate emails (exceptions.duplicate_emails; 0 when none).
    // Still catches a transform that dropped rows without recording
    // the exception.
    check('source members.json rows == kept members + dropped duplicates', async () => {
      const sourceRows = sourceManifest.files?.['members.json']?.rows;
      const dropped = transformedManifest.exceptions?.duplicate_emails ?? 0;
      return {
        ok: sourceRows === expected.members + dropped,
        source_rows: sourceRows ?? null,
        kept_members: expected.members,
        dropped_duplicates: dropped,
      };
    }),

    // Reconciliation across ALL FOUR statuses transform can emit —
    // expected.subscriptions carries active/past_due/incomplete/
    // cancelled. A missing key is a FAIL, not a zero: a transformed
    // manifest predating a key must never auto-pass its check.
    ...['active', 'past_due', 'incomplete', 'cancelled'].map((status) =>
      check(`${status} subscriptions == expected.subscriptions.${status}`, async () => {
        const want = expected.subscriptions?.[status];
        const r = await pool.query(
          `SELECT count(*)::int AS n FROM subscriptions
            WHERE tenant_id = $1 AND status = $2`,
          [tenant_id, status],
        );
        live.subs[status] = r.rows[0].n;
        return {
          ok: Number.isInteger(want) && r.rows[0].n === want,
          count: r.rows[0].n,
          expected: want ?? null,
        };
      }),
    ),

    check('sum(current_credits) == expected.total_credits', async () => {
      const r = await pool.query(
        `SELECT COALESCE(sum(current_credits), 0)::int AS total,
                count(*)::int AS n
           FROM credit_balances WHERE tenant_id = $1`,
        [tenant_id],
      );
      live.total_credits = r.rows[0].total;
      live.balance_rows = r.rows[0].n;
      return { ok: r.rows[0].total === expected.total_credits, total: r.rows[0].total, expected: expected.total_credits };
    }),

    // The P0 purchased-credit preservation check: pack credits that
    // survived Momentum must survive the import too, or the next
    // weekly reset (which sets balance = credits_per_week +
    // purchased_credits) will quietly confiscate paid-for credits.
    // Cross-checks migration 024's clamp semantics end-to-end.
    check('sum(purchased_credits) == expected.total_purchased_credits', async () => {
      const r = await pool.query(
        `SELECT COALESCE(sum(purchased_credits), 0)::int AS total
           FROM credit_balances WHERE tenant_id = $1`,
        [tenant_id],
      );
      live.total_purchased = r.rows[0].total;
      return {
        ok: r.rows[0].total === expected.total_purchased_credits,
        total: r.rows[0].total,
        expected: expected.total_purchased_credits,
      };
    }),

    // Two-sided booking accounting. Side 1: the DB holds exactly the
    // rows the load report claims to have landed (inserted on this
    // run or found already present from a previous one).
    check('migrated bookings in DB == load report inserted + already_present', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM bookings
          WHERE tenant_id = $1 AND external_id IS NOT NULL`,
        [tenant_id],
      );
      live.bookings = r.rows[0].n;
      return {
        ok: r.rows[0].n === inserted + alreadyPresent,
        count: r.rows[0].n,
        inserted,
        already_present: alreadyPresent,
      };
    }),

    // Side 2: loaded + conflicted covers every booking transform
    // produced — nothing fell between 02 and 03 uncounted.
    check('inserted + already_present + conflicts == expected.bookings.total', async () => {
      const accounted = inserted + alreadyPresent + overlapConflicts.length;
      return {
        ok: accounted === expected.bookings?.total,
        accounted,
        inserted,
        already_present: alreadyPresent,
        conflicts: overlapConflicts.length,
        expected: expected.bookings?.total,
      };
    }),

    // Transform never emits pending_payment (in-flight Stripe
    // sessions don't survive cutover), so any migrated row in that
    // state means the loader wrote something transform didn't say.
    check('migrated bookings with status pending_payment == 0', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM bookings
          WHERE tenant_id = $1
            AND external_id IS NOT NULL
            AND status = 'pending_payment'`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // Belt over the migration-024 CHECK: purchased credits are a
    // subset of the total, never a separate pool.
    check('purchased_credits <= current_credits everywhere', async () => {
      const r = await pool.query(
        `SELECT count(*)::int AS bad FROM credit_balances
          WHERE tenant_id = $1 AND purchased_credits > current_credits`,
        [tenant_id],
      );
      return { ok: r.rows[0].bad === 0, bad: r.rows[0].bad };
    }),

    // ----------------------------------------------------------
    // Invariants — hold regardless of source numbers
    // ----------------------------------------------------------

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

    // Every active subscription has a stripe_subscription_id — except
    // rows imported under an acknowledged 'active_without_stripe'
    // blocker, which are tolerated at EXACTLY the blocker's recorded
    // count (acked with a different number missing is still a FAIL);
    // unacknowledged means zero tolerance.
    check('active subscriptions have stripe_subscription_id', async () => {
      const blocker = (transformedManifest.blockers ?? []).find(
        (b) => b.code === 'active_without_stripe',
      );
      const acked =
        ackedAtTransform.has('active_without_stripe') ||
        ackedNow.has('active_without_stripe');
      const tolerated = acked && blocker ? blocker.count : 0;
      const r = await pool.query(
        `SELECT count(*)::int AS missing FROM subscriptions
          WHERE tenant_id = $1
            AND status IN ('active', 'past_due', 'incomplete')
            AND stripe_subscription_id IS NULL`,
        [tenant_id],
      );
      return {
        ok: r.rows[0].missing === tolerated,
        missing: r.rows[0].missing,
        tolerated,
      };
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

    // ----------------------------------------------------------
    // Optional operator cross-checks — independent numbers (e.g.
    // read straight off the Momentum admin UI during the freeze).
    // Unset → SKIP, visibly. Set → exact compare. Set to garbage →
    // ERROR (numFromEnv throws), because a typo'd expectation
    // silently skipping would be the old auto-pass hole again.
    // ----------------------------------------------------------
    check('EXPECT_MEMBERS cross-check', async () => {
      const want = numFromEnv('EXPECT_MEMBERS');
      if (want == null) return { skip: true, note: 'EXPECT_MEMBERS not set' };
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM members WHERE tenant_id = $1`,
        [tenant_id],
      );
      return { ok: r.rows[0].n === want, count: r.rows[0].n, expected: want };
    }),

    check('EXPECT_ACTIVE_SUBS cross-check', async () => {
      const want = numFromEnv('EXPECT_ACTIVE_SUBS');
      if (want == null) return { skip: true, note: 'EXPECT_ACTIVE_SUBS not set' };
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM subscriptions
          WHERE tenant_id = $1 AND status = 'active'`,
        [tenant_id],
      );
      return { ok: r.rows[0].n === want, count: r.rows[0].n, expected: want };
    }),

    check('EXPECT_TOTAL_CREDITS cross-check', async () => {
      const want = numFromEnv('EXPECT_TOTAL_CREDITS');
      if (want == null) return { skip: true, note: 'EXPECT_TOTAL_CREDITS not set' };
      const r = await pool.query(
        `SELECT COALESCE(sum(current_credits), 0)::int AS total
           FROM credit_balances WHERE tenant_id = $1`,
        [tenant_id],
      );
      return { ok: r.rows[0].total === want, total: r.rows[0].total, expected: want };
    }),

    check('EXPECT_BOOKINGS_FUTURE cross-check', async () => {
      const want = numFromEnv('EXPECT_BOOKINGS_FUTURE');
      if (want == null) return { skip: true, note: 'EXPECT_BOOKINGS_FUTURE not set' };
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM bookings
          WHERE tenant_id = $1
            AND status = 'confirmed'
            AND start_time > now()`,
        [tenant_id],
      );
      return { ok: r.rows[0].n === want, count: r.rows[0].n, expected: want };
    }),
  ]);

  await pool.end();

  if (failed > 0) {
    process.stderr.write(`\n${failed} verification check(s) FAILED — abort the cutover.\n`);
    process.exit(1);
  }

  printReconciliation(sourceManifest, transformedManifest, loadReport, live, {
    inserted,
    alreadyPresent,
    conflicts: overlapConflicts.length,
  });
  process.stdout.write('\nAll checks PASSED. Safe to flip Stripe webhook URL + DNS.\n');
}

// ============================================================
// helpers
// ============================================================

// The load report is written by 03 next to the out/ subdirs, not as a
// <dir>/manifest.json, so readManifest can't validate it — do the
// same version/kind gating by hand.
async function readLoadReport(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `load report missing: ${path} — run 03_load first; ` +
          `verify does not proceed without it`,
      );
    }
    throw err;
  }
  const report = JSON.parse(raw);
  if (report.manifest_version !== MANIFEST_VERSION) {
    throw new Error(
      `load report version mismatch at ${path}: ` +
        `got ${report.manifest_version}, want ${MANIFEST_VERSION}`,
    );
  }
  if (report.kind !== 'load') {
    throw new Error(
      `load report kind mismatch at ${path}: ` +
        `got ${JSON.stringify(report.kind)}, want "load"`,
    );
  }
  return report;
}

// Optional expectation from env. Unset/empty → null (caller reports
// SKIP). Set but not an integer → throw, so a typo'd value surfaces
// as a failed check instead of a silent skip.
function numFromEnv(name) {
  const v = process.env[name];
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} is set but not an integer: ${JSON.stringify(v)}`);
  }
  return n;
}

// Compact source-rows → loaded-rows table, printed only after every
// check passed. This is the artifact the operator screenshots into
// the cutover log.
function printReconciliation(sourceManifest, transformedManifest, loadReport, live, bookingCounts) {
  const t = transformedManifest.files ?? {};
  const rows = [
    [
      'members',
      sourceManifest.files?.['members.json']?.rows,
      live.members,
      '',
    ],
    [
      'plans',
      t['plans.json']?.rows,
      loadReport.phases?.plans?.processed,
      '',
    ],
    [
      'subscriptions',
      t['subscriptions.json']?.rows,
      live.subs.active + live.subs.past_due + live.subs.incomplete + live.subs.cancelled,
      `(active ${live.subs.active}, past_due ${live.subs.past_due}, ` +
        `incomplete ${live.subs.incomplete}, cancelled ${live.subs.cancelled})`,
    ],
    [
      'credit_balances',
      t['credit_balances.json']?.rows,
      live.balance_rows,
      `(credits ${live.total_credits}, purchased ${live.total_purchased})`,
    ],
    [
      'bookings',
      t['bookings.json']?.rows,
      live.bookings,
      `(inserted ${bookingCounts.inserted}, existing ${bookingCounts.alreadyPresent}, ` +
        `conflicts ${bookingCounts.conflicts})`,
    ],
  ];
  let out = '\nReconciliation — source rows → loaded rows:\n';
  out += `  ${'dataset'.padEnd(18)}${'source'.padStart(8)}${'loaded'.padStart(8)}\n`;
  for (const [name, source, loaded, note] of rows) {
    out += `  ${name.padEnd(18)}${String(source ?? '?').padStart(8)}${String(loaded ?? '?').padStart(8)}${note ? `  ${note}` : ''}\n`;
  }
  process.stdout.write(out);
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
