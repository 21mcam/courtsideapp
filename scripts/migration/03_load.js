// 03_load.js — load transformed JSON into Courtside DB.
//
// Runs against the privileged pool (MIGRATION_DATABASE_URL) so we can
// INSERT across multiple tenants' tables and write to credit_ledger_
// entries directly. The runtime app_runtime role doesn't have those
// privileges — that's intentional, and bypassing here is the
// explicit escape hatch documented in CLAUDE.md.
//
// ID resolution: transformed rows carry Momentum ids as source_*_id
// fields plus a deterministic UUID (shared/ids.js) for rows the
// migration creates. Each phase builds a source→Courtside map as it
// inserts (RETURNING id) and later phases resolve through those maps.
// Where a row may already exist — wizard-created catalog, a member
// who signed up by hand — the loader ADOPTS the existing row by
// natural key (email / name) instead of inserting a duplicate.
//
// Idempotency: every phase upserts on a key that actually exists —
// (tenant_id, email) for users/members, the deterministic id for
// subscriptions and bookings, natural keys for catalog. Reruns are
// safe BEFORE go-live. After go-live, the credit phase refuses to
// overwrite any member who already has operational (non-migration)
// ledger activity.
//
// Per-row failure policy:
//   * users/members, plans, catalog, subscriptions, credits — small,
//     must-be-complete datasets: collect every bad row, then FAIL the
//     phase listing all of them (transaction rolls back).
//   * bookings, operating hours — bulky, dirty datasets: skip bad
//     rows (SAVEPOINT per row), continue, and write a review report
//     to out/load_report/. The cutover gate is 05_verify plus an
//     EMPTY skip report, not "the script didn't crash".
//
// What we DO NOT do:
//   * Run apply_credit_change for migration ledger rows. The
//     function checks the GUC and would force tenant-by-tenant
//     transactions; for a bulk one-shot import we INSERT directly
//     using the privileged role. The 'migration' reason value (added
//     in migration 017) makes these rows distinguishable from
//     operational ones.
//   * Insert pending_payment bookings. Those represent in-flight
//     Stripe sessions that don't survive cutover (the user will
//     either complete them on the old system before freeze or lose
//     the in-flight state). Confirm with Momentum admin.
//
// Phases run in dependency order. Each phase commits its own
// transaction so a partial load can be picked up by rerunning later
// phases without redoing everything.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info, warn } from './shared/log.js';
import { inTransaction, pool } from './shared/db.js';
import { migrationId } from './shared/ids.js';

const TRANSFORMED_DIR = new URL('./out/transformed/', import.meta.url).pathname;
const REPORT_DIR = new URL('./out/load_report/', import.meta.url).pathname;

async function main() {
  banner('03 load');

  // Cross-phase source-id → Courtside-UUID maps, built as rows land.
  const ctx = {
    memberMap: new Map(),
    planMap: new Map(),
    resourceMap: new Map(),
    offeringMap: new Map(),
  };

  try {
    await loadUsersAndMembers(ctx);
    await loadPlans(ctx);
    await loadResourcesAndOfferings(ctx);
    await loadOperatingHours(ctx);
    await loadBookingPolicies(ctx);
    await loadStripeConnection(ctx);
    await loadSubscriptions(ctx);
    await loadCreditBalancesAndLedger(ctx);
    await loadBookings(ctx);
  } finally {
    await pool.end();
  }
}

