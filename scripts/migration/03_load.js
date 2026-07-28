// 03_load.js — load transformed JSON into Courtside DB.
//
// Runs against the privileged pool (MIGRATION_DATABASE_URL) so we can
// INSERT across multiple tenants' tables and write to credit_ledger_
// entries directly. The runtime app_runtime role doesn't have those
// privileges — that's intentional, and bypassing here is the
// explicit escape hatch documented in CLAUDE.md.
//
// FAIL-CLOSED CONTRACT (the P0 rewrite):
//
//   * Every one of the five transformed datasets is REQUIRED. The old
//     "file missing → log + skip the phase" pattern is gone — it made
//     an empty import look like a successful one. A dataset that is
//     missing, unlisted in the manifest, or checksum-drifted aborts
//     before anything is written (shared/manifest.js readVerified).
//   * Blockers recorded by 02_transform must be acknowledged — either
//     at transform time (manifest.acknowledged_blockers) or now via
//     MIGRATION_ACK_BLOCKERS — or the load refuses to start.
//   * PREFLIGHT: every catalog name the datasets reference (offerings,
//     resources, offering↔resource links, plans, member emails) is
//     resolved read-only BEFORE the first write, and every gap is
//     reported in one pass. Offerings/resources and their links are
//     admin-UI prework — this loader never creates them; plans may
//     come from plans.json or prework.
//
// Idempotency strategy: each phase has a stable lookup key (email for
// users/members; stripe_subscription_id — or the member's single
// NULL-stripe row — for subscriptions; (tenant_id, member_id) for
// balances; (tenant_id, external_source, external_id) for bookings,
// via migration 031). Rerunning the loader upserts on those keys, so
// a partial load can be picked up by rerunning without duplicating
// rows. Each phase commits its own transaction; a cross-check failure
// at the end therefore means "fix the input and rerun", not "roll
// back the world".
//
// What we DO NOT do:
//   * Run apply_credit_change for migration ledger rows. The
//     function checks the GUC and would force tenant-by-tenant
//     transactions; for a bulk one-shot import we INSERT directly
//     using the privileged role. The 'migration' reason value (added
//     in migration 017) makes these rows distinguishable from
//     operational ones.
//   * Insert pending_payment bookings. Those represent in-flight
//     Stripe sessions that don't survive cutover; 02_transform never
//     emits them.
//   * Skip per-row errors we don't understand. Only GiST overlap
//     conflicts (23P01) on bookings are tolerated — double-booked
//     source slots are a known Setmore artifact, adjudicated at the
//     05_verify gate. Anything else (validity trigger, CHECKs) means
//     catalog prework or transform output is wrong and aborts.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info, warn, error as logError } from './shared/log.js';
import { inTransaction, pool } from './shared/db.js';
import {
  MANIFEST_VERSION,
  MANIFEST_NAME,
  readManifest,
  requireFiles,
  readVerified,
  enforceBlockers,
  sha256File,
} from './shared/manifest.js';

const OUT_DIR = new URL('./out/', import.meta.url).pathname;
const TRANSFORMED_DIR = join(OUT_DIR, 'transformed');
const LOAD_REPORT_PATH = join(OUT_DIR, 'load_report.json');

// All five, always. requireFiles lists every gap at once; readVerified
// then enforces the recorded sha256 per file.
const REQUIRED_DATASETS = [
  'users_and_members.json',
  'plans.json',
  'subscriptions.json',
  'credit_balances.json',
  'bookings.json',
];

