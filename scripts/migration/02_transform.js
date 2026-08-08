// 02_transform.js — Diamond Club (Momentum) snapshot → Courtside row
// shapes.
//
// Pure functions over JSON. No DB access. The only I/O is reading the
// verified snapshot in out/source/ and writing out/transformed/.
//
// The transformers are exported individually so tests can drive each
// one with sample input. Keeps verification incremental — discover a
// bad email-normalization rule on a test fixture, not at 6:30am during
// cutover.
//
// Fail-closed rules this file enforces:
//   * Inputs come ONLY through readVerified — a snapshot file that is
//     missing, unlisted, or checksum-drifted aborts before any
//     transformation runs.
//   * Problems of a kind are COLLECTED across the whole dataset and
//     thrown as one list, so the operator fixes the map/source once
//     instead of replaying the transform per gap.
//   * Anything deliberately not migrated (pending gifts, admins,
//     timeless bookings, contact-less walk-ins, duplicate emails) is
//     counted and written to exceptions/*.json — never silently
//     dropped.
//   * Conditions that need an operator decision become manifest
//     `blockers`; enforceBlockers aborts the run unless each code is
//     explicitly acknowledged via MIGRATION_ACK_BLOCKERS. The manifest
//     is still written on abort so the operator can inspect it.
//
// Output rows carry NO tenant_id — 03_load stamps MIGRATION_TENANT_ID
// onto every row and cross-checks it against manifest.tenant_id, so a
// transform for one tenant can never be loaded into another.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info, error as logError } from './shared/log.js';
import {
  readManifest,
  requireFiles,
  readVerified,
  writeJsonWithHash,
  writeManifest,
  enforceBlockers,
  sha256File,
  MANIFEST_NAME,
} from './shared/manifest.js';
import { parseCsv } from './shared/csv.js';
import { parseSourceTimestamp } from './shared/tz.js';
import {
  loadMapping,
  resolvePlan,
  resolveOffering,
  resolveResource,
  resolveSetmoreColumns,
  resolveSetmoreStatus,
} from './shared/mapping.js';

const SRC_DIR = new URL('./out/source/', import.meta.url).pathname;
const OUT_DIR = new URL('./out/transformed/', import.meta.url).pathname;
const MAP_PATH = new URL('./momentum.map.json', import.meta.url).pathname;

// Neither Diamond nor Setmore records WHEN a cancellation happened, so
// cancelled_at is approximated (booked_at, else start_time) and the
// approximation is declared on the row itself where staff will see it.
const MIGRATED_CANCELLATION_REASON =
  'migrated from Momentum; original cancellation time not recorded';

// ============================================================
// small shared helpers
// ============================================================

// Emails are normalize-on-write in Courtside (CHECK email = lower(email)).
// Diamond's members.email is case-SENSITIVE unique, so two source rows
// can collide after lowercasing — the driver detects that separately;
// here we only reject emails that can never be valid.
function normalizeEmail(raw, ctx) {
  const email = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!email || /\s/.test(email)) {
    throw new Error(`${ctx}: bad email ${JSON.stringify(raw)} — empty or contains whitespace`);
  }
  return email;
}

// First-space split. Single-token names duplicate into BOTH columns —
// same convention as the walk-in checkout's splitFullName, which is
// what Courtside's non-empty CHECKs on both name columns require.
function splitOnFirstSpace(full) {
  const idx = full.indexOf(' ');
  if (idx === -1) return { first: full, last: full };
  return { first: full.slice(0, idx), last: full.slice(idx + 1).trim() };
}