// ============================================================
// phase: users + members
// ============================================================
//
// Users upsert on (tenant_id, email) — the auth identity's natural
// key. Members upsert on (tenant_id, email) too, supplying the
// deterministic id for fresh inserts; if the member already exists
// (manual pre-creation), its existing id is adopted. Either way
// RETURNING id feeds ctx.memberMap for every later phase.
async function loadUsersAndMembers(ctx) {
  banner('users + members');

  const rows = await readTransformed('users_and_members.json');
  if (!rows) {
    info('skip: out/transformed/users_and_members.json not found');
    return;
  }

  await inTransaction(async (client) => {
    for (const row of rows) {
      const u = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, created_at)
           VALUES ($1, $2, '', $3, $4, COALESCE($5, now()))
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name
         RETURNING id`,
        [
          row.user.tenant_id,
          row.user.email,
          row.user.first_name,
          row.user.last_name,
          row.user.created_at,
        ],
      );
      const user_id = u.rows[0].id;

      const m = await client.query(
        `INSERT INTO members (id, tenant_id, user_id, email, first_name, last_name, phone, created_at)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, COALESCE($8, now()))
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               phone = EXCLUDED.phone
         RETURNING id`,
        [
          row.member.id ?? null,
          row.member.tenant_id,
          user_id,
          row.member.email,
          row.member.first_name,
          row.member.last_name,
          row.member.phone,
          row.member.created_at,
        ],
      );
      if (row.member.source_id != null) {
        ctx.memberMap.set(String(row.member.source_id), m.rows[0].id);
      }
    }
    info('loaded users + members', { count: rows.length, mapped: ctx.memberMap.size });
  });
}

// ============================================================
// phase: plans
// ============================================================
//
// Plans have no total natural key — the unique index only covers
// active plans. Resolution order per row:
//   1. deterministic id (a rerun finds the row it created last time)
//   2. active-name match (adopt a wizard-created plan)
//   3. insert fresh with the deterministic id
// Set stripe_price_id from Momentum's existing connected account
// price IDs — we DO NOT mint new Prices because Stripe already has
// them.
async function loadPlans(ctx) {
  banner('plans');

  const rows = await readTransformed('plans.json');
  if (!rows) {
    info('skip: out/transformed/plans.json not found');
    return;
  }

  await inTransaction(async (client) => {
    for (const p of rows) {
      const detId = p.source_id != null
        ? migrationId(p.tenant_id, 'plans', p.source_id)
        : null;

      let id = null;
      if (detId) {
        const r = await client.query(
          `SELECT id FROM plans WHERE tenant_id = $1 AND id = $2`,
          [p.tenant_id, detId],
        );
        id = r.rows[0]?.id ?? null;
      }
      if (!id && (p.active ?? true)) {
        const r = await client.query(
          `SELECT id FROM plans WHERE tenant_id = $1 AND lower(name) = lower($2) AND active`,
          [p.tenant_id, p.name],
        );
        id = r.rows[0]?.id ?? null;
        if (id) info('adopted existing plan', { name: p.name, id });
      }

      if (id) {
        await client.query(
          `UPDATE plans SET
             name = $3, description = $4, monthly_price_cents = $5,
             credits_per_week = $6, allowed_categories = $7::category_key[],
             stripe_price_id = $8, active = $9, display_order = $10
           WHERE tenant_id = $1 AND id = $2`,
          [
            p.tenant_id, id, p.name, p.description, p.monthly_price_cents,
            p.credits_per_week, p.allowed_categories,
            p.stripe_price_id, p.active ?? true, p.display_order ?? 0,
          ],
        );
      } else {
        const r = await client.query(
          `INSERT INTO plans (
             id, tenant_id, name, description, monthly_price_cents,
             credits_per_week, allowed_categories, stripe_price_id,
             active, display_order
           ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::category_key[], $7, $8, $9, $10)
           RETURNING id`,
          [
            detId, p.tenant_id, p.name, p.description, p.monthly_price_cents,
            p.credits_per_week, p.allowed_categories,
            p.stripe_price_id, p.active ?? true, p.display_order ?? 0,
          ],
        );
        id = r.rows[0].id;
      }

      if (p.source_id != null) ctx.planMap.set(String(p.source_id), id);
    }
    info('loaded plans', { count: rows.length, mapped: ctx.planMap.size });
  });
}

// ============================================================
// phase: resources + offerings + offering_resources
// ============================================================
//
// Resources have UNIQUE (tenant_id, name) — a plain upsert adopts
// wizard-created rows. Offerings have NO name unique (the old
// ON CONFLICT (tenant_id, name) was a guaranteed 42P10), so they get
// the same select-then-adopt treatment as plans.
async function loadResourcesAndOfferings(ctx) {
  banner('resources + offerings');

  const data = await readTransformed('resources_and_offerings.json');
  if (!data) {
    info('skip: out/transformed/resources_and_offerings.json not found');
    return;
  }

  await inTransaction(async (client) => {
    // Resources
    for (const r of data.resources ?? []) {
      const detId = r.source_id != null
        ? migrationId(r.tenant_id, 'resources', r.source_id)
        : null;
      const res = await client.query(
        `INSERT INTO resources (id, tenant_id, name, display_order, active)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET display_order = EXCLUDED.display_order,
               active = EXCLUDED.active
         RETURNING id`,
        [detId, r.tenant_id, r.name, r.display_order ?? 0, r.active ?? true],
      );
      if (r.source_id != null) ctx.resourceMap.set(String(r.source_id), res.rows[0].id);
    }

    // Offerings — no (tenant_id, name) unique exists; adopt by name.
    for (const o of data.offerings ?? []) {
      const detId = o.source_id != null
        ? migrationId(o.tenant_id, 'offerings', o.source_id)
        : null;

      let id = null;
      if (detId) {
        const r = await client.query(
          `SELECT id FROM offerings WHERE tenant_id = $1 AND id = $2`,
          [o.tenant_id, detId],
        );
        id = r.rows[0]?.id ?? null;
      }
      if (!id) {
        const r = await client.query(
          `SELECT id FROM offerings WHERE tenant_id = $1 AND lower(name) = lower($2)`,
          [o.tenant_id, o.name],
        );
        if (r.rows.length > 1) {
          throw new Error(
            `offering name ${JSON.stringify(o.name)} matches ${r.rows.length} existing rows; resolve manually before loading`,
          );
        }
        id = r.rows[0]?.id ?? null;
        if (id) info('adopted existing offering', { name: o.name, id });
      }

      if (id) {
        await client.query(
          `UPDATE offerings SET
             name = $3, category = $4, duration_minutes = $5, credit_cost = $6,
             dollar_price = $7, capacity = $8, allow_member_booking = $9,
             allow_public_booking = $10, active = $11
           WHERE tenant_id = $1 AND id = $2`,
          [
            o.tenant_id, id, o.name, o.category, o.duration_minutes, o.credit_cost,
            o.dollar_price, o.capacity ?? 1,
            o.allow_member_booking ?? true,
            o.allow_public_booking ?? true,
            o.active ?? true,
          ],
        );
      } else {
        const r = await client.query(
          `INSERT INTO offerings (
             id, tenant_id, name, category, duration_minutes, credit_cost,
             dollar_price, capacity, allow_member_booking, allow_public_booking, active
           ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            detId, o.tenant_id, o.name, o.category, o.duration_minutes, o.credit_cost,
            o.dollar_price, o.capacity ?? 1,
            o.allow_member_booking ?? true,
            o.allow_public_booking ?? true,
            o.active ?? true,
          ],
        );
        id = r.rows[0].id;
      }

      if (o.source_id != null) ctx.offeringMap.set(String(o.source_id), id);
    }

    // offering_resources links — resolved through the maps; the PK
    // (tenant_id, offering_id, resource_id) is the upsert arbiter.
    const badLinks = [];
    for (const link of data.links ?? []) {
      const offering_id = ctx.offeringMap.get(String(link.source_offering_id));
      const resource_id = ctx.resourceMap.get(String(link.source_resource_id));
      if (!offering_id || !resource_id) {
        badLinks.push(link);
        continue;
      }
      await client.query(
        `INSERT INTO offering_resources (tenant_id, offering_id, resource_id, active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, offering_id, resource_id) DO UPDATE
           SET active = EXCLUDED.active`,
        [link.tenant_id, offering_id, resource_id, link.active ?? true],
      );
    }
    if (badLinks.length > 0) {
      throw new Error(
        `offering_resources: ${badLinks.length} link(s) reference unmapped offerings/resources: ` +
        JSON.stringify(badLinks.slice(0, 10)),
      );
    }

    info('loaded catalog', {
      resources: data.resources?.length ?? 0,
      offerings: data.offerings?.length ?? 0,
      links: data.links?.length ?? 0,
    });
  });
}