async function main() {
  banner('03 load');

  // ------------------------------------------------------------
  // preamble — nothing below writes until preflight passes
  // ------------------------------------------------------------

  const tenantId = process.env.MIGRATION_TENANT_ID;
  if (!tenantId) {
    throw new Error('MIGRATION_TENANT_ID required (target Courtside tenant uuid)');
  }
  const tenantRow = await pool.query(
    'SELECT id, name FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (tenantRow.rows.length === 0) {
    throw new Error(
      `tenant ${tenantId} does not exist in the target DB — ` +
        `create the tenant (and its catalog prework) before loading`,
    );
  }
  info('target tenant', { tenant_id: tenantId, name: tenantRow.rows[0].name });

  const manifest = await readManifest(TRANSFORMED_DIR, 'transformed');
  if (manifest.tenant_id !== tenantId) {
    throw new Error(
      `manifest tenant mismatch: transformed data was produced for ` +
        `${manifest.tenant_id}, MIGRATION_TENANT_ID is ${tenantId} — ` +
        `refusing to load one tenant's data into another`,
    );
  }

  // Blockers acknowledged at transform time stay acknowledged (they
  // are recorded in the manifest for the audit trail); anything still
  // outstanding can be acked now via MIGRATION_ACK_BLOCKERS, else we
  // stop here.
  const ackedAtTransform = manifest.acknowledged_blockers ?? [];
  enforceBlockers(
    (manifest.blockers ?? []).filter((b) => !ackedAtTransform.includes(b.code)),
  );

  // Lineage: hash the transformed manifest's RAW BYTES into the load
  // report, so 05_verify can prove this load consumed exactly the
  // manifest it is verifying against — a stale artifact left over from
  // a different pipeline run hashes differently and fails the gate.
  const transformedManifestSha256 = await sha256File(join(TRANSFORMED_DIR, MANIFEST_NAME));

  requireFiles(manifest, REQUIRED_DATASETS);
  const usersAndMembers = await readVerified(TRANSFORMED_DIR, manifest, 'users_and_members.json');
  const plans = await readVerified(TRANSFORMED_DIR, manifest, 'plans.json');
  const subscriptions = await readVerified(TRANSFORMED_DIR, manifest, 'subscriptions.json');
  const creditBalances = await readVerified(TRANSFORMED_DIR, manifest, 'credit_balances.json');
  const bookings = await readVerified(TRANSFORMED_DIR, manifest, 'bookings.json');

  const maps = await preflight(tenantId, {
    usersAndMembers, plans, subscriptions, creditBalances, bookings,
  });

  // ------------------------------------------------------------
  // phases — dependency order, one committed transaction each
  // ------------------------------------------------------------

  const report = {
    manifest_version: MANIFEST_VERSION,
    kind: 'load',
    created_at: null, // stamped at write time below
    tenant_id: tenantId,
    transformed_manifest_sha256: transformedManifestSha256,
    phases: {},
  };

  const memberIdByEmail = await loadUsersAndMembers(tenantId, usersAndMembers);
  report.phases.users_and_members = { processed: usersAndMembers.length };

  await loadPlans(tenantId, plans);
  report.phases.plans = { processed: plans.length };

  report.phases.subscriptions =
    await loadSubscriptions(tenantId, subscriptions, memberIdByEmail, manifest.created_at);

  report.phases.credit_balances =
    await loadCreditBalancesAndLedger(tenantId, creditBalances, memberIdByEmail);

  report.phases.bookings =
    await loadBookings(tenantId, bookings, maps, memberIdByEmail);

  // ------------------------------------------------------------
  // load report + reconciliation cross-check
  // ------------------------------------------------------------

  report.created_at = new Date().toISOString();
  await writeFile(LOAD_REPORT_PATH, JSON.stringify(report, null, 2));
  info('wrote load report', { path: LOAD_REPORT_PATH });

  const overlaps = report.phases.bookings.overlap_conflicts;
  if (overlaps.length > 0) {
    // Not an exit-1 condition on its own: double-booked source slots
    // are a known Setmore artifact and the go/no-go decision belongs
    // to the 05_verify gate, where the operator must explicitly
    // acknowledge 'booking_conflicts' after reviewing each one.
    warn(
      `${overlaps.length} booking overlap conflict(s) were skipped — ` +
        `05_verify WILL FAIL unless 'booking_conflicts' is acknowledged ` +
        `after reviewing them in load_report.json`,
      { count: overlaps.length },
    );
  }

  crossCheck(manifest.expected, report.phases, creditBalances);

  await pool.end();
}