// Diamond stores first_name/last_name (NOT NULL DEFAULT '') AND a
// legacy free-text name. Preference order: the split columns when both
// are filled; else split the legacy name; else duplicate whichever
// single token exists. No usable name at all is a hard error — the
// Courtside CHECKs would reject the row anyway, better to fail with
// the member identified.
function memberName(src) {
  const first = String(src.first_name ?? '').trim();
  const last = String(src.last_name ?? '').trim();
  if (first && last) return { first, last };
  const full = String(src.name ?? '').trim();
  if (full) return splitOnFirstSpace(full);
  const single = first || last;
  if (single) return { first: single, last: single };
  throw new Error(
    `source member ${src.id} (${src.email}): no usable name in first_name/last_name/name`,
  );
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

// Throw one error carrying EVERY collected problem — the fail-closed
// "show the operator the full list at once" contract.
function failIfAny(problems, label) {
  const list = [...problems];
  if (list.length > 0) {
    throw new Error(
      `${label}: ${list.length} unresolved problem(s):\n  - ${list.join('\n  - ')}`,
    );
  }
}

// ============================================================
// 1. members → users + members
// ============================================================

// Source: Diamond members row (id, email, name, first_name, last_name,
// is_admin, created_at, ...). password_hash NEVER migrates — the users
// row gets NULL password_hash (allowed since migration 021) and every
// member gets a reset link in the welcome email. phone doesn't exist
// in Diamond, so it lands as null.
export function transformMemberAndUser(src) {
  const email = normalizeEmail(src.email, `source member ${src.id}`);
  const { first, last } = memberName(src);
  return {
    source_member_id: src.id,
    is_admin: !!src.is_admin,
    user: {
      email,
      first_name: first,
      last_name: last,
      created_at: src.created_at ?? null,
    },
    member: {
      email,
      first_name: first,
      last_name: last,
      phone: null,
      created_at: src.created_at ?? null,
    },
  };
}

// ============================================================
// 2. subscription state (inline on members) → subscriptions rows
// ============================================================

// Diamond stores only the CURRENT subscription state inline on the
// member row — no history table — so each member yields AT MOST ONE
// Courtside subscriptions row. Diamond's stripeController
// (handleSubscriptionUpdated) writes Stripe's RAW status string
// verbatim whenever it isn't 'active', so the full Stripe vocabulary
// can appear in a snapshot:
//
//   'active' | 'trialing'         → active
//   'past_due' | 'unpaid'         → past_due
//   'incomplete'                  → incomplete
//   'canceled' | 'cancelled' |
//     'incomplete_expired'        → cancelled, ended_at from
//                                   deactivated_at, else the period end
//   'inactive' + stripe sub id    → cancelled (a subscription existed
//                                   once; keep the row for history)
//   'inactive' without one        → null (never subscribed — no row)
//
// ANY other source value throws. A new value appearing in a snapshot
// means Stripe (or Diamond) changed under us, and guessing a mapping
// is exactly the failure mode this pipeline exists to prevent.
//
// current_period_start is unknowable from Diamond (only the period END
// is stored); 04_stripe_backfill trues it up from Stripe afterwards.
//
// An ACTIVE member with a null stripe_subscription_id still emits a
// row — dropping it would silently cancel a paying member. The driver
// reports those under the 'active_without_stripe' blocker and the
// load/verify gate decides.
//
// `planName` is the already-resolved Courtside plan name; the driver
// passes it after derivePlanRows has vetted the mapping, keeping this
// function pure and unit-testable without the map.
export function deriveSubscription(src, planName = null) {
  const email = normalizeEmail(src.email, `source member ${src.id}`);
  const base = {
    member_email: email,
    plan_name: planName,
    status: null,
    stripe_subscription_id: src.stripe_subscription_id ?? null,
    stripe_customer_id: src.stripe_customer_id ?? null,
    current_period_start: null,
    current_period_end: src.subscription_period_end ?? null,
    cancel_at_period_end: false,
    scheduled_deactivation_at: src.scheduled_deactivation_at ?? null,
    activated_at: src.created_at ?? null,
    ended_at: null,
  };
  switch (src.subscription_status) {
    case 'active':
    case 'trialing':
      return {
        ...base,
        status: 'active',
        // A scheduled deactivation on an active member is Diamond's
        // "cancel at period end" — the member cancelled but keeps
        // access until the period runs out.
        cancel_at_period_end: src.scheduled_deactivation_at != null,
      };
    case 'past_due':
    case 'unpaid':
      // Payment is behind but the subscription still exists — keep it
      // alive as past_due so the weekly reset skips them until
      // 04_stripe_backfill (or recovery) trues the state up.
      return { ...base, status: 'past_due' };
    case 'incomplete':
      // First payment never finished; Stripe may still resolve it
      // either way. Preserve the limbo rather than guessing.
      return { ...base, status: 'incomplete' };
    case 'canceled': // Stripe's raw spelling
    case 'cancelled':
    case 'incomplete_expired': // never got off the ground — terminal
      return {
        ...base,
        status: 'cancelled',
        ended_at: src.deactivated_at ?? src.subscription_period_end ?? null,
      };
    case 'inactive':
      if (src.stripe_subscription_id) {
        // Historical churn: Stripe once ran a subscription for this
        // member. Preserve it as cancelled rather than erasing the
        // billing history link.
        return {
          ...base,
          status: 'cancelled',
          ended_at: src.deactivated_at ?? src.subscription_period_end ?? null,
        };
      }
      return null;
    default:
      throw new Error(
        `member ${src.id} (${email}): unknown subscription_status ` +
          `${JSON.stringify(src.subscription_status)} — refusing to guess a mapping`,
      );
  }
}

// ============================================================
// 3. plan keys → plans rows
// ============================================================

// Distinct plan keys among members that will actually hold a
// subscription row (per deriveSubscription — members who never
// subscribed don't force a plan into the Courtside catalog).
//
// credits_per_week lives PER MEMBER in Diamond but PER PLAN in
// Courtside. Members sharing a key normally agree; when they don't,
// that's the 'plan_credits_mismatch' blocker — we take the MODE value
// so a dry run can proceed once the blocker is acknowledged, and the
// detail file lists every disagreeing member for the operator to
// reconcile (usually via an admin_adjustment after load).
//
// Mapping errors (unmapped key, TODO placeholders) are collected
// across every key and thrown as one list.
export function derivePlanRows(members, mapping) {
  const byKey = new Map();
  for (const m of members) {
    if (deriveSubscription(m) === null) continue;
    const list = byKey.get(m.plan) ?? [];
    list.push(m);
    byKey.set(m.plan, list);
  }

  const mappingErrors = [];
  const mismatchDetails = [];
  const plans = [];
  for (const [key, group] of byKey) {
    // Mode of credits_per_week, deterministic: highest count wins,
    // ties broken by the smaller value.
    const counts = new Map();
    for (const m of group) {
      counts.set(m.credits_per_week, (counts.get(m.credits_per_week) ?? 0) + 1);
    }
    const mode = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    )[0][0];
    if (counts.size > 1) {
      mismatchDetails.push({
        source_plan_key: key,
        used_credits_per_week: mode,
        members: group.map((m) => ({
          email: String(m.email ?? '').trim().toLowerCase(),
          credits_per_week: m.credits_per_week,
        })),
      });
    }

    let resolved;
    try {
      resolved = resolvePlan(mapping, key);
    } catch (err) {
      mappingErrors.push(err.message);
      continue;
    }
    plans.push({
      source_plan_key: key,
      name: resolved.name,
      monthly_price_cents: resolved.monthly_price_cents,
      credits_per_week: mode,
      stripe_price_id: resolved.stripe_price_id,
      active: true,
    });
  }
  failIfAny(mappingErrors, 'plan mapping incomplete — fix momentum.map.json');

  const blockers =
    mismatchDetails.length > 0
      ? [
          {
            code: 'plan_credits_mismatch',
            count: mismatchDetails.length,
            details: mismatchDetails,
          },
        ]
      : [];
  return { plans, blockers };
}

// ============================================================
// 4. purchased-credit split (P0 of the migration review)
// ============================================================