// ============================================================
// phase: operating hours
// ============================================================
//
// operating_hours allows multiple rows per (resource, day) for split
// shifts — there is no unique key, and the table's own GiST exclusion
// would be silently swallowed by a bare ON CONFLICT DO NOTHING. So:
// exact-duplicate rows are skipped via WHERE NOT EXISTS (rerun-safe),
// and a row that overlaps an existing window (e.g. wizard-configured
// hours) is skipped into the report for the operator to reconcile.
async function loadOperatingHours(ctx) {
  banner('operating hours');
  const rows = await readTransformed('operating_hours.json');
  if (!rows) return info('skip: operating_hours.json not found');

  const skipped = [];
  await inTransaction(async (client) => {
    for (const r of rows) {
      const resource_id = r.source_resource_id != null
        ? ctx.resourceMap.get(String(r.source_resource_id))
        : r.resource_id;
      if (!resource_id) {
        skipped.push({ row: r, reason: 'unmapped resource' });
        continue;
      }
      try {
        await client.query('SAVEPOINT one_window');
        await client.query(
          `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (
             SELECT 1 FROM operating_hours
              WHERE tenant_id = $1 AND resource_id = $2 AND day_of_week = $3
                AND open_time = $4 AND close_time = $5
           )`,
          [r.tenant_id, resource_id, r.day_of_week, r.open_time, r.close_time],
        );
        await client.query('RELEASE SAVEPOINT one_window');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT one_window');
        skipped.push({ row: r, code: err.code ?? null, reason: err.message });
      }
    }
    info('loaded operating_hours', { count: rows.length, skipped: skipped.length });
  });
  await writeReport('operating_hours_skipped.json', skipped);
}