// ============================================================
// preflight — read-only resolution, all gaps collected at once
// ============================================================
//
// The loader never creates catalog rows. Offerings, resources, and
// their offering_resources links are created in the Courtside admin
// as cutover prework; plans arrive via plans.json or prework. So
// before writing anything we resolve every name the datasets
// reference — AND every runtime gate the enforce_booking_validity
// trigger will apply on insert — and print the COMPLETE list of
// gaps — the operator fixes the admin catalog once, not one error
// per rerun.
async function preflight(tenantId, datasets) {
  banner('preflight');
  const failures = [];

  // a. plans referenced by subscriptions must exist in plans.json or
  //    already in the DB (prework).
  const planNamesInFile = new Set(
    datasets.plans.map((p) => p.name.toLowerCase()),
  );
  const dbPlans = await pool.query(
    'SELECT lower(name) AS lname FROM plans WHERE tenant_id = $1',
    [tenantId],
  );
  const planNamesInDb = new Set(dbPlans.rows.map((r) => r.lname));
  const missingPlans = distinct(
    datasets.subscriptions.map((s) => s.plan_name),
  ).filter(
    (n) => !planNamesInFile.has(n.toLowerCase()) && !planNamesInDb.has(n.toLowerCase()),
  );
  for (const n of missingPlans) {
    failures.push(`plan not in plans.json nor in DB: ${JSON.stringify(n)}`);
  }

  // b. offerings by name — fetched with the enforce_booking_validity
  //    gate columns (active, capacity, audience flags) for check e.
  const offeringNames = distinct(datasets.bookings.map((b) => b.offering_name));
  const offeringRows = await pool.query(
    `SELECT id, name, active, capacity, allow_member_booking, allow_public_booking
       FROM offerings WHERE tenant_id = $1 AND name = ANY($2)`,
    [tenantId, offeringNames],
  );
  const offeringByName = new Map(offeringRows.rows.map((r) => [r.name, r]));
  const offeringIdByName = new Map(offeringRows.rows.map((r) => [r.name, r.id]));
  for (const n of offeringNames.filter((n) => !offeringByName.has(n))) {
    failures.push(`offering missing from admin catalog: ${JSON.stringify(n)}`);
  }

  // c. resources by name — active flag fetched for check e.
  const resourceNames = distinct(datasets.bookings.map((b) => b.resource_name));
  const resourceRows = await pool.query(
    'SELECT id, name, active FROM resources WHERE tenant_id = $1 AND name = ANY($2)',
    [tenantId, resourceNames],
  );
  const resourceByName = new Map(resourceRows.rows.map((r) => [r.name, r]));
  const resourceIdByName = new Map(resourceRows.rows.map((r) => [r.name, r.id]));
  for (const n of resourceNames.filter((n) => !resourceByName.has(n))) {
    failures.push(`resource missing from admin catalog: ${JSON.stringify(n)}`);
  }

  // d. every (offering, resource) pair a booking uses must have an
  //    offering_resources link — bookings carry a composite FK to it,
  //    so a missing link fails every row mid-phase otherwise. The
  //    link's active flag rides along for check e.
  const linkRows = await pool.query(
    `SELECT o.name AS offering_name, r.name AS resource_name, ors.active
       FROM offering_resources ors
       JOIN offerings o ON o.tenant_id = ors.tenant_id AND o.id = ors.offering_id
       JOIN resources r ON r.tenant_id = ors.tenant_id AND r.id = ors.resource_id
      WHERE ors.tenant_id = $1`,
    [tenantId],
  );
  const linkByPair = new Map(
    linkRows.rows.map((r) => [pairKey(r.offering_name, r.resource_name), r]),
  );
  const bookingPairs = distinct(
    datasets.bookings.map((b) => pairKey(b.offering_name, b.resource_name)),
  );
  for (const key of bookingPairs.filter((k) => !linkByPair.has(k))) {
    const [o, r] = key.split(PAIR_SEP);
    failures.push(
      `offering_resources link missing: ${JSON.stringify(o)} on ${JSON.stringify(r)}`,
    );
  }

  // e. the enforce_booking_validity trigger (migration 007) fires
  //    BEFORE INSERT on every booking row and gates on offering.active,
  //    capacity = 1, the audience flag (member rows need
  //    allow_member_booking, walk-in rows need allow_public_booking),
  //    resource.active, and offering_resources.active. Existence alone
  //    isn't enough — an inactive catalog row would abort the bookings
  //    phase mid-flight. Evaluate every distinct (offering, resource,
  //    audience) combination the bookings reference and report which
  //    gate fails; these are admin-catalog prework gaps — the operator
  //    fixes the catalog, not the data.
  const combosSeen = new Set();
  for (const b of datasets.bookings) {
    const audience = b.member_email != null ? 'member' : 'walk-in';
    const comboKey = pairKey(b.offering_name, b.resource_name) + PAIR_SEP + audience;
    if (combosSeen.has(comboKey)) continue;
    combosSeen.add(comboKey);
    const off = offeringByName.get(b.offering_name);
    const res = resourceByName.get(b.resource_name);
    const link = linkByPair.get(pairKey(b.offering_name, b.resource_name));
    if (!off || !res || !link) continue; // already reported as missing above
    const combo =
      `${JSON.stringify(b.offering_name)} on ${JSON.stringify(b.resource_name)} (${audience})`;
    if (!off.active) {
      failures.push(`booking validity gate — offering inactive: ${combo}`);
    }
    if (off.capacity !== 1) {
      failures.push(
        `booking validity gate — capacity ${off.capacity}, must be 1 ` +
          `(classes go through class_bookings): ${combo}`,
      );
    }
    if (audience === 'member' && !off.allow_member_booking) {
      failures.push(`booking validity gate — offering does not allow member bookings: ${combo}`);
    }
    if (audience === 'walk-in' && !off.allow_public_booking) {
      failures.push(`booking validity gate — offering does not allow public bookings: ${combo}`);
    }
    if (!res.active) {
      failures.push(`booking validity gate — resource inactive: ${combo}`);
    }
    if (!link.active) {
      failures.push(`booking validity gate — offering_resources link inactive: ${combo}`);
    }
  }

  // f. every member_email any dataset references must be a member we
  //    are about to load — an unknown email means the transform's
  //    internal consistency broke, not an admin-prework gap.
  const knownEmails = new Set(datasets.usersAndMembers.map((r) => r.member.email));
  const referencedEmails = [
    ...datasets.subscriptions.map((s) => s.member_email),
    ...datasets.creditBalances.map((c) => c.balance.member_email),
    ...datasets.bookings.map((b) => b.member_email),
  ].filter((e) => e != null);
  for (const e of distinct(referencedEmails).filter((e) => !knownEmails.has(e))) {
    failures.push(`member_email not present in users_and_members.json: ${JSON.stringify(e)}`);
  }

  if (failures.length > 0) {
    for (const f of failures) logError(f);
    throw new Error(
      `preflight failed with ${failures.length} gap(s) — nothing was ` +
        `written. Offerings/resources/links are created in the Courtside ` +
        `admin (never by this loader); fix the prework or the transform ` +
        `output, then rerun.`,
    );
  }

  info('preflight clean', {
    offerings: offeringNames.length,
    resources: resourceNames.length,
    offering_resource_pairs: bookingPairs.length,
    referenced_member_emails: distinct(referencedEmails).length,
  });
  return { offeringIdByName, resourceIdByName };
}