// Diamond has ONE credit pool. Courtside splits it (migration 024):
// subscription-week credits are SET to the plan allotment every Monday
// reset, while purchased_credits roll over forever and spend LAST.
// Migrating the whole balance into the subscription bucket would let
// the first Monday reset silently confiscate credits people PAID for —
// that's the P0 this function exists to prevent. The rule:
//
//   * subscription_status !== 'active': purchased = the ENTIRE
//     balance. A non-active member has no weekly allotment, and
//     Diamond's reset never touches non-active members, so their whole
//     balance is de-facto purchased/rollover. Classifying it as
//     pack-bucket matches source behavior exactly and protects the
//     balance if they later resubscribe.
//
//   * 'active': purchased = min(current_credits, Σ credits_amount over
//     grants with status='claimed' claimed since the member's last
//     weekly reset). Diamond's Monday reset (SET current_credits =
//     credits_per_week) already clawed back anything claimed BEFORE
//     last_reset, so only since-reset claims can still be in the pool.
//     Clamping to the current balance mirrors Courtside's draw-down
//     rule — subscription credits spend first, so anything the member
//     already spent came out of the weekly bucket before touching the
//     purchased amount.
//
// Grants with status 'pending' or 'refunded' never count: pending is a
// paid-for-but-unclaimed liability (its own blocker), refunded was
// paid back.
//
// referenceTimeMs is the snapshot moment. A claimed_at stamped AFTER
// it cannot be part of this snapshot's balance (clock skew / re-dumped
// file); excluding it keeps the function deterministic with respect to
// the snapshot rather than the wall clock.
export function computePurchasedCredits(memberSrc, balanceSrc, grantsForMember, referenceTimeMs) {
  const total = Number(balanceSrc?.current_credits ?? 0);
  if (memberSrc.subscription_status !== 'active') return total;

  // No recorded reset (fresh balance row) means nothing has ever been
  // clawed back — every claimed grant is still in play.
  const lastResetMs = balanceSrc?.last_reset ? Date.parse(balanceSrc.last_reset) : -Infinity;

  let claimedSinceReset = 0;
  for (const g of grantsForMember ?? []) {
    if (g.status !== 'claimed') continue;
    const claimedMs = Date.parse(g.claimed_at ?? '');
    if (!Number.isFinite(claimedMs)) {
      // Diamond stamps claimed_at in the same UPDATE that sets
      // status='claimed'; a claimed grant without one is an incoherent
      // snapshot, not a judgment call.
      throw new Error(
        `credit grant ${g.id}: status is 'claimed' but claimed_at is ` +
          `${JSON.stringify(g.claimed_at)} — snapshot is incoherent`,
      );
    }
    if (claimedMs < lastResetMs) continue;
    if (claimedMs > referenceTimeMs) continue;
    claimedSinceReset += Number(g.credits_amount);
  }
  return Math.min(total, claimedSinceReset);
}

// ============================================================
// 5. credit balances → balance + migration ledger row
// ============================================================

// One ledger row per member (reason 'migration') seeds the append-only
// ledger so the balance == latest balance_after invariant holds from
// row one. amount is null for zero balances — the loader skips the
// ledger insert entirely (apply_credit_change would likewise reject
// amount=0), keeping the ledger free of no-op rows.
export function transformCreditBalance(balanceSrc, memberSrc, grantsForMember, referenceTimeMs) {
  const email = normalizeEmail(memberSrc.email, `source member ${memberSrc.id}`);
  const credits = Number(balanceSrc?.current_credits);
  if (!Number.isInteger(credits) || credits < 0) {
    throw new Error(
      `bad credit balance for ${email}: ${JSON.stringify(balanceSrc?.current_credits)}`,
    );
  }
  const purchased = computePurchasedCredits(memberSrc, balanceSrc, grantsForMember, referenceTimeMs);
  return {
    balance: {
      member_email: email,
      current_credits: credits,
      purchased_credits: purchased,
      last_reset_at: balanceSrc?.last_reset ?? null,
    },
    ledger: {
      amount: credits === 0 ? null : credits,
      balance_after: credits,
      reason: 'migration',
      note: `migrated from Momentum at cutover (${purchased} of ${credits} purchased)`,
    },
  };
}

// ============================================================
// 6. bookings — Setmore export ∪ Diamond rows, deduped
// ============================================================