// ============================================================
// phase: booking policies (singleton per tenant; PK is tenant_id)
// ============================================================
async function loadBookingPolicies() {
  banner('booking policies');
  const rows = await readTransformed('booking_policies.json');
  if (!rows) return info('skip: booking_policies.json not found');
  await inTransaction(async (client) => {
    for (const p of rows) {
      await client.query(
        `INSERT INTO booking_policies (
           tenant_id, free_cancel_hours_before,
           partial_refund_hours_before, partial_refund_percent,
           no_show_action, no_show_fee_cents,
           min_advance_booking_minutes, max_advance_booking_days,
           allow_member_self_cancel, allow_customer_self_cancel
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           free_cancel_hours_before = EXCLUDED.free_cancel_hours_before,
           partial_refund_hours_before = EXCLUDED.partial_refund_hours_before,
           partial_refund_percent = EXCLUDED.partial_refund_percent,
           no_show_action = EXCLUDED.no_show_action,
           no_show_fee_cents = EXCLUDED.no_show_fee_cents,
           min_advance_booking_minutes = EXCLUDED.min_advance_booking_minutes,
           max_advance_booking_days = EXCLUDED.max_advance_booking_days,
           allow_member_self_cancel = EXCLUDED.allow_member_self_cancel,
           allow_customer_self_cancel = EXCLUDED.allow_customer_self_cancel`,
        [
          p.tenant_id, p.free_cancel_hours_before,
          p.partial_refund_hours_before, p.partial_refund_percent,
          p.no_show_action, p.no_show_fee_cents,
          p.min_advance_booking_minutes, p.max_advance_booking_days,
          p.allow_member_self_cancel ?? true,
          p.allow_customer_self_cancel ?? true,
        ],
      );
    }
    info('loaded booking_policies', { count: rows.length });
  });
}