// ============================================================
// phase: users + members
// ============================================================
//
// UPSERT keyed on (tenant_id, email) for both tables. password_hash
// is NULL, not '' — migration 021 made it nullable ("invited, no
// password set yet") and added a btrim CHECK that an empty string
// would trip. Members log in for the first time via the reset-token
// welcome email, same as staff invites.
//
// Returns the email → member_id map the later phases resolve against.
async function loadUsersAndMembers(tenantId, rows) {
  banner('users + members');

  const memberIdByEmail = new Map();
  await inTransaction(async (client) => {
    for (const row of rows) {
      const u = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, created_at)
           VALUES ($1, $2, NULL, $3, $4, COALESCE($5, now()))
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name
         RETURNING id`,
        [
          tenantId,
          row.user.email,
          row.user.first_name,
          row.user.last_name,
          row.user.created_at,
        ],
      );
      const userId = u.rows[0].id;

      const m = await client.query(
        `INSERT INTO members (tenant_id, user_id, email, first_name, last_name, phone, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               phone = EXCLUDED.phone
         RETURNING id`,
        [
          tenantId,
          userId,
          row.member.email,
          row.member.first_name,
          row.member.last_name,
          row.member.phone,
          row.member.created_at,
        ],
      );
      memberIdByEmail.set(row.member.email, m.rows[0].id);
    }
    info('loaded users + members', { count: rows.length });
  });
  return memberIdByEmail;
}

// ============================================================
// phase: plans
// ============================================================
//
// UPSERT on (tenant_id, lower(name)) via the plans_active_name_unique
// partial index. stripe_price_id comes from Momentum's existing
// connected-account prices — we DO NOT mint new Prices because
// Stripe already has them.
async function loadPlans(tenantId, rows) {
  banner('plans');

  await inTransaction(async (client) => {
    for (const p of rows) {
      await client.query(
        `INSERT INTO plans (
           tenant_id, name, monthly_price_cents, credits_per_week,
           stripe_price_id, active
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, lower(name)) WHERE active = true
         DO UPDATE SET
           monthly_price_cents = EXCLUDED.monthly_price_cents,
           credits_per_week = EXCLUDED.credits_per_week,
           stripe_price_id = EXCLUDED.stripe_price_id`,
        [
          tenantId, p.name, p.monthly_price_cents, p.credits_per_week,
          p.stripe_price_id, p.active ?? true,
        ],
      );
    }
    info('loaded plans', { count: rows.length });
  });
}

// ============================================================
// phase: subscriptions + plan periods
// ============================================================
//
// At most one subscription per member — Diamond only stores current
// state, and 02_transform enforces it. Two idempotency paths:
//
//   * stripe_subscription_id present → UPSERT on the partial unique
//     index subscriptions_stripe_unique.
//   * stripe_subscription_id NULL (cancelled historicals, or actives
//     imported under an acknowledged active_without_stripe blocker) —
//     there is no unique key to conflict on, so we SELECT the
//     member's single NULL-stripe row first and UPDATE it when found.
//
// Counter semantics in the report:
//   inserted         — a subscription row was created (either path)
//   updated          — the stripe-keyed upsert hit an existing row
//   skipped_existing — the NULL-stripe probe found an existing row
//                      (refreshed in place; no insert happened)
//
// Plan periods: the old ON CONFLICT DO NOTHING was a rerun-duplication
// bug — subscription_plan_periods has NO unique constraint for the
// arbiter to bind to, so every rerun inserted another open period and
// the GiST period-overlap exclusion aborted the phase. SELECT-first
// by (tenant_id, subscription_id), insert only when absent.
// `migratedAt` is the transformed manifest's created_at — the plan-
// period fallback end for cancelled subscriptions with no recorded
// end date (see the comment at the INSERT).
async function loadSubscriptions(tenantId, rows, memberIdByEmail, migratedAt) {
  banner('subscriptions');

  const counts = { inserted: 0, updated: 0, skipped_existing: 0 };
  await inTransaction(async (client) => {
    // plan_name → plan_id, resolved once. Preflight proved every name
    // exists (in plans.json — loaded by the previous phase — or as
    // prework), so a miss here is a bug worth crashing on. Active
    // plans win when an inactive row shares the lowercased name.
    const planRows = await client.query(
      `SELECT id, lower(name) AS lname, active FROM plans
        WHERE tenant_id = $1
        ORDER BY active ASC`,
      [tenantId],
    );
    const planIdByName = new Map(planRows.rows.map((r) => [r.lname, r.id]));

    for (const r of rows) {
      const memberId = memberIdByEmail.get(r.member_email);
      if (!memberId) {
        throw new Error(`subscription for unknown member ${r.member_email}`);
      }
      const planId = planIdByName.get(r.plan_name.toLowerCase());
      if (!planId) {
        throw new Error(`subscription references unknown plan ${JSON.stringify(r.plan_name)}`);
      }

      let subscriptionId;
      if (r.stripe_subscription_id != null) {
        const res = await client.query(
          `INSERT INTO subscriptions (
             tenant_id, member_id, status,
             stripe_subscription_id, stripe_customer_id,
             current_period_start, current_period_end,
             cancel_at_period_end, scheduled_deactivation_at,
             activated_at, ended_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL
           DO UPDATE SET
             status = EXCLUDED.status,
             current_period_start = EXCLUDED.current_period_start,
             current_period_end = EXCLUDED.current_period_end,
             cancel_at_period_end = EXCLUDED.cancel_at_period_end,
             scheduled_deactivation_at = EXCLUDED.scheduled_deactivation_at,
             ended_at = EXCLUDED.ended_at
           RETURNING id, (xmax = 0) AS was_insert`,
          [
            tenantId, memberId, r.status,
            r.stripe_subscription_id, r.stripe_customer_id,
            r.current_period_start, r.current_period_end,
            r.cancel_at_period_end, r.scheduled_deactivation_at,
            r.activated_at, r.ended_at,
          ],
        );
        subscriptionId = res.rows[0].id;
        counts[res.rows[0].was_insert ? 'inserted' : 'updated'] += 1;
      } else {
        const existing = await client.query(
          `SELECT id FROM subscriptions
            WHERE tenant_id = $1 AND member_id = $2
              AND stripe_subscription_id IS NULL
            LIMIT 1`,
          [tenantId, memberId],
        );
        if (existing.rows.length > 0) {
          subscriptionId = existing.rows[0].id;
          await client.query(
            `UPDATE subscriptions SET
               status = $3,
               stripe_customer_id = $4,
               current_period_start = $5,
               current_period_end = $6,
               cancel_at_period_end = $7,
               scheduled_deactivation_at = $8,
               activated_at = $9,
               ended_at = $10
             WHERE tenant_id = $1 AND id = $2`,
            [
              tenantId, subscriptionId, r.status,
              r.stripe_customer_id,
              r.current_period_start, r.current_period_end,
              r.cancel_at_period_end, r.scheduled_deactivation_at,
              r.activated_at, r.ended_at,
            ],
          );
          counts.skipped_existing += 1;
        } else {
          const res = await client.query(
            `INSERT INTO subscriptions (
               tenant_id, member_id, status,
               stripe_subscription_id, stripe_customer_id,
               current_period_start, current_period_end,
               cancel_at_period_end, scheduled_deactivation_at,
               activated_at, ended_at
             ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              tenantId, memberId, r.status,
              r.stripe_customer_id,
              r.current_period_start, r.current_period_end,
              r.cancel_at_period_end, r.scheduled_deactivation_at,
              r.activated_at, r.ended_at,
            ],
          );
          subscriptionId = res.rows[0].id;
          counts.inserted += 1;
        }
      }

      // Plan period — SELECT-first (see the phase comment). Diamond
      // stores only current state, so one period per subscription:
      // open (ended_at NULL) for non-terminal statuses; a cancelled
      // subscription's period closes when the subscription ended.
      // Members who churned before Diamond migration 011 have neither
      // deactivated_at nor subscription_period_end — for those the
      // period ends at the migration moment (the transformed
      // manifest's created_at): "membership had ended by migration;
      // exact end unknown". Falling back to activated_at instead
      // would make a zero-length period and trip the DB CHECK
      // (ended_at > started_at). The subscription row's own ended_at
      // stays exactly as transform emitted it.
      const period = await client.query(
        `SELECT 1 FROM subscription_plan_periods
          WHERE tenant_id = $1 AND subscription_id = $2
          LIMIT 1`,
        [tenantId, subscriptionId],
      );
      if (period.rows.length === 0) {
        const periodEndedAt =
          r.status === 'cancelled' ? (r.ended_at ?? migratedAt) : null;
        await client.query(
          `INSERT INTO subscription_plan_periods (
             tenant_id, subscription_id, plan_id, started_at, ended_at
           ) VALUES ($1, $2, $3, COALESCE($4, now()), $5)`,
          [tenantId, subscriptionId, planId, r.activated_at, periodEndedAt],
        );
      }
    }
    info('loaded subscriptions + plan_periods', { count: rows.length, ...counts });
  });
  return counts;
}

