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
// Type contracts below are docs only — JS doesn't enforce them. When
// this graduates to TypeScript (or starts using zod for validation
// at the I/O boundary) the contracts move into actual schemas.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info } from './shared/log.js';

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
// Target member: { tenant_id, user_id, email, first_name, last_name,
//                  phone, created_at }
export function transformMemberAndUser(src, tenant_id) {
  const email = String(src.email).trim().toLowerCase();
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
      tenant_id,
      // user_id is filled in after insert returns the new user id;
      // load.js handles linking
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
//           cancel_at_period_end, plan_id (Momentum's) }
// Target subscription: Courtside subscriptions row shape (see schema).
// Target plan_period: subscription_plan_periods row.
export function transformSubscription(src, tenant_id, idMaps) {
  const courtside_member_id = idMaps.member.get(src.member_id);
  const courtside_plan_id = idMaps.plan.get(src.plan_id);
  if (!courtside_member_id) {
    throw new Error(`source sub ${src.id}: no Courtside member for source member ${src.member_id}`);
  }
  if (!courtside_plan_id) {
    throw new Error(`source sub ${src.id}: no Courtside plan for source plan ${src.plan_id}`);
  }
  return {
    subscription: {
      tenant_id,
      member_id: courtside_member_id,
      status: mapMomentumSubStatus(src.status),
      stripe_subscription_id: src.stripe_subscription_id,
      stripe_customer_id: src.stripe_customer_id,
      current_period_start: src.current_period_start,
      current_period_end: src.current_period_end,
      cancel_at_period_end: !!src.cancel_at_period_end,
      activated_at: src.activated_at ?? src.created_at,
    },
    plan_period: {
      tenant_id,
      // subscription_id filled by load.js after insert
      plan_id: courtside_plan_id,
      started_at: src.activated_at ?? src.created_at,
      ended_at: null, // open period
    },
  };
}

// TODO once Momentum's status enum is known. Fill in below.
function mapMomentumSubStatus(s) {
  // Placeholder — replace with the real Momentum-side values.
  switch (s) {
    case 'active': return 'active';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'past_due': return 'past_due';
    case 'trialing': return 'active';
    case 'incomplete': return 'incomplete';
    default:
      throw new Error(`unknown Momentum sub status: ${s}`);
  }
}

// Source: { member_id (Momentum's), credits }
// Target credit_balance: { tenant_id, member_id, current_credits, last_reset_at }
// Target ledger row: ONE row with reason='migration' and amount =
//                    credits, balance_after = credits.
export function transformCreditBalance(src, tenant_id, idMaps) {
  const courtside_member_id = idMaps.member.get(src.member_id);
  if (!courtside_member_id) {
    throw new Error(`source credit balance for member ${src.member_id}: no Courtside member`);
  }
  const credits = Number(src.credits);
  if (!Number.isFinite(credits) || credits < 0) {
    throw new Error(`bad credit balance for ${src.member_id}: ${src.credits}`);
  }
  return {
    balance: {
      tenant_id,
      member_id: courtside_member_id,
      current_credits: credits,
      last_reset_at: null,
    },
    ledger: {
      tenant_id,
      member_id: courtside_member_id,
      amount: credits === 0 ? null : credits, // skip zero-balance ledger rows
      balance_after: credits,
      reason: 'migration',
      note: 'migrated from Momentum at cutover',
    },
  };
}

// Source booking row → Courtside bookings row. Past bookings come
// in with status='completed' (or 'cancelled'/'no_show' as flagged
// at the source); future bookings as 'confirmed'. The schema's
// payment_status invariants apply, so we set amount fields based
// on whether this was a member or walk-in booking.
export function transformBooking(src, tenant_id, idMaps, now = Date.now()) {
  const start = new Date(src.start_time).getTime();
  const isPast = start < now;
  const courtside_offering_id = idMaps.offering.get(src.offering_id);
  const courtside_resource_id = idMaps.resource.get(src.resource_id);
  if (!courtside_offering_id || !courtside_resource_id) {
    throw new Error(`booking ${src.id}: missing offering/resource map`);
  }
  const isMember = !!src.member_id;
  const courtside_member_id = isMember
    ? idMaps.member.get(src.member_id)
    : null;
  if (isMember && !courtside_member_id) {
    throw new Error(`booking ${src.id}: no Courtside member for source ${src.member_id}`);
  }

  let status;
  if (src.cancelled_at) status = 'cancelled';
  else if (src.no_show_marked_at) status = 'no_show';
  else if (isPast) status = 'completed';
  else status = 'confirmed';

  return {
    tenant_id,
    offering_id: courtside_offering_id,
    resource_id: courtside_resource_id,
    member_id: courtside_member_id,
    customer_first_name: isMember ? null : src.customer_first_name,
    customer_last_name: isMember ? null : src.customer_last_name,
    customer_email: isMember ? null : (src.customer_email ?? '').toLowerCase(),
    customer_phone: isMember ? null : src.customer_phone,
    start_time: src.start_time,
    end_time: src.end_time,
    status,
    amount_due_cents: isMember ? 0 : (src.amount_cents ?? 0),
    credit_cost_charged: isMember ? (src.credits_charged ?? 0) : 0,
    amount_paid_cents: src.amount_paid_cents ?? 0,
    amount_refunded_cents: src.amount_refunded_cents ?? 0,
    payment_status: isMember
      ? 'not_required'
      : ((src.amount_paid_cents ?? 0) > 0 ? 'paid' : 'not_required'),
    cancelled_at: src.cancelled_at,
    no_show_marked_at: src.no_show_marked_at,
    created_at: src.created_at,
  };
}

// ============================================================
// driver
// ============================================================

async function main() {
  banner('02 transform');
  await mkdir(OUT_DIR, { recursive: true });

  // TODO: once 01_snapshot_source produces real files, read each one,
  // run the appropriate transformer over its rows, and write the
  // result to out/transformed/*.json. Skeleton for now:
  //
  //   const tenant_id = process.env.MIGRATION_TENANT_ID;
  //   const idMaps = { member: new Map(), plan: new Map(), ... };
  //   const sourceUsers = await readJson('users.json');
  //   const usersAndMembers = sourceUsers.map(u =>
  //     transformMemberAndUser(u, tenant_id)
  //   );
  //   await writeJson('users_and_members.json', usersAndMembers);
  //   ...
  //
  // The order matters because later transformers need idMaps populated
  // by earlier ones (sub needs member_id mapping; bookings need member
  // + offering + resource maps). For now the IDs come from snapshot
  // metadata (Momentum's source ids); the load step assigns Courtside
  // UUIDs and writes back into the maps.

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
