// 03_load.js — load transformed JSON into Courtside DB.
//
// Runs against the privileged pool (MIGRATION_DATABASE_URL) so we can
// INSERT across multiple tenants' tables and write to credit_ledger_
// entries directly. The runtime app_runtime role doesn't have those
// privileges — that's intentional, and bypassing here is the
// explicit escape hatch documented in CLAUDE.md.
//
// Idempotency strategy: each phase has a stable lookup key (email
// for users; stripe_subscription_id for subscriptions; etc.). Re-
// running the loader does an UPSERT keyed on that, so if 03_load
// fails partway through and we rerun, we don't duplicate rows.
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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info } from './shared/log.js';
import { inTransaction, pool } from './shared/db.js';

const TRANSFORMED_DIR = new URL('./out/transformed/', import.meta.url).pathname;

async function main() {
  banner('03 load');

  // Each phase reads its transformed file and runs the inserts.
  // Skeleton calls — fill in once 02_transform produces files.

  await loadUsersAndMembers();
  await loadPlans();
  await loadResourcesAndOfferings();
  await loadOperatingHours();
  await loadBookingPolicies();
  await loadStripeConnection();
  await loadSubscriptions();
  await loadCreditBalancesAndLedger();
  await loadBookings();

  await pool.end();
}

// ============================================================
// phase: users + members
// ============================================================
//
// UPSERT keyed on (tenant_id, email). Returns the courtside user_id
// + member_id maps for use by later phases.
async function loadUsersAndMembers() {
  banner('users + members');

  const rows = await readTransformed('users_and_members.json');
  if (!rows) {
    info('skip: out/transformed/users_and_members.json not found');
    return;
  }

  await inTransaction(async (client) => {
    for (const row of rows) {
      // Insert user
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

      // Insert member
      await client.query(
        `INSERT INTO members (tenant_id, user_id, email, first_name, last_name, phone, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               phone = EXCLUDED.phone`,
        [
          row.member.tenant_id,
          user_id,
          row.member.email,
          row.member.first_name,
          row.member.last_name,
          row.member.phone,
          row.member.created_at,
        ],
      );
    }
    info('loaded users + members', { count: rows.length });
  });
}

// ============================================================
// phase: plans
// ============================================================
//
// Plans are tenant-scoped. UPSERT on (tenant_id, lower(name)) when
// active=true (matches the partial unique index plans_active_name_unique).
// Set stripe_price_id from Momentum's existing connected account
// price IDs — we DO NOT mint new Prices because Stripe already has
// them.
async function loadPlans() {
  banner('plans');

  const rows = await readTransformed('plans.json');
  if (!rows) {
    info('skip: out/transformed/plans.json not found');
    return;
  }

  await inTransaction(async (client) => {
    for (const p of rows) {
      await client.query(
        `INSERT INTO plans (
           tenant_id, name, description, monthly_price_cents,
           credits_per_week, allowed_categories, stripe_price_id,
           active, display_order
         ) VALUES ($1, $2, $3, $4, $5, $6::category_key[], $7, $8, $9)
         ON CONFLICT (tenant_id, lower(name)) WHERE active = true
         DO UPDATE SET
           description = EXCLUDED.description,
           monthly_price_cents = EXCLUDED.monthly_price_cents,
           credits_per_week = EXCLUDED.credits_per_week,
           allowed_categories = EXCLUDED.allowed_categories,
           stripe_price_id = EXCLUDED.stripe_price_id`,
        [
          p.tenant_id, p.name, p.description, p.monthly_price_cents,
          p.credits_per_week, p.allowed_categories,
          p.stripe_price_id, p.active ?? true, p.display_order ?? 0,
        ],
      );
    }
    info('loaded plans', { count: rows.length });
  });
}