// ============================================================
// phase: credit balances + migration ledger row
// ============================================================
//
// Bypasses apply_credit_change(): we INSERT directly into both
// credit_balances and credit_ledger_entries from the privileged role.
// The 'migration' reason value (migration 017) tags these rows so
// audits know they came from import.
//
// purchased_credits is set alongside current_credits (P0 fix):
// leaving it 0 meant every Diamond gift/purchased credit would be
// clawed back by the first weekly reset — migration 022/024 SET the
// balance to credits_per_week + purchased_credits, so only credits
// marked purchased survive the Monday reset.
async function loadCreditBalancesAndLedger(tenantId, rows, memberIdByEmail) {
  banner('credit balances + ledger');

  const counts = {
    processed: 0,
    ledger_rows_inserted: 0,
    ledger_rows_updated: 0,
    ledger_rows_existing: 0,
  };
  await inTransaction(async (client) => {
    for (const r of rows) {
      const memberId = memberIdByEmail.get(r.balance.member_email);
      if (!memberId) {
        throw new Error(`credit balance for unknown member ${r.balance.member_email}`);
      }
      await client.query(
        `INSERT INTO credit_balances (
           tenant_id, member_id, current_credits, purchased_credits, last_reset_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, member_id) DO UPDATE SET
           current_credits = EXCLUDED.current_credits,
           purchased_credits = EXCLUDED.purchased_credits,
           last_reset_at = EXCLUDED.last_reset_at`,
        [
          tenantId, memberId,
          r.balance.current_credits, r.balance.purchased_credits,
          r.balance.last_reset_at,
        ],
      );
      counts.processed += 1;

      // amount is null for zero balances — apply_credit_change also
      // rejects amount=0; the ledger stays clean of no-op rows.
      if (r.ledger.amount != null && r.ledger.amount !== 0) {
        // Rerun-aware idempotency: the single reason='migration' row
        // per member is the key, but a re-transform with corrected
        // balances changes balance_after — an existence-only probe
        // would leave the old ledger row contradicting the updated
        // credit_balances row, a permanent 05_verify failure.
        const migRow = await client.query(
          `SELECT id, balance_after FROM credit_ledger_entries
            WHERE tenant_id = $1 AND member_id = $2 AND reason = 'migration'
            LIMIT 1`,
          [tenantId, memberId],
        );
        if (migRow.rows.length === 0) {
          await client.query(
            `INSERT INTO credit_ledger_entries (
               tenant_id, member_id, amount, balance_after, reason, note
             ) VALUES ($1, $2, $3, $4, 'migration', $5)`,
            [tenantId, memberId, r.ledger.amount, r.ledger.balance_after, r.ledger.note],
          );
          counts.ledger_rows_inserted += 1;
        } else if (migRow.rows[0].balance_after === r.ledger.balance_after) {
          counts.ledger_rows_existing += 1;
        } else {
          const latest = await client.query(
            `SELECT id FROM credit_ledger_entries
              WHERE tenant_id = $1 AND member_id = $2
              ORDER BY entry_number DESC
              LIMIT 1`,
            [tenantId, memberId],
          );
          if (latest.rows[0].id !== migRow.rows[0].id) {
            // Ledger entries newer than the migration row mean
            // operational activity happened after import — rewriting
            // history under live state would corrupt it. Refuse.
            throw new Error(
              `migration ledger row for ${r.balance.member_email} has ` +
                `balance_after ${migRow.rows[0].balance_after} (transform now says ` +
                `${r.ledger.balance_after}) but is no longer the member's latest ` +
                `ledger entry — post-import activity exists; a rerun would ` +
                `corrupt live state. Refusing.`,
            );
          }
          // The migration row IS the latest entry, so updating it in
          // place is safe: this is a rerun inside the cutover window,
          // and no operational writes can exist during the freeze —
          // nothing downstream of this row has built on its balance.
          await client.query(
            `UPDATE credit_ledger_entries
                SET amount = $3, balance_after = $4, note = $5
              WHERE tenant_id = $1 AND id = $2`,
            [tenantId, migRow.rows[0].id, r.ledger.amount, r.ledger.balance_after, r.ledger.note],
          );
          counts.ledger_rows_updated += 1;
        }
      }
    }
    info('loaded credit_balances + ledger', counts);
  });
  return counts;
}

