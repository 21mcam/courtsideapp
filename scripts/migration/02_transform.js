// 02_transform.js — Momentum source rows → Courtside row shape.
//
// Pure functions over JSON. No DB access. No I/O except reading
// the source JSON and writing the transformed JSON.
//
// The transformers are exported individually so tests can drive each
// one with sample input. Keeps verification incremental — discover a
// bad email-normalization rule on a test fixture, not at 6:30am during
// cutover.
//
// ID strategy: transformers do NOT resolve Momentum ids to Courtside
// UUIDs. They (a) stamp rows the migration creates with a
// deterministic UUIDv5 (see shared/ids.js) so loads are idempotent,
// and (b) carry the Momentum id through as `source_*_id` fields.
// 03_load.js builds source→Courtside maps as it inserts (RETURNING id)
// and resolves the references — the only step that can know the final
// ids, because pre-existing rows (wizard-created catalog, an
// already-signed-up member) are adopted by natural key at load time.
//
// Validation policy: a transformer THROWS on any row it cannot map to
// a shape the destination schema accepts (see db/migrations/007 CHECK
// constraints). The driver must catch per-row and collect rejects for
// manual review — a single dirty Setmore row must not kill the run.
//
// Type contracts below are docs only — JS doesn't enforce them. When
// this graduates to TypeScript (or starts using zod for validation
// at the I/O boundary) the contracts move into actual schemas.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info } from './shared/log.js';
import { migrationId } from './shared/ids.js';

const SRC_DIR = new URL('./out/source/', import.meta.url).pathname;
const OUT_DIR = new URL('./out/transformed/', import.meta.url).pathname;

// ============================================================
// row transformers
// ============================================================

// Source: { id, email, password_hash?, first_name, last_name,
//           phone?, created_at }
// Target user: { tenant_id, email (lowercased), first_name, last_name,
//                created_at } — we DON'T migrate password_hash;
//                we email a reset token to every member instead.
// Target member: { id (deterministic), source_id, tenant_id, email,
//                  first_name, last_name, phone, created_at } —
//                  user_id is linked by load.js after the user upsert.
export function transformMemberAndUser(src, tenant_id) {
  if (src.id == null) {
    throw new Error(`source user missing id: ${JSON.stringify(src.email)}`);
  }
  const email = String(src.email ?? '').trim().toLowerCase();
  if (!email || /\s/.test(email)) {
    throw new Error(`bad email for source user ${src.id}: ${JSON.stringify(src.email)}`);
  }
  const first = String(src.first_name ?? '').trim();
  const last = String(src.last_name ?? '').trim();
  if (!first || !last) {
    throw new Error(`source user ${src.id} missing first/last name`);
  }
  return {
    user: {
      tenant_id,
      email,
      first_name: first,
      last_name: last,
      // password_hash intentionally omitted — reset flow seeds it
      created_at: src.created_at,
    },
    member: {
      id: migrationId(tenant_id, 'members', src.id),
      source_id: String(src.id),
      tenant_id,
      email,
      first_name: first,
      last_name: last,
      phone: src.phone ?? null,
      created_at: src.created_at,
    },
  };
}