// ============================================================
// phase: stripe connection
// ============================================================
//
// Booleans default to FALSE when the transformed file omits them —
// fabricating charges_enabled=true would make 05_verify's
// charges-enabled gate pass for an account that can't take payments.
// The real values should come from the Stripe API during inventory.
async function loadStripeConnection() {
  banner('stripe connection');
  const rows = await readTransformed('stripe_connections.json');
  if (!rows) return info('skip: stripe_connections.json not found');
  await inTransaction(async (client) => {
    for (const c of rows) {
      if (!c.stripe_account_id) {
        throw new Error('stripe_connections row missing stripe_account_id');
      }
      await client.query(
        `INSERT INTO stripe_connections (
           tenant_id, stripe_account_id,
           details_submitted, charges_enabled, payouts_enabled,
           platform_fee_basis_points, connected_at, fully_onboarded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8)
         ON CONFLICT (tenant_id) DO UPDATE SET
           stripe_account_id = EXCLUDED.stripe_account_id,
           details_submitted = EXCLUDED.details_submitted,
           charges_enabled = EXCLUDED.charges_enabled,
           payouts_enabled = EXCLUDED.payouts_enabled`,
        [
          c.tenant_id, c.stripe_account_id,
          c.details_submitted ?? false, c.charges_enabled ?? false,
          c.payouts_enabled ?? false,
          c.platform_fee_basis_points ?? 0,
          c.connected_at, c.fully_onboarded_at,
        ],
      );
    }
    info('loaded stripe_connections', { count: rows.length });
  });
}