// Setmore is the canonical source for anything carrying an appointment
// id (it saw every walk-in AND every member booking that Diamond
// mirrored); Diamond rows are the fallback for bookings that never hit
// Setmore or predate the mirror. Merge rules:
//
//   * Each Setmore record: Diamond row with the same appointment id →
//     member booking (member identity from the Diamond side); else a
//     customer_email matching a member's email → member booking; else
//     a walk-in.
//   * Walk-ins REQUIRE first+last+email (the Courtside CHECK). Rows
//     missing name or email go to exceptions.walkins_missing_contact —
//     and, when confirmed AND future-dated at the snapshot moment,
//     ALSO to the 'future_walkins_missing_contact' blocker, because a
//     future appointment we can't import is a person who will show up
//     to a slot Courtside doesn't know is taken.
//   * Setmore start/end are NAIVE local wall-clock — they parse via
//     parseSourceTimestamp in mapping.timezone (bare Date.parse would
//     shift every booking by the HOST's offset). A mapped
//     setmore_columns.date column (split-export format) is joined as
//     '<date> <time>' first. Diamond rows keep Date.parse — they are
//     timestamptz, already absolute.
//   * Diamond rows with no Setmore twin import as external_source
//     'diamond' IF they carry start/end times; rows predating Diamond
//     migration 004 have neither and go to exceptions.timeless_bookings
//     (reason 'missing_times') as the archive trail.
//   * end <= start cannot load (Courtside CHECK end_time > start_time).
//     Past rows archive to exceptions.timeless_bookings with reason
//     'invalid_times'; a FUTURE confirmed row with a broken window is
//     a corrupt export — hard error.
//   * status 'confirmed' with start_time before referenceTimeMs
//     becomes 'completed'; cancellations get an approximated
//     cancelled_at (see MIGRATED_CANCELLATION_REASON); no-shows mark
//     no_show_marked_at = end_time.
//   * credit_cost_charged for member bookings is the CURRENT
//     credits_cost of the source service — Diamond never snapshotted
//     the per-booking cost (approximation documented in
//     SOURCE_SCHEMA.md). Walk-ins charge 0 credits; all money fields
//     are 0 with payment_status 'not_required' because Setmore carries
//     no payment data.
//   * Duplicate external ids in the merged output mean a corrupt
//     export — hard error.
//
// Mapping/data gaps (unmapped service/staff/status, unparseable times,
// members or services missing from the snapshot) are collected across
// the whole dataset and thrown as one list.
export function mergeBookings({
  diamondBookings,
  servicesById,
  memberById,
  setmoreRecords,
  mapping,
  referenceTimeMs,
}) {
  const problems = new Set();
  const rows = [];
  const timelessBookings = [];
  const walkinsMissingContact = [];
  const futureWalkinsMissingContact = [];
  const seenExternalIds = new Set();

  // Column resolution only matters when there IS an export — a
  // double-opted skip must not trip over TODO headers in the map.
  const cols = setmoreRecords.length > 0 ? resolveSetmoreColumns(mapping) : null;

  const servicesByName = new Map();
  for (const s of servicesById.values()) servicesByName.set(s.name, s);

  const memberByEmail = new Map();
  for (const m of memberById.values()) {
    memberByEmail.set(String(m.email ?? '').trim().toLowerCase(), m);
  }

  const diamondBySetmoreId = new Map();
  for (const b of diamondBookings) {
    if (b.setmore_appointment_id) diamondBySetmoreId.set(b.setmore_appointment_id, b);
  }
  const consumedDiamondIds = new Set();

  // Uniform status/time mapping for both sources.
  const statusFields = (mapped, { startIso, endIso, startMs, bookedAt }) => {
    switch (mapped) {
      case 'completed':
        return { status: 'completed', cancelled_at: null, cancellation_reason: null, no_show_marked_at: null };
      case 'confirmed':
        return {
          status: startMs < referenceTimeMs ? 'completed' : 'confirmed',
          cancelled_at: null,
          cancellation_reason: null,
          no_show_marked_at: null,
        };
      case 'cancelled':
        return {
          status: 'cancelled',
          cancelled_at: bookedAt ?? startIso,
          cancellation_reason: MIGRATED_CANCELLATION_REASON,
          no_show_marked_at: null,
        };
      case 'no_show':
        return { status: 'no_show', cancelled_at: null, cancellation_reason: null, no_show_marked_at: endIso };
      default:
        throw new Error(`unknown mapped booking status ${JSON.stringify(mapped)}`);
    }
  };

  const pushRow = (source, externalId, fields) => {
    const key = `${source}:${externalId}`;
    if (seenExternalIds.has(key)) {
      problems.add(`duplicate external id in merged bookings: ${key} — export is corrupt`);
      return;
    }
    seenExternalIds.add(key);
    rows.push({
      external_source: source,
      external_id: externalId,
      member_email: fields.memberEmail,
      customer_first_name: fields.contact?.first ?? null,
      customer_last_name: fields.contact?.last ?? null,
      customer_email: fields.contact?.email ?? null,
      customer_phone: fields.contact?.phone ?? null,
      offering_name: fields.offeringName,
      resource_name: fields.resourceName,
      start_time: fields.startIso,
      end_time: fields.endIso,
      ...fields.statusBits,
      credit_cost_charged: fields.creditCost,
      amount_due_cents: 0,
      amount_paid_cents: 0,
      amount_refunded_cents: 0,
      payment_status: 'not_required',
      created_at: fields.createdAt ?? null,
    });
  };

  // ---- Setmore records (canonical for their appointment ids) -------
  for (const rec of setmoreRecords) {
    const externalId = String(rec[cols.appointment_id] ?? '').trim();
    if (!externalId) {
      problems.add(
        `setmore record with empty ${JSON.stringify(cols.appointment_id)} — export is corrupt`,
      );
      continue;
    }

    let ok = true;
    let mappedStatus = null;
    try {
      mappedStatus = resolveSetmoreStatus(mapping, rec[cols.status]);
    } catch (err) {
      problems.add(err.message);
      ok = false;
    }

    const service = servicesByName.get(rec[cols.service_name]);
    let offeringName = null;
    if (!service) {
      problems.add(
        `setmore service ${JSON.stringify(rec[cols.service_name])} has no matching Diamond service`,
      );
      ok = false;
    } else {
      try {
        offeringName = resolveOffering(mapping, service.name);
      } catch (err) {
        problems.add(err.message);
        ok = false;
      }
    }

    let resourceName = null;
    try {
      resourceName = resolveResource(mapping, rec[cols.staff_key]);
    } catch (err) {
      problems.add(err.message);
      ok = false;
    }

    // Naive wall-clock in the tenant's zone; a split-export date
    // column, when mapped, is joined onto the bare times first.
    const rawStart = cols.date
      ? `${rec[cols.date] ?? ''} ${rec[cols.start_time] ?? ''}`
      : rec[cols.start_time];
    const rawEnd = cols.date
      ? `${rec[cols.date] ?? ''} ${rec[cols.end_time] ?? ''}`
      : rec[cols.end_time];
    let startMs = NaN;
    let endMs = NaN;
    try {
      startMs = parseSourceTimestamp(rawStart, mapping.timezone);
      endMs = parseSourceTimestamp(rawEnd, mapping.timezone);
    } catch (err) {
      problems.add(`setmore appointment ${externalId}: ${err.message}`);
      ok = false;
    }
    if (!ok) continue;

    // A zero/negative window can't load (Courtside CHECK end_time >
    // start_time). Past rows archive beside the timeless ones; a
    // FUTURE confirmed row with a broken window is a corrupt export.
    if (endMs <= startMs) {
      if (mappedStatus === 'confirmed' && startMs >= referenceTimeMs) {
        problems.add(
          `setmore appointment ${externalId}: end <= start on a future confirmed ` +
            `booking — export is corrupt`,
        );
      } else {
        timelessBookings.push({ ...rec, reason: 'invalid_times' });
      }
      continue;
    }

    const startIso = toIso(startMs);
    const endIso = toIso(endMs);

    // Identity: Diamond twin (by appointment id) → member; email match
    // against members → member; else walk-in.
    const diamondRow = diamondBySetmoreId.get(externalId);
    const customerEmail = String(rec[cols.customer_email] ?? '').trim().toLowerCase();
    let member = null;
    let bookedAt = null;
    let costService = service;
    if (diamondRow) {
      consumedDiamondIds.add(diamondRow.id);
      member = memberById.get(diamondRow.member_id);
      if (!member) {
        problems.add(
          `diamond booking ${diamondRow.id}: member ${diamondRow.member_id} not in snapshot`,
        );
        continue;
      }
      bookedAt = diamondRow.booked_at ?? null;
      // Diamond's own service link is the truth for what was charged.
      costService = servicesById.get(diamondRow.service_id) ?? service;
    } else if (customerEmail && memberByEmail.has(customerEmail)) {
      member = memberByEmail.get(customerEmail);
    }

    if (member) {
      pushRow('setmore', externalId, {
        memberEmail: String(member.email).trim().toLowerCase(),
        contact: null,
        offeringName,
        resourceName,
        startIso,
        endIso,
        startMs,
        statusBits: statusFields(mappedStatus, { startIso, endIso, startMs, bookedAt }),
        creditCost: Number(costService.credits_cost ?? 0),
        createdAt: bookedAt,
      });
      continue;
    }

    // Walk-in: contact is mandatory (Courtside CHECK). Emails with
    // embedded whitespace count as missing — they'd fail the DB
    // normalization CHECK at load time anyway.
    const rawName = String(rec[cols.customer_name] ?? '').trim();
    const emailOk = customerEmail !== '' && !/\s/.test(customerEmail);
    if (!rawName || !emailOk) {
      walkinsMissingContact.push(rec);
      if (mappedStatus === 'confirmed' && startMs >= referenceTimeMs) {
        futureWalkinsMissingContact.push(rec);
      }
      continue;
    }
    const { first, last } = splitOnFirstSpace(rawName);
    pushRow('setmore', externalId, {
      memberEmail: null,
      contact: {
        first,
        last,
        email: customerEmail,
        phone: String(rec[cols.customer_phone] ?? '').trim() || null,
      },
      offeringName,
      resourceName,
      startIso,
      endIso,
      startMs,
      statusBits: statusFields(mappedStatus, { startIso, endIso, startMs, bookedAt: null }),
      creditCost: 0,
      createdAt: null,
    });
  }

  // ---- Diamond rows with no Setmore twin ---------------------------
  for (const b of diamondBookings) {
    if (consumedDiamondIds.has(b.id)) continue;

    // Rows predating Diamond migration 004 have no times and cannot
    // become Courtside bookings (start/end are NOT NULL + exclusion-
    // constrained). The exceptions file is their archive trail.
    if (!b.start_time || !b.end_time) {
      timelessBookings.push({ ...b, reason: 'missing_times' });
      continue;
    }

    let ok = true;
    const member = memberById.get(b.member_id);
    if (!member) {
      problems.add(`diamond booking ${b.id}: member ${b.member_id} not in snapshot`);
      ok = false;
    }
    const service = servicesById.get(b.service_id);
    let offeringName = null;
    if (!service) {
      problems.add(`diamond booking ${b.id}: service ${b.service_id} not in snapshot`);
      ok = false;
    } else {
      try {
        offeringName = resolveOffering(mapping, service.name);
      } catch (err) {
        problems.add(err.message);
        ok = false;
      }
    }
    let resourceName = null;
    if (b.staff_key == null) {
      problems.add(
        `diamond booking ${b.id}: staff_key is null — cannot resolve a Courtside resource`,
      );
      ok = false;
    } else {
      try {
        resourceName = resolveResource(mapping, b.staff_key);
      } catch (err) {
        problems.add(err.message);
        ok = false;
      }
    }
    if (!['confirmed', 'cancelled', 'completed'].includes(b.status)) {
      problems.add(
        `diamond booking ${b.id}: unknown status ${JSON.stringify(b.status)} — refusing to guess`,
      );
      ok = false;
    }
    // Diamond times are timestamptz — already absolute; Date.parse is
    // correct here (contrast the naive Setmore wall-clock above).
    const startMs = Date.parse(b.start_time);
    const endMs = Date.parse(b.end_time);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      problems.add(`diamond booking ${b.id}: unparseable start/end time`);
      ok = false;
    }
    if (!ok) continue;

    // Same end <= start rule as the Setmore side.
    if (endMs <= startMs) {
      if (b.status === 'confirmed' && startMs >= referenceTimeMs) {
        problems.add(
          `diamond booking ${b.id}: end <= start on a future confirmed booking — ` +
            `export is corrupt`,
        );
      } else {
        timelessBookings.push({ ...b, reason: 'invalid_times' });
      }
      continue;
    }

    const startIso = toIso(startMs);
    const endIso = toIso(endMs);
    pushRow('diamond', String(b.id), {
      memberEmail: String(member.email).trim().toLowerCase(),
      contact: null,
      offeringName,
      resourceName,
      startIso,
      endIso,
      startMs,
      statusBits: statusFields(b.status, {
        startIso,
        endIso,
        startMs,
        bookedAt: b.booked_at ?? null,
      }),
      creditCost: Number(service.credits_cost ?? 0),
      createdAt: b.booked_at ?? null,
    });
  }

  failIfAny(problems, 'booking merge');

  const blockers =
    futureWalkinsMissingContact.length > 0
      ? [
          {
            code: 'future_walkins_missing_contact',
            count: futureWalkinsMissingContact.length,
            details: futureWalkinsMissingContact,
          },
        ]
      : [];
  return {
    rows,
    exceptions: {
      timeless_bookings: timelessBookings,
      walkins_missing_contact: walkinsMissingContact,
    },
    blockers,
  };
}