// Source: { id, member_id (Momentum's), stripe_subscription_id,
//           stripe_customer_id, status (Momentum's enum),
//           current_period_start, current_period_end,
//           cancel_at_period_end, cancelled_at?, ended_at?,
//           plan_id (Momentum's), activated_at?, created_at }
// Target subscription: Courtside subscriptions row + source_member_id.
// Target plan_period: subscription_plan_periods row + source_plan_id.
//
// Terminal (cancelled) subscriptions get subscriptions.ended_at AND a
// CLOSED plan period — leaving the period open would make webhook
// plan resolution and the one-open-period verify check lie.
export function transformSubscription(src, tenant_id) {
  if (src.id == null) {
    throw new Error(`source subscription missing id (member ${src.member_id})`);
  }
  if (src.member_id == null) {
    throw new Error(`source sub ${src.id}: missing member_id`);
  }
  if (src.plan_id == null) {
    throw new Error(`source sub ${src.id}: missing plan_id`);
  }

  const status = mapMomentumSubStatus(src.status, src.id);
  const terminal = status === 'cancelled';

  const started_at = src.activated_at ?? src.created_at ?? null;

  // Period bounds CHECK: end > start when both set.
  const cps = parseTs(src.current_period_start, `sub ${src.id} current_period_start`, { optional: true });
  const cpe = parseTs(src.current_period_end, `sub ${src.id} current_period_end`, { optional: true });
  if (cps != null && cpe != null && cpe <= cps) {
    throw new Error(`source sub ${src.id}: current_period_end <= current_period_start`);
  }

  let ended_at = null;
  if (terminal) {
    ended_at = src.cancelled_at ?? src.ended_at ?? src.current_period_end ?? null;
    if (ended_at == null) {
      throw new Error(
        `source sub ${src.id}: cancelled but no cancelled_at/ended_at/current_period_end to close the plan period with`,
      );
    }
    if (started_at == null) {
      throw new Error(`source sub ${src.id}: cancelled but no activated_at/created_at to open the plan period with`);
    }
    const s = parseTs(started_at, `sub ${src.id} started_at`);
    const e = parseTs(ended_at, `sub ${src.id} ended_at`);
    // subscription_plan_periods CHECK (ended_at > started_at)
    if (e <= s) {
      throw new Error(`source sub ${src.id}: cancellation timestamp <= start; resolve manually`);
    }
  }

  return {
    subscription: {
      id: migrationId(tenant_id, 'subscriptions', src.id),
      tenant_id,
      source_member_id: String(src.member_id),
      status,
      stripe_subscription_id: src.stripe_subscription_id ?? null,
      stripe_customer_id: src.stripe_customer_id ?? null,
      current_period_start: src.current_period_start ?? null,
      current_period_end: src.current_period_end ?? null,
      cancel_at_period_end: !!src.cancel_at_period_end,
      activated_at: started_at,
      ended_at,
    },
    plan_period: {
      tenant_id,
      // subscription_id resolved by load.js from subscription.id
      source_plan_id: String(src.plan_id),
      started_at,
      ended_at, // null = open period (non-terminal subs)
    },
  };
}

// Momentum source status → Courtside subscription status.
//
// TODO(SOURCE_SCHEMA.md): this mapping is INTENTIONALLY incomplete
// until the source status enum is inventoried (run the DISTINCT
// status query in SOURCE_SCHEMA.md). Unknown values THROW rather than
// guess — silently wrong-importing a subscription status is the
// failure mode this whole step exists to prevent. In particular,
// 'trialing' is NOT mapped: whether a Momentum trial imports as
// 'active' (gets credits now) or stays out of scope is a product
// decision to make from the inventory, not a default.
function mapMomentumSubStatus(s, sourceSubId) {
  switch (s) {
    case 'active': return 'active';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'past_due': return 'past_due';
    case 'incomplete': return 'incomplete';
    default:
      throw new Error(`unknown Momentum sub status for source sub ${sourceSubId}: ${JSON.stringify(s)}`);
  }
}

// Source: { member_id (Momentum's), credits }
// Target credit_balance: { source_member_id, tenant_id,
//                          current_credits, last_reset_at }
// Target ledger row: ONE row with reason='migration'. amount may be 0
//                    — load.js owns the single "skip zero-amount
//                    ledger rows" guard (the ledger CHECK rejects
//                    amount = 0, mirroring apply_credit_change).
export function transformCreditBalance(src, tenant_id) {
  if (src.member_id == null) {
    throw new Error('source credit balance row missing member_id');
  }
  const credits = Number(src.credits);
  if (!Number.isInteger(credits) || credits < 0) {
    // Fractional, NaN, negative — credits are an integer column and
    // silently rounding member balances is not acceptable.
    throw new Error(`bad credit balance for ${src.member_id}: ${JSON.stringify(src.credits)}`);
  }
  return {
    balance: {
      tenant_id,
      source_member_id: String(src.member_id),
      current_credits: credits,
      last_reset_at: null,
    },
    ledger: {
      tenant_id,
      source_member_id: String(src.member_id),
      amount: credits,
      balance_after: credits,
      reason: 'migration',
      note: 'migrated from Momentum at cutover',
    },
  };
}