// ============================================================
// phase: bookings
// ============================================================
//
// Inserted in chronological order so each row's GiST exclusion check
// runs against an already-loaded prefix. Three outcomes per row:
//
//   inserted        — rowCount 1, the normal case.
//   already_present — rowCount 0: the ON CONFLICT arbiter matched
//                     (tenant_id, external_source, external_id), i.e.
//                     an idempotent rerun (migration 031 — the GiST
//                     exclusion alone never covered cancelled rows).
//   overlap         — 23P01 from the GiST exclusion: a genuinely
//                     double-booked source slot (known Setmore
//                     artifact). SAVEPOINT-rollback, record it for
//                     the 05_verify 'booking_conflicts' gate,
//                     continue. The explicit arbiter above is what
//                     keeps 23P01 raising instead of being swallowed
//                     by a bare ON CONFLICT DO NOTHING.
//
// ANY other per-row error — the enforce_booking_validity trigger
// rejecting an inactive offering, a CHECK violation — aborts the
// whole phase. Those mean catalog prework or transform output is
// wrong and MUST be fixed, not skipped.
async function loadBookings(tenantId, rows, maps, memberIdByEmail) {
  banner('bookings');

  // Chronological so historical rows land first.
  const sorted = [...rows].sort(
    (a, b) => new Date(a.start_time) - new Date(b.start_time),
  );

  const counts = { inserted: 0, already_present: 0, overlap_conflicts: [] };
  await inTransaction(async (client) => {
    for (const b of sorted) {
      const offeringId = maps.offeringIdByName.get(b.offering_name);
      const resourceId = maps.resourceIdByName.get(b.resource_name);
      const memberId = b.member_email != null
        ? memberIdByEmail.get(b.member_email)
        : null;
      if (!offeringId || !resourceId || (b.member_email != null && !memberId)) {
        // Preflight proved these resolve; a miss here is a bug.
        throw new Error(
          `booking ${b.external_source}:${b.external_id} failed to resolve ids post-preflight`,
        );
      }

      try {
        // SAVEPOINT per row so a GiST conflict on one doesn't poison
        // the outer transaction (same pattern as the class-instance
        // generator).
        await client.query('SAVEPOINT one_booking');
        const res = await client.query(
          `INSERT INTO bookings (
             tenant_id, offering_id, resource_id, member_id,
             customer_first_name, customer_last_name, customer_email, customer_phone,
             start_time, end_time, status,
             amount_due_cents, credit_cost_charged,
             amount_paid_cents, amount_refunded_cents,
             payment_status,
             cancelled_at, cancellation_reason,
             no_show_marked_at,
             external_source, external_id,
             created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             COALESCE($22, now())
           )
           ON CONFLICT (tenant_id, external_source, external_id)
             WHERE external_id IS NOT NULL
           DO NOTHING`,
          [
            tenantId, offeringId, resourceId, memberId,
            b.customer_first_name, b.customer_last_name,
            b.customer_email, b.customer_phone,
            b.start_time, b.end_time, b.status,
            b.amount_due_cents, b.credit_cost_charged,
            b.amount_paid_cents, b.amount_refunded_cents,
            b.payment_status,
            b.cancelled_at, b.cancellation_reason,
            b.no_show_marked_at,
            b.external_source, b.external_id,
            b.created_at,
          ],
        );
        await client.query('RELEASE SAVEPOINT one_booking');
        if (res.rowCount === 1) {
          counts.inserted += 1;
        } else {
          counts.already_present += 1;
        }
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT one_booking');
        if (err.code === '23P01') {
          counts.overlap_conflicts.push({
            external_source: b.external_source,
            external_id: b.external_id,
            resource_name: b.resource_name,
            start_time: b.start_time,
            error: err.message,
          });
          warn('booking overlap conflict skipped', {
            external_source: b.external_source,
            external_id: b.external_id,
            resource_name: b.resource_name,
            start_time: b.start_time,
          });
          continue;
        }
        // Fail-closed: an unexpected per-row error aborts the phase.
        throw err;
      }
    }
    info('loaded bookings', {
      inserted: counts.inserted,
      already_present: counts.already_present,
      overlap_conflicts: counts.overlap_conflicts.length,
    });
  });
  return counts;
}