// Fail fast when the export's header doesn't carry every mapped
// column (including the optional date column when set) — a renamed
// Setmore header would otherwise surface as hundreds of per-row
// empty-field/unparseable-time errors instead of one clear gap. The
// error lists the missing mapped names AND the actual header verbatim
// so the operator can fix momentum.map.json by inspection.
export function validateSetmoreHeader(header, mapping) {
  const cols = resolveSetmoreColumns(mapping);
  const missing = Object.values(cols).filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `setmore export header is missing mapped column(s): ` +
        `${missing.map((n) => JSON.stringify(n)).join(', ')} — actual header: ` +
        `${JSON.stringify(header)} — fix momentum.map.json setmore_columns ` +
        `to match the export`,
    );
  }
  return cols;
}

// ============================================================
// 7. credit grants → exceptions (nothing loads; everything counts)
// ============================================================

// Gift cards / purchased sessions. 'claimed' grants already live in
// the member's balance (see computePurchasedCredits) — the grant rows
// themselves never load. 'pending' grants are money paid for credits
// NOBODY has received yet — expired or not, that's an outstanding
// liability the operator must resolve (refund, or manual grant after
// cutover), so every one goes to exceptions AND the 'pending_gifts'
// blocker. 'refunded' grants are archive-only.
export function deriveCreditGrantExceptions(grants, referenceTimeMs) {
  const pending = [];
  const refunded = [];
  const unknown = [];
  for (const g of grants) {
    if (g.status === 'pending') {
      pending.push({
        ...g,
        // Operator convenience: whether the claim link had already
        // lapsed at the snapshot moment. Expired pending gifts are
        // still liabilities — the buyer paid.
        expired_at_snapshot:
          g.claim_token_expires_at != null &&
          Date.parse(g.claim_token_expires_at) < referenceTimeMs,
      });
    } else if (g.status === 'refunded') {
      refunded.push(g);
    } else if (g.status !== 'claimed') {
      unknown.push(`credit grant ${g.id}: unknown status ${JSON.stringify(g.status)}`);
    }
  }
  failIfAny(unknown, 'credit grant triage');

  const blockers =
    pending.length > 0
      ? [{ code: 'pending_gifts', count: pending.length, details: pending }]
      : [];
  return { pending, refunded, blockers };
}