// Source booking row → Courtside bookings row (+ source_* refs).
//
// Status: cancelled_at → 'cancelled'; no_show_marked_at → 'no_show';
// past → 'completed'; future → 'confirmed'. pending_payment is never
// emitted (in-flight checkouts don't survive cutover).
//
// payment_status must satisfy the bookings CASE CHECK (007):
//   not_required   due = 0,  paid = 0,           refunded = 0
//   pending        due > 0,  paid = 0,           refunded = 0
//   paid           due > 0,  paid >= due,        refunded = 0
//   partial_refund due > 0,  paid > 0,           0 < refunded < paid
//   refunded       due > 0,  paid = refunded > 0
// plus: member bookings are always not_required with due = 0, and a
// customer 'not_required' booking must have due = 0.
//
// Rows with money shapes that have no legal state (a deposit:
// 0 < paid < due; refunds exceeding payments; money on a zero-due or
// member booking) THROW for manual review — we don't rewrite money.
export function transformBooking(src, tenant_id, now = Date.now()) {
  if (src.id == null) {
    throw new Error(`source booking missing id (start ${src.start_time})`);
  }
  const label = `booking ${src.id}`;

  if (src.offering_id == null || src.resource_id == null) {
    throw new Error(`${label}: missing offering_id/resource_id`);
  }

  const start = parseTs(src.start_time, `${label} start_time`);
  const end = parseTs(src.end_time, `${label} end_time`);
  if (end <= start) {
    throw new Error(`${label}: end_time <= start_time`);
  }
  const isPast = start < now;

  const isMember = src.member_id != null;

  let customer_first_name = null;
  let customer_last_name = null;
  let customer_email = null;
  let customer_phone = null;
  if (!isMember) {
    customer_first_name = String(src.customer_first_name ?? '').trim();
    customer_last_name = String(src.customer_last_name ?? '').trim();
    customer_email = String(src.customer_email ?? '').trim().toLowerCase();
    if (!customer_first_name || !customer_last_name || !customer_email) {
      // The bookings member-XOR-customer CHECK requires all three.
      // Don't fabricate contact info; route to review.
      throw new Error(`${label}: walk-in missing customer name/email`);
    }
    if (/\s/.test(customer_email)) {
      throw new Error(`${label}: bad customer email ${JSON.stringify(src.customer_email)}`);
    }
    const phone = String(src.customer_phone ?? '').trim();
    customer_phone = phone || null;
  }

  let status;
  if (src.cancelled_at) status = 'cancelled';
  else if (src.no_show_marked_at) status = 'no_show';
  else if (isPast) status = 'completed';
  else status = 'confirmed';

  // Money
  const due = moneyInt(src.amount_cents, `${label} amount_cents`);
  const paid = moneyInt(src.amount_paid_cents, `${label} amount_paid_cents`);
  const refunded = moneyInt(src.amount_refunded_cents, `${label} amount_refunded_cents`);
  const credits = moneyInt(src.credits_charged, `${label} credits_charged`);

  let amount_due_cents;
  let payment_status;
  if (isMember) {
    if (paid !== 0 || refunded !== 0) {
      throw new Error(`${label}: member booking carries money amounts (paid=${paid}, refunded=${refunded})`);
    }
    amount_due_cents = 0;
    payment_status = 'not_required';
  } else {
    amount_due_cents = due;
    if (refunded > paid) {
      throw new Error(`${label}: refunded (${refunded}) exceeds paid (${paid})`);
    }
    if (due === 0) {
      if (paid !== 0) {
        throw new Error(`${label}: paid ${paid} on a zero-due booking; resolve manually`);
      }
      payment_status = 'not_required';
    } else if (refunded > 0) {
      payment_status = refunded === paid ? 'refunded' : 'partial_refund';
    } else if (paid === 0) {
      // Owed but unpaid (cash-on-arrival history Setmore didn't track,
      // or genuinely outstanding). 'pending' is the legal shape.
      payment_status = 'pending';
    } else if (paid >= due) {
      payment_status = 'paid';
    } else {
      throw new Error(`${label}: partial payment (paid=${paid} < due=${due}) has no legal payment_status; resolve manually`);
    }
  }

  return {
    id: migrationId(tenant_id, 'bookings', src.id),
    source_id: String(src.id),
    tenant_id,
    source_offering_id: String(src.offering_id),
    source_resource_id: String(src.resource_id),
    source_member_id: isMember ? String(src.member_id) : null,
    customer_first_name,
    customer_last_name,
    customer_email,
    customer_phone,
    start_time: src.start_time,
    end_time: src.end_time,
    status,
    amount_due_cents,
    credit_cost_charged: isMember ? credits : 0,
    amount_paid_cents: paid,
    amount_refunded_cents: refunded,
    payment_status,
    cancelled_at: src.cancelled_at ?? null,
    no_show_marked_at: src.no_show_marked_at ?? null,
    created_at: src.created_at ?? null,
  };
}