// ============================================================
// phase: subscriptions + plan_periods
// ============================================================
//
// Upsert on the deterministic id — works for NULL stripe ids too
// (comped/manual members), which the old stripe_subscription_id
// arbiter couldn't dedupe on rerun. Unresolvable member/plan refs are
// collected and fail the phase as one report (these datasets must be
// complete; a silently dropped subscription is a billing bug).
async function loadSubscriptions(ctx) {
  banner('subscriptions');
  const rows = await readTransformed('subscriptions.json');
  if (!rows) return info('skip: subscriptions.json not found');

  await inTransaction(async (client) => {
    const unresolved = [];
    for (const r of rows) {
      const member_id = ctx.memberMap.get(String(r.subscription.source_member_id));
      const plan_id = ctx.planMap.get(String(r.plan_period.source_plan_id));
      if (!member_id || !plan_id) {
        unresolved.push({
          subscription_id: r.subscription.id,
          source_member_id: r.subscription.source_member_id,
          source_plan_id: r.plan_period.source_plan_id,
          missing: !member_id ? 'member' : 'plan',
        });
        continue;
      }

      await client.query(
        `INSERT INTO subscriptions (
           id, tenant_id, member_id, status,
           stripe_subscription_id, stripe_customer_id,
           current_period_start, current_period_end,
           cancel_at_period_end, activated_at, ended_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           activated_at = EXCLUDED.activated_at,
           ended_at = EXCLUDED.ended_at`,
        [
          r.subscription.id, r.subscription.tenant_id, member_id, r.subscription.status,
          r.subscription.stripe_subscription_id, r.subscription.stripe_customer_id,
          r.subscription.current_period_start, r.subscription.current_period_end,
          r.subscription.cancel_at_period_end, r.subscription.activated_at,
          r.subscription.ended_at,
        ],
      );
      const subscription_id = r.subscription.id;

      if (r.plan_period.ended_at == null) {
        // Open period (non-terminal sub). If one exists, reconcile its
        // plan — a bare ON CONFLICT DO NOTHING would let the period
        // exclusion silently keep a wrong plan from a prior run, and
        // the renewal webhook grants credits off this exact join.
        const open = await client.query(
          `SELECT id, plan_id FROM subscription_plan_periods
            WHERE tenant_id = $1 AND subscription_id = $2 AND ended_at IS NULL`,
          [r.plan_period.tenant_id, subscription_id],
        );
        if (open.rows.length === 0) {
          await client.query(
            `INSERT INTO subscription_plan_periods (
               tenant_id, subscription_id, plan_id, started_at, ended_at
             ) VALUES ($1, $2, $3, COALESCE($4, now()), NULL)`,
            [r.plan_period.tenant_id, subscription_id, plan_id, r.plan_period.started_at],
          );
        } else if (open.rows[0].plan_id !== plan_id) {
          warn('correcting open plan_period plan on rerun', {
            subscription_id,
            from: open.rows[0].plan_id,
            to: plan_id,
          });
          await client.query(
            `UPDATE subscription_plan_periods SET plan_id = $3
              WHERE tenant_id = $1 AND id = $2`,
            [r.plan_period.tenant_id, open.rows[0].id, plan_id],
          );
        }
      } else {
        // Closed period (cancelled sub). Insert unless something
        // already covers that window — explicit guard instead of
        // letting ON CONFLICT swallow the range exclusion.
        await client.query(
          `INSERT INTO subscription_plan_periods (
             tenant_id, subscription_id, plan_id, started_at, ended_at
           )
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (
             SELECT 1 FROM subscription_plan_periods
              WHERE tenant_id = $1 AND subscription_id = $2
                AND period_range && tstzrange($4, $5, '[)')
           )`,
          [
            r.plan_period.tenant_id, subscription_id, plan_id,
            r.plan_period.started_at, r.plan_period.ended_at,
          ],
        );
      }
    }

    if (unresolved.length > 0) {
      throw new Error(
        `subscriptions: ${unresolved.length} row(s) reference unloaded members/plans — ` +
        `did users_and_members.json / plans.json load and carry source_id? ` +
        JSON.stringify(unresolved.slice(0, 10)),
      );
    }
    info('loaded subscriptions + plan_periods', { count: rows.length });
  });
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
// Post-go-live guard: a member with ANY non-migration ledger activity
// is live — overwriting their balance with the stale snapshot value
// would desync balance from ledger. Those members are skipped loudly.
async function loadCreditBalancesAndLedger(ctx) {
  banner('credit balances + ledger');
  const rows = await readTransformed('credit_balances.json');
  if (!rows) return info('skip: credit_balances.json not found');

  const skippedLive = [];
  await inTransaction(async (client) => {
    const unresolved = [];
    for (const r of rows) {
      const member_id = ctx.memberMap.get(String(r.balance.source_member_id));
      if (!member_id) {
        unresolved.push(r.balance.source_member_id);
        continue;
      }

      const live = await client.query(
        `SELECT 1 FROM credit_ledger_entries
          WHERE tenant_id = $1 AND member_id = $2 AND reason <> 'migration'
          LIMIT 1`,
        [r.balance.tenant_id, member_id],
      );
      if (live.rows.length > 0) {
        skippedLive.push({ member_id, source_member_id: r.balance.source_member_id });
        continue;
      }

      await client.query(
        `INSERT INTO credit_balances (tenant_id, member_id, current_credits, last_reset_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, member_id) DO UPDATE SET
           current_credits = EXCLUDED.current_credits,
           last_reset_at = EXCLUDED.last_reset_at`,
        [r.balance.tenant_id, member_id, r.balance.current_credits, r.balance.last_reset_at],
      );

      // Single zero-guard: the ledger CHECK rejects amount = 0 (and
      // apply_credit_change does too), so zero-credit members get a
      // balance row and no ledger row. 05_verify only requires a
      // ledger row for non-zero balances.
      if (r.ledger.amount !== 0) {
        const existing = await client.query(
          `SELECT 1 FROM credit_ledger_entries
            WHERE tenant_id = $1 AND member_id = $2 AND reason = 'migration'
            LIMIT 1`,
          [r.ledger.tenant_id, member_id],
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO credit_ledger_entries (
               tenant_id, member_id, amount, balance_after, reason, note
             ) VALUES ($1, $2, $3, $4, 'migration', $5)`,
            [
              r.ledger.tenant_id, member_id,
              r.ledger.amount, r.ledger.balance_after, r.ledger.note,
            ],
          );
        }
      }
    }

    if (unresolved.length > 0) {
      throw new Error(
        `credit_balances: ${unresolved.length} row(s) reference unloaded members: ` +
        JSON.stringify(unresolved.slice(0, 10)),
      );
    }
    info('loaded credit_balances + ledger', {
      count: rows.length,
      skipped_live_members: skippedLive.length,
    });
  });
  if (skippedLive.length > 0) {
    warn('credit balances NOT overwritten for members with operational ledger activity', {
      count: skippedLive.length,
    });
  }
  await writeReport('credit_balances_skipped_live.json', skippedLive);
}

// ============================================================
// phase: bookings
// ============================================================
//
// Inserted in chronological order so each row's GiST exclusion check
// runs against an already-loaded prefix. Upsert arbiter is the
// deterministic id, so a rerun skips already-loaded rows (including
// cancelled ones, which the exclusion ignores) and a genuine overlap
// still RAISES 23P01 instead of being swallowed by a bare ON CONFLICT.
//
// ANY per-row error — exclusion overlap, payment-shape CHECK,
// enforce_booking_validity trigger (inactive offering, class
// offering, inactive link) — rolls back that row's SAVEPOINT, goes in
// the report, and the load continues. Migrating dirty Setmore history
// must not abort the clean rows.
async function loadBookings(ctx) {
  banner('bookings');
  const rows = await readTransformed('bookings.json');
  if (!rows) return info('skip: bookings.json not found');

  rows.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  let inserted = 0;
  let alreadyPresent = 0;
  const skipped = [];
  await inTransaction(async (client) => {
    for (const b of rows) {
      const offering_id = ctx.offeringMap.get(String(b.source_offering_id));
      const resource_id = ctx.resourceMap.get(String(b.source_resource_id));
      const member_id = b.source_member_id != null
        ? ctx.memberMap.get(String(b.source_member_id))
        : null;
      if (!offering_id || !resource_id || (b.source_member_id != null && !member_id)) {
        skipped.push({
          source_id: b.source_id,
          start_time: b.start_time,
          code: null,
          reason: `unmapped ${!offering_id ? 'offering' : !resource_id ? 'resource' : 'member'} reference`,
        });
        continue;
      }

      try {
        await client.query('SAVEPOINT one_booking');
        const res = await client.query(
          `INSERT INTO bookings (
             id, tenant_id, offering_id, resource_id, member_id,
             customer_first_name, customer_last_name, customer_email, customer_phone,
             start_time, end_time, status,
             amount_due_cents, credit_cost_charged,
             amount_paid_cents, amount_refunded_cents,
             payment_status,
             cancelled_at, no_show_marked_at,
             created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, COALESCE($20, now())
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            b.id, b.tenant_id, offering_id, resource_id, member_id,
            b.customer_first_name, b.customer_last_name,
            b.customer_email, b.customer_phone,
            b.start_time, b.end_time, b.status,
            b.amount_due_cents, b.credit_cost_charged,
            b.amount_paid_cents, b.amount_refunded_cents,
            b.payment_status,
            b.cancelled_at, b.no_show_marked_at,
            b.created_at,
          ],
        );
        await client.query('RELEASE SAVEPOINT one_booking');
        if (res.rowCount === 1) inserted += 1;
        else alreadyPresent += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT one_booking');
        skipped.push({
          source_id: b.source_id,
          start_time: b.start_time,
          code: err.code ?? null,
          reason: err.message,
        });
      }
    }
  });
  info('loaded bookings', {
    inserted,
    already_present: alreadyPresent,
    skipped: skipped.length,
  });
  await writeReport('bookings_skipped.json', skipped);
  if (skipped.length > 0) {
    warn('bookings skipped — review before cutover', {
      count: skipped.length,
      report: join(REPORT_DIR, 'bookings_skipped.json'),
    });
  }
}

// ============================================================
// helpers
// ============================================================

async function readTransformed(filename) {
  const path = join(TRANSFORMED_DIR, filename);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Always written (empty array included) so "no report file" can never
// be mistaken for "nothing was skipped".
async function writeReport(filename, rows) {
  await mkdir(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, filename);
  await writeFile(path, JSON.stringify(rows, null, 2));
  info('report written', { path, count: rows.length });
}

main().catch((err) => {
  console.error('load failed:', err);
  process.exit(1);
});