// ============================================================
// driver
// ============================================================

// 01_snapshot_source records a deliberate Setmore skip in the
// manifest's `skips` list ({ file, reason }). Skipping means NO
// walk-in history migrates, so it takes a double opt-in: once at
// snapshot time, and AGAIN via SETMORE_EXPORT_SKIP=1 at transform
// time — an operator rerunning 02 weeks later must re-affirm, not
// inherit, that decision.
function setmoreSkipRecorded(sourceManifest) {
  return (
    Array.isArray(sourceManifest.skips) &&
    sourceManifest.skips.some((s) => s?.file === 'setmore_bookings.csv')
  );
}

async function main() {
  banner('02 transform');

  const tenantId = (process.env.MIGRATION_TENANT_ID ?? '').trim();
  if (!tenantId) {
    throw new Error(
      'MIGRATION_TENANT_ID is required — the transformed manifest records ' +
        'the tenant every row will be stamped with at load time',
    );
  }

  // ---- verified inputs only ----------------------------------------
  const sourceManifest = await readManifest(SRC_DIR, 'source');
  requireFiles(sourceManifest, [
    'members.json',
    'services.json',
    'credit_balances.json',
    'bookings.json',
    'credit_grants.json',
    'member_status_changes.json',
  ]);
  const membersSrc = await readVerified(SRC_DIR, sourceManifest, 'members.json');
  const servicesSrc = await readVerified(SRC_DIR, sourceManifest, 'services.json');
  const balancesSrc = await readVerified(SRC_DIR, sourceManifest, 'credit_balances.json');
  const bookingsSrc = await readVerified(SRC_DIR, sourceManifest, 'bookings.json');
  const grantsSrc = await readVerified(SRC_DIR, sourceManifest, 'credit_grants.json');
  // Archive-only: verified for snapshot integrity, transformed into
  // nothing — Courtside has no status-change history table.
  const statusChangesSrc = await readVerified(
    SRC_DIR,
    sourceManifest,
    'member_status_changes.json',
  );

  const mapping = await loadMapping(MAP_PATH);

  // Lineage stamp: the hash of the EXACT source manifest bytes this
  // transform consumed. 05_verify recomputes it so a transformed
  // directory can never be verified against a different snapshot run.
  const sourceManifestSha256 = await sha256File(join(SRC_DIR, MANIFEST_NAME));

  let setmoreRecords = [];
  let setmoreSkipped = false;
  if (sourceManifest.files?.['setmore_bookings.csv']) {
    const csvText = await readVerified(SRC_DIR, sourceManifest, 'setmore_bookings.csv', {
      raw: true,
    });
    const parsed = parseCsv(csvText);
    // One clear header-vs-map error beats hundreds of per-row ones.
    validateSetmoreHeader(parsed.header, mapping);
    setmoreRecords = parsed.records;
  } else if (setmoreSkipRecorded(sourceManifest)) {
    if (process.env.SETMORE_EXPORT_SKIP !== '1') {
      throw new Error(
        'the source snapshot recorded a Setmore export skip — walk-in ' +
          'history will NOT migrate. If that is still the intent, re-affirm ' +
          'with SETMORE_EXPORT_SKIP=1 at transform time (double opt-in); ' +
          'otherwise re-run 01_snapshot_source with the export in place.',
      );
    }
    setmoreSkipped = true;
  } else {
    throw new Error(
      'setmore_bookings.csv is neither listed in the source manifest nor ' +
        'recorded as an explicit skip — refusing to guess whether walk-in ' +
        'history exists. Re-run 01_snapshot_source.',
    );
  }

  // Past/future is judged against the SNAPSHOT moment, not the wall
  // clock — reruns of the transform stay deterministic.
  const referenceTimeMs = Date.parse(sourceManifest.created_at);
  if (!Number.isFinite(referenceTimeMs)) {
    throw new Error(
      `source manifest created_at is unparseable: ${JSON.stringify(sourceManifest.created_at)}`,
    );
  }

  info('inputs verified', {
    members: membersSrc.length,
    services: servicesSrc.length,
    balances: balancesSrc.length,
    diamond_bookings: bookingsSrc.length,
    credit_grants: grantsSrc.length,
    member_status_changes: statusChangesSrc.length,
    setmore_records: setmoreRecords.length,
    setmore_skipped: setmoreSkipped,
    reference_time: toIso(referenceTimeMs),
  });

  // ---- members + users (collect every bad row before failing) ------
  const memberErrors = [];
  const transformedAll = [];
  for (const m of membersSrc) {
    try {
      transformedAll.push({ src: m, out: transformMemberAndUser(m) });
    } catch (err) {
      memberErrors.push(err.message);
    }
  }
  failIfAny(memberErrors, 'member/user transform');

  // Diamond's email uniqueness is case-SENSITIVE; ours is normalized.
  // Collisions after lowercasing keep the earliest-created member (a
  // stable, explainable choice) and surface as the 'duplicate_emails'
  // blocker with every colliding source row in the detail file.
  const byEmail = new Map();
  for (const t of transformedAll) {
    const list = byEmail.get(t.out.user.email) ?? [];
    list.push(t);
    byEmail.set(t.out.user.email, list);
  }
  const kept = [];
  const duplicateGroups = [];
  let duplicateMemberCount = 0;
  // Rows NOT migrated (group size minus the kept one). The manifest's
  // exceptions.duplicate_emails carries this so 05_verify can
  // reconcile: source members.json rows = migrated members + dropped.
  let droppedDuplicateCount = 0;
  for (const [email, list] of byEmail) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }
    const ordered = [...list].sort((a, b) => {
      const ta = Date.parse(a.src.created_at ?? '') || 0;
      const tb = Date.parse(b.src.created_at ?? '') || 0;
      return ta - tb || String(a.src.id).localeCompare(String(b.src.id));
    });
    kept.push(ordered[0]);
    duplicateMemberCount += ordered.length;
    droppedDuplicateCount += ordered.length - 1;
    duplicateGroups.push({
      email,
      kept_source_member_id: ordered[0].src.id,
      members: ordered.map((t) => t.src),
    });
  }
  const keptSrc = kept.map((t) => t.src);
  const usersAndMembers = kept.map((t) => t.out);

  // Admins are created manually per the runbook (they need real
  // credentials + the tenant_admin role, neither of which migrates) —
  // but they were ALSO regular members with credits and bookings, so
  // they still import as members. The exceptions file is the runbook's
  // checklist of who needs the manual admin setup.
  const adminDetails = kept
    .filter((t) => t.out.is_admin)
    .map((t) => ({
      email: t.out.user.email,
      first_name: t.out.user.first_name,
      last_name: t.out.user.last_name,
    }));

  // ---- subscriptions -----------------------------------------------
  const subErrors = [];
  const subPairs = [];
  for (const m of keptSrc) {
    try {
      const row = deriveSubscription(m);
      if (row) subPairs.push({ src: m, row });
    } catch (err) {
      subErrors.push(err.message);
    }
  }
  failIfAny(subErrors, 'subscription derivation');

  // ---- plans (throws listing every mapping gap) --------------------
  const { plans, blockers: planBlockers } = derivePlanRows(keptSrc, mapping);
  const planNameByKey = new Map(plans.map((p) => [p.source_plan_key, p.name]));
  const subscriptions = subPairs.map(({ src, row }) => ({
    ...row,
    plan_name: planNameByKey.get(src.plan) ?? null,
  }));

  // Active members whose Stripe link is missing still get their
  // subscription row (dropping it would silently cancel a paying
  // member) — the blocker forces the operator to decide before load.
  const activeWithoutStripe = subscriptions
    .filter((s) => s.status === 'active' && !s.stripe_subscription_id)
    .map((s) => ({ member_email: s.member_email, plan_name: s.plan_name }));

  // ---- credit balances + purchased split ---------------------------
  // Claimed grants attribute to a member via recipient_member_id,
  // falling back to recipient_email (self-purchases sometimes predate
  // the recipient link). Dropped duplicate-email members re-attribute
  // through their shared email to the kept identity. A claimed grant
  // that matches no migrated member affects nothing here — its credits
  // are already inside (or already spent from) whatever balance
  // consumed them; the split only refines ACTIVE members' buckets.
  const emailByMemberId = new Map(
    transformedAll.map((t) => [t.src.id, t.out.user.email]),
  );
  const keptIdByEmail = new Map(kept.map((t) => [t.out.user.email, t.src.id]));
  const grantsByKeptMember = new Map();
  for (const g of grantsSrc) {
    if (g.status !== 'claimed') continue;
    const email = g.recipient_member_id
      ? emailByMemberId.get(g.recipient_member_id)
      : String(g.recipient_email ?? '').trim().toLowerCase() || null;
    const keptId = email ? keptIdByEmail.get(email) : null;
    if (!keptId) continue;
    const list = grantsByKeptMember.get(keptId) ?? [];
    list.push(g);
    grantsByKeptMember.set(keptId, list);
  }

  const balanceByMemberId = new Map(balancesSrc.map((b) => [b.member_id, b]));
  const balanceErrors = [];
  const creditBalances = [];
  for (const m of keptSrc) {
    // A member without a balance row simply has zero credits — Diamond
    // creates the row lazily. Synthesize the zero so every migrated
    // member gets a Courtside balance row.
    const balanceSrc =
      balanceByMemberId.get(m.id) ?? { member_id: m.id, current_credits: 0, last_reset: null };
    try {
      creditBalances.push(
        transformCreditBalance(balanceSrc, m, grantsByKeptMember.get(m.id) ?? [], referenceTimeMs),
      );
    } catch (err) {
      balanceErrors.push(err.message);
    }
  }
  failIfAny(balanceErrors, 'credit balance transform');

  // ---- credit grant exceptions -------------------------------------
  const {
    pending: pendingGifts,
    refunded: refundedGifts,
    blockers: grantBlockers,
  } = deriveCreditGrantExceptions(grantsSrc, referenceTimeMs);

  // ---- bookings ----------------------------------------------------
  // memberById includes DROPPED duplicate members on purpose: their
  // bookings resolve through the shared (lowercased) email to the kept
  // member identity.
  const memberById = new Map(membersSrc.map((m) => [m.id, m]));
  const servicesById = new Map(servicesSrc.map((s) => [s.id, s]));
  const {
    rows: bookingRows,
    exceptions: bookingExceptions,
    blockers: bookingBlockers,
  } = mergeBookings({
    diamondBookings: bookingsSrc,
    servicesById,
    memberById,
    setmoreRecords,
    mapping,
    referenceTimeMs,
  });

  // ---- write outputs (everything hashed, exceptions included) ------
  await mkdir(join(OUT_DIR, 'exceptions'), { recursive: true });
  const files = {};
  const emit = async (name, data) => {
    files[name] = await writeJsonWithHash(OUT_DIR, name, data);
  };

  await emit('users_and_members.json', usersAndMembers);
  await emit('plans.json', plans);
  await emit('subscriptions.json', subscriptions);
  await emit('credit_balances.json', creditBalances);
  await emit('bookings.json', bookingRows);

  // Exceptions files are written even when empty so the manifest shape
  // (and any tooling reading it) stays stable run to run.
  await emit('exceptions/pending_gifts.json', pendingGifts);
  await emit('exceptions/refunded_gifts.json', refundedGifts);
  await emit('exceptions/admins.json', adminDetails);
  await emit('exceptions/duplicate_emails.json', duplicateGroups);
  await emit('exceptions/active_without_stripe.json', activeWithoutStripe);
  await emit('exceptions/plan_credits_mismatch.json', planBlockers[0]?.details ?? []);
  await emit('exceptions/timeless_bookings.json', bookingExceptions.timeless_bookings);
  await emit('exceptions/walkins_missing_contact.json', bookingExceptions.walkins_missing_contact);
  await emit(
    'exceptions/future_walkins_missing_contact.json',
    bookingBlockers[0]?.details ?? [],
  );

  const countStatus = (s) => bookingRows.filter((b) => b.status === s).length;
  const expected = {
    members: usersAndMembers.length,
    users: usersAndMembers.length,
    subscriptions: {
      active: subscriptions.filter((s) => s.status === 'active').length,
      past_due: subscriptions.filter((s) => s.status === 'past_due').length,
      incomplete: subscriptions.filter((s) => s.status === 'incomplete').length,
      cancelled: subscriptions.filter((s) => s.status === 'cancelled').length,
    },
    total_credits: creditBalances.reduce((n, r) => n + r.balance.current_credits, 0),
    total_purchased_credits: creditBalances.reduce((n, r) => n + r.balance.purchased_credits, 0),
    bookings: {
      total: bookingRows.length,
      completed: countStatus('completed'),
      // All still-'confirmed' rows are future by construction (past
      // confirmed became completed against referenceTimeMs).
      confirmed_future: countStatus('confirmed'),
      cancelled: countStatus('cancelled'),
      no_show: countStatus('no_show'),
    },
  };
  const exceptionCounts = {
    pending_gifts: pendingGifts.length,
    refunded_gifts: refundedGifts.length,
    admins: adminDetails.length,
    // DROPPED source member rows (0 when none) — 05_verify adds this
    // to expected.members to reconcile against source members.json.
    duplicate_emails: droppedDuplicateCount,
    timeless_bookings: bookingExceptions.timeless_bookings.length,
    walkins_missing_contact: bookingExceptions.walkins_missing_contact.length,
  };

  const blockers = [];
  if (grantBlockers.length > 0) {
    blockers.push({
      code: 'pending_gifts',
      count: grantBlockers[0].count,
      detail_file: 'exceptions/pending_gifts.json',
    });
  }
  if (duplicateMemberCount > 0) {
    blockers.push({
      code: 'duplicate_emails',
      count: duplicateMemberCount,
      detail_file: 'exceptions/duplicate_emails.json',
    });
  }
  if (activeWithoutStripe.length > 0) {
    blockers.push({
      code: 'active_without_stripe',
      count: activeWithoutStripe.length,
      detail_file: 'exceptions/active_without_stripe.json',
    });
  }
  if (planBlockers.length > 0) {
    blockers.push({
      code: 'plan_credits_mismatch',
      count: planBlockers[0].count,
      detail_file: 'exceptions/plan_credits_mismatch.json',
    });
  }
  if (bookingBlockers.length > 0) {
    blockers.push({
      code: 'future_walkins_missing_contact',
      count: bookingBlockers[0].count,
      detail_file: 'exceptions/future_walkins_missing_contact.json',
    });
  }

  // Gate BEFORE the manifest is written — but on failure the manifest
  // still gets written (with acknowledged_blockers: []) so the operator
  // has the blocker list + detail files to inspect, THEN we exit 1.
  let acknowledged = [];
  let blockerFailure = null;
  try {
    acknowledged = enforceBlockers(blockers);
  } catch (err) {
    blockerFailure = err;
  }

  await writeManifest(OUT_DIR, {
    kind: 'transformed',
    tenant_id: tenantId,
    source_manifest_sha256: sourceManifestSha256,
    ...(setmoreSkipped ? { setmore_export_skipped: true } : {}),
    files,
    expected,
    exceptions: exceptionCounts,
    blockers,
    acknowledged_blockers: acknowledged,
  });

  // Reconciliation summary — the numbers 05_verify will hold the live
  // DB to, plus everything deliberately left behind.
  info('reconciliation', {
    ...expected,
    exceptions: exceptionCounts,
    blockers: blockers.map((b) => `${b.code}(${b.count})`),
    acknowledged_blockers: acknowledged,
    member_status_changes_archived: statusChangesSrc.length,
  });

  if (blockerFailure) {
    logError('transform FAILED on unresolved blockers — manifest written for inspection', {
      blockers: blockers.map((b) => b.code),
    });
    throw blockerFailure;
  }
  info('transform complete', { out_dir: OUT_DIR });
}

// Only run when invoked as a script. Tests import the transformer
// functions directly.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('transform failed:', err);
    process.exit(1);
  });
}