// ============================================================
// shared validation helpers
// ============================================================

// Parse a timestamp-ish value to epoch ms; throw on missing/garbage.
// NaN must never escape: `NaN < now` is false, which silently turns a
// dateless booking into a future 'confirmed' one.
function parseTs(value, what, { optional = false } = {}) {
  if (value == null) {
    if (optional) return null;
    throw new Error(`${what}: missing`);
  }
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${what}: unparseable timestamp ${JSON.stringify(value)}`);
  }
  return ms;
}

// Money/credits: integer >= 0; null/undefined → 0.
function moneyInt(value, what) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${what}: expected non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// ============================================================
// driver
// ============================================================

async function main() {
  banner('02 transform');
  await mkdir(OUT_DIR, { recursive: true });

  // TODO: once 01_snapshot_source produces real files, read each one,
  // run the appropriate transformer over its rows, and write the
  // result to out/transformed/*.json. Per-row errors go to
  // out/transformed/rejects.json — collect and continue, don't die on
  // the first dirty Setmore row. Skeleton:
  //
  //   const tenant_id = process.env.MIGRATION_TENANT_ID;
  //   const rejects = [];
  //   const sourceUsers = await readJson('users.json');
  //   const usersAndMembers = [];
  //   for (const u of sourceUsers) {
  //     try { usersAndMembers.push(transformMemberAndUser(u, tenant_id)); }
  //     catch (err) { rejects.push({ table: 'users', source_id: u.id, error: err.message }); }
  //   }
  //   await writeJson('users_and_members.json', usersAndMembers);
  //   ... same shape for subscriptions / credit balances / bookings ...
  //   await writeJson('rejects.json', rejects);
  //
  // No idMaps and no ordering constraints between transformers — every
  // cross-reference travels as a source_*_id and 03_load resolves it.

  info('skeleton: fill in once source files exist in out/source/');
}

// eslint-disable-next-line no-unused-vars
async function readJson(filename) {
  const path = join(SRC_DIR, filename);
  return JSON.parse(await readFile(path, 'utf-8'));
}

// eslint-disable-next-line no-unused-vars
async function writeJson(filename, rows) {
  const path = join(OUT_DIR, filename);
  await writeFile(path, JSON.stringify(rows, null, 2));
  info('wrote', { path, count: Array.isArray(rows) ? rows.length : 1 });
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