// ============================================================
// phase: resources + offerings + offering_resources
// ============================================================
async function loadResourcesAndOfferings() {
  banner('resources + offerings');

  const data = await readTransformed('resources_and_offerings.json');
  if (!data) {
    info('skip: out/transformed/resources_and_offerings.json not found');
    return;
  }

  await inTransaction(async (client) => {
    // Resources
    for (const r of data.resources ?? []) {
      await client.query(
        `INSERT INTO resources (tenant_id, name, display_order, active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET display_order = EXCLUDED.display_order,
               active = EXCLUDED.active`,
        [r.tenant_id, r.name, r.display_order ?? 0, r.active ?? true],
      );
    }
    // Offerings
    for (const o of data.offerings ?? []) {
      await client.query(
        `INSERT INTO offerings (
           tenant_id, name, category, duration_minutes, credit_cost,
           dollar_price, capacity, allow_member_booking, allow_public_booking, active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET category = EXCLUDED.category,
               duration_minutes = EXCLUDED.duration_minutes,
               credit_cost = EXCLUDED.credit_cost,
               dollar_price = EXCLUDED.dollar_price,
               capacity = EXCLUDED.capacity,
               allow_member_booking = EXCLUDED.allow_member_booking,
               allow_public_booking = EXCLUDED.allow_public_booking,
               active = EXCLUDED.active`,
        [
          o.tenant_id, o.name, o.category, o.duration_minutes, o.credit_cost,
          o.dollar_price, o.capacity ?? 1,
          o.allow_member_booking ?? true,
          o.allow_public_booking ?? true,
          o.active ?? true,
        ],
      );
    }
    // offering_resources links
    for (const link of data.links ?? []) {
      await client.query(
        `INSERT INTO offering_resources (tenant_id, offering_id, resource_id, active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [link.tenant_id, link.offering_id, link.resource_id, link.active ?? true],
      );
    }
    info('loaded catalog', {
      resources: data.resources?.length ?? 0,
      offerings: data.offerings?.length ?? 0,
      links: data.links?.length ?? 0,
    });
  });
}

async function loadOperatingHours() {
  banner('operating hours');
  const rows = await readTransformed('operating_hours.json');
  if (!rows) return info('skip: operating_hours.json not found');
  await inTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [r.tenant_id, r.resource_id, r.day_of_week, r.open_time, r.close_time],
      );
    }
    info('loaded operating_hours', { count: rows.length });
  });
}

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

async function loadStripeConnection() {
  banner('stripe connection');
  const rows = await readTransformed('stripe_connections.json');
  if (!rows) return info('skip: stripe_connections.json not found');
  await inTransaction(async (client) => {
    for (const c of rows) {
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
          c.details_submitted ?? true, c.charges_enabled ?? true,
          c.payouts_enabled ?? true,
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
async function loadSubscriptions() {
  banner('subscriptions');
  const rows = await readTransformed('subscriptions.json');
  if (!rows) return info('skip: subscriptions.json not found');

  await inTransaction(async (client) => {
    for (const r of rows) {
      // Upsert via stripe_subscription_id (unique partial index)
      const subResult = await client.query(
        `INSERT INTO subscriptions (
           tenant_id, member_id, status,
           stripe_subscription_id, stripe_customer_id,
           current_period_start, current_period_end,
           cancel_at_period_end, activated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL
         DO UPDATE SET
           status = EXCLUDED.status,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end
         RETURNING id`,
        [
          r.subscription.tenant_id, r.subscription.member_id, r.subscription.status,
          r.subscription.stripe_subscription_id, r.subscription.stripe_customer_id,
          r.subscription.current_period_start, r.subscription.current_period_end,
          r.subscription.cancel_at_period_end, r.subscription.activated_at,
        ],
      );
      const subscription_id = subResult.rows[0].id;

      // Plan period — open one if none exists yet for this subscription
      await client.query(
        `INSERT INTO subscription_plan_periods (
           tenant_id, subscription_id, plan_id, started_at, ended_at
         ) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
         ON CONFLICT DO NOTHING`,
        [
          r.plan_period.tenant_id, subscription_id, r.plan_period.plan_id,
          r.plan_period.started_at, r.plan_period.ended_at,
        ],
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
async function loadCreditBalancesAndLedger() {
  banner('credit balances + ledger');
  const rows = await readTransformed('credit_balances.json');
  if (!rows) return info('skip: credit_balances.json not found');

  await inTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO credit_balances (tenant_id, member_id, current_credits, last_reset_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, member_id) DO UPDATE SET
           current_credits = EXCLUDED.current_credits,
           last_reset_at = EXCLUDED.last_reset_at`,
        [r.balance.tenant_id, r.balance.member_id, r.balance.current_credits, r.balance.last_reset_at],
      );

      // Skip ledger row if balance is zero — apply_credit_change
      // also rejects amount=0. Keeps ledger clean.
      if (r.ledger.amount != null && r.ledger.amount !== 0) {
        // Avoid double-inserting on rerun: check if a 'migration'
        // ledger row already exists for this member.
        const existing = await client.query(
          `SELECT 1 FROM credit_ledger_entries
            WHERE tenant_id = $1 AND member_id = $2 AND reason = 'migration'
            LIMIT 1`,
          [r.ledger.tenant_id, r.ledger.member_id],
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO credit_ledger_entries (
               tenant_id, member_id, amount, balance_after, reason, note
             ) VALUES ($1, $2, $3, $4, 'migration', $5)`,
            [
              r.ledger.tenant_id, r.ledger.member_id,
              r.ledger.amount, r.ledger.balance_after, r.ledger.note,
            ],
          );
        }
      }
    }
    info('loaded credit_balances + ledger', { count: rows.length });
  });
}

// ============================================================
// phase: bookings
// ============================================================
//
// Inserted in chronological order so each row's GiST exclusion check
// runs against an already-loaded prefix. If two source rows overlap
// (Setmore had a bug, double-booked), the second INSERT 23P01s and
// load.js logs + skips it for manual review.
async function loadBookings() {
  banner('bookings');
  const rows = await readTransformed('bookings.json');
  if (!rows) return info('skip: bookings.json not found');

  // Sort by start_time so historical rows land first
  rows.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  let loaded = 0;
  let conflicts = 0;
  await inTransaction(async (client) => {
    for (const b of rows) {
      try {
        // SAVEPOINT per row so a GiST conflict on one doesn't poison
        // the outer transaction (same pattern as the class-instance
        // generator).
        await client.query('SAVEPOINT one_booking');
        await client.query(
          `INSERT INTO bookings (
             tenant_id, offering_id, resource_id, member_id,
             customer_first_name, customer_last_name, customer_email, customer_phone,
             start_time, end_time, status,
             amount_due_cents, credit_cost_charged,
             amount_paid_cents, amount_refunded_cents,
             payment_status,
             cancelled_at, no_show_marked_at,
             created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19
           )
           ON CONFLICT DO NOTHING`,
          [
            b.tenant_id, b.offering_id, b.resource_id, b.member_id,
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
        loaded += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT one_booking');
        if (err.code === '23P01') {
          conflicts += 1;
          info('booking conflict skipped', {
            booking_id: b.id ?? null,
            start_time: b.start_time,
          });
          continue;
        }
        throw err;
      }
    }
  });
  info('loaded bookings', { loaded, conflicts });
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

main().catch((err) => {
  console.error('load failed:', err);
  process.exit(1);
});