// ============================================================
// reconciliation cross-check
// ============================================================
//
// The transformed manifest carries the numbers 02_transform expected
// to land; the loader must account for every one of them. A mismatch
// exits 1 — but the phases are already committed, so the message
// says the true remediation: fix the cause and RERUN (the upserts
// make that safe), don't hand-patch the DB.
function crossCheck(expected, phases, creditBalances) {
  banner('cross-check');
  const mismatches = [];

  const bookingsAccounted =
    phases.bookings.inserted +
    phases.bookings.already_present +
    phases.bookings.overlap_conflicts.length;
  if (bookingsAccounted !== expected.bookings.total) {
    mismatches.push(
      `bookings accounted for ${bookingsAccounted} ` +
        `(inserted + already_present + overlaps) !== expected ${expected.bookings.total}`,
    );
  }

  if (phases.users_and_members.processed !== expected.members) {
    mismatches.push(
      `members processed ${phases.users_and_members.processed} !== expected ${expected.members}`,
    );
  }

  const totalCredits = creditBalances.reduce(
    (sum, r) => sum + r.balance.current_credits, 0,
  );
  if (totalCredits !== expected.total_credits) {
    mismatches.push(
      `sum of loaded current_credits ${totalCredits} !== expected ${expected.total_credits}`,
    );
  }
  const totalPurchased = creditBalances.reduce(
    (sum, r) => sum + r.balance.purchased_credits, 0,
  );
  if (totalPurchased !== expected.total_purchased_credits) {
    mismatches.push(
      `sum of loaded purchased_credits ${totalPurchased} !== expected ${expected.total_purchased_credits}`,
    );
  }

  if (mismatches.length > 0) {
    for (const m of mismatches) logError(m);
    throw new Error(
      `load reconciliation failed with ${mismatches.length} mismatch(es). ` +
        `Phases already committed — fix the cause and RERUN the loader ` +
        `(every phase upserts on a stable key, so a rerun is safe); do ` +
        `not hand-patch the database.`,
    );
  }
  info('cross-check clean');
}

// ============================================================
// helpers
// ============================================================

function distinct(values) {
  return [...new Set(values)];
}

// NUL can't appear in a Postgres text value, so it's a safe
// composite-key separator for (offering_name, resource_name).
const PAIR_SEP = '\u0000';

function pairKey(offeringName, resourceName) {
  return `${offeringName}${PAIR_SEP}${resourceName}`;
}

main().catch((err) => {
  console.error('load failed:', err);
  process.exit(1);
});
