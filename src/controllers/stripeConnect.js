// Stripe Connect onboarding — Phase 5 slice 1.
//
// Two endpoints, both admin-only:
//
//   POST /api/admin/stripe/onboarding
//     If the tenant has no stripe_connections row, creates a Standard
//     Connect account on Stripe and inserts the row. Either way,
//     returns a fresh hosted onboarding URL the admin should open
//     to complete (or update) the Stripe-side identity flow.
//
//   GET  /api/admin/stripe/connection
//     Returns the current connection row (or null if none yet). If
//     `?refresh=true`, calls Stripe to pull current account state
//     and updates the local DB row before responding. Webhook-driven
//     state sync lands in slice 2 — for now the admin can re-fetch
//     to update flags after completing onboarding.

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';
import { isUuid, buildSetClause } from './catalog.js';

// ============================================================
// POST /api/admin/plans/:id/stripe-sync — Phase 5 slice 3
// ============================================================
//
// Creates a Stripe Product + recurring Price on the tenant's
// connected account and stores the resulting price_id back on the
// plan. Idempotent: if the plan already has a stripe_price_id, this
// is a no-op (returning the existing id).
//
// Why per-tenant Products: each tenant runs Connect Standard, which
// means they're independent merchants on Stripe. A Price ID created
// on tenant A's account is meaningless to tenant B. The platform
// itself never owns plan Products — it just stores the references.
//
// Re-pricing: if a tenant changes monthly_price_cents on an
// already-synced plan, this endpoint does NOT replace the Stripe
// Price (Stripe immutability — prices can't be edited). For now,
// document the workflow as: deactivate old plan → create new plan
// with the new price → re-sync. Phase 5 slice 5+ may add a "rotate
// price" helper when subscriptions are in flight.
export async function syncPlanToStripe(req, res, next) {
  try {
    const { tenant, db } = req;
    const planId = req.params.id;

    // Pull plan + connection state in parallel-ish (still one client
    // because we're inside withTenantContext's transaction).
    const planRes = await db.query(
      `SELECT id, name, description, monthly_price_cents, active, stripe_price_id
         FROM plans WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, planId],
    );
    if (planRes.rows.length === 0) {
      return res.status(404).json({ error: 'plan not found' });
    }
    const plan = planRes.rows[0];

    // Already synced — return existing id without touching Stripe.
    if (plan.stripe_price_id) {
      return res.json({ plan, synced: false, reason: 'already synced' });
    }

    if (plan.monthly_price_cents <= 0) {
      return res
        .status(409)
        .json({ error: 'cannot sync a free plan to Stripe (no recurring price)' });
    }
    if (!plan.active) {
      return res
        .status(409)
        .json({ error: 'cannot sync an inactive plan; activate it first' });
    }

    // Pull connection. Must be present + charges_enabled before we
    // call Stripe. Otherwise the Price.create would 400 from Stripe
    // anyway with a less helpful error.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0) {
      return res.status(409).json({
        error: 'tenant has not connected a Stripe account; finish onboarding first',
      });
    }
    const conn = connRes.rows[0];
    if (!conn.charges_enabled) {
      return res.status(409).json({
        error: 'Stripe account is not yet charges-enabled; finish onboarding first',
      });
    }

    const stripe = getStripe();
    // Connect: every API call below must specify { stripeAccount }.
    const opts = { stripeAccount: conn.stripe_account_id };

    let priceId;
    try {
      const product = await stripe.products.create(
        {
          name: plan.name,
          description: plan.description ?? undefined,
          metadata: {
            courtside_plan_id: plan.id,
            courtside_tenant_id: tenant.id,
          },
        },
        opts,
      );
      const price = await stripe.prices.create(
        {
          product: product.id,
          unit_amount: plan.monthly_price_cents,
          currency: 'usd',
          recurring: { interval: 'month' },
          metadata: {
            courtside_plan_id: plan.id,
            courtside_tenant_id: tenant.id,
          },
        },
        opts,
      );
      priceId = price.id;
    } catch (err) {
      // Stripe-side failure (account not ready, validation, etc.).
      // Surface the message — admin needs to know what to fix.
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }

    // Store the price_id back on the plan. The unique index
    // plans_stripe_price_unique catches a same-id collision (would
    // only happen on a buggy/double call); we already short-circuited
    // above when stripe_price_id was already set, so a 23505 here is
    // a genuine bug, not a normal case.
    const updRes = await db.query(
      `UPDATE plans
          SET stripe_price_id = $1
        WHERE tenant_id = $2 AND id = $3
        RETURNING id, name, description, monthly_price_cents,
                  credits_per_week,
                  allowed_categories::text[] AS allowed_categories,
                  stripe_price_id, active, display_order,
                  created_at, updated_at`,
      [priceId, tenant.id, planId],
    );

    res.json({ plan: updRes.rows[0], synced: true });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// PATCH /api/admin/plans/:id — Tier-A sell-readiness slice
// ============================================================
//
// Partial plan update + soft activate/deactivate. Lives here (not
// catalog.js) because re-pricing a Stripe-synced plan rotates the
// Stripe Price:
//
//   * price change on a synced plan → create a NEW Stripe Price on
//     the same Product, point the plan at it, and archive the old
//     Price AFTER commit. Existing subscriptions stay on their old
//     Price — Stripe subscriptions reference the price they were
//     created with, so existing members keep their current rate.
//   * name/description change on a synced plan → update the Stripe
//     Product in place (Products are mutable; Prices are not).
//   * unsynced plans (stripe_price_id IS NULL) are plain DB updates.
//
// The old Price is archived on res 'finish' (fires after
// withTenantContext's COMMIT) so a failed commit can't leave the
// plan pointing at an archived price. If the archive call itself
// fails, both prices stay active on Stripe — harmless, the old one
// is simply unreferenced. TODO: move to the outbox once it exists.
//
// Lock discipline (CLAUDE.md "what NOT to do during a tenant
// transaction"): the Stripe calls run against an UNLOCKED read of the
// plan row — no FOR UPDATE is held across Stripe latency, so
// concurrent plan reads/edits never queue behind a slow Stripe API.
// Instead of a lock, the price rotation uses an optimistic guard: the
// final UPDATE requires stripe_price_id to still equal the value we
// read. If a concurrent edit rotated it first, we 409, archive the
// price we just created (now orphaned), and let the admin retry.
const CATEGORY_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const planUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  monthly_price_cents: z.number().int().nonnegative().optional(),
  credits_per_week: z.number().int().nonnegative().optional(),
  // null = clear the whitelist ("all categories"); non-empty array =
  // set it. Empty array rejected (matches the schema CHECK).
  allowed_categories: z
    .array(z.string().regex(CATEGORY_REGEX))
    .min(1, 'allowed_categories must be null or contain at least one category')
    .nullable()
    .optional(),
  display_order: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

const PLAN_RETURNING = `RETURNING id, name, description, monthly_price_cents,
                  credits_per_week,
                  allowed_categories::text[] AS allowed_categories,
                  stripe_price_id, active, display_order,
                  created_at, updated_at`;

export async function updatePlan(req, res, next) {
  try {
    const { tenant, db } = req;
    const planId = req.params.id;
    if (!isUuid(planId)) {
      return res.status(404).json({ error: 'plan not found' });
    }
    const parsed = planUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (Object.keys(d).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    // Plain read — deliberately NOT FOR UPDATE (see header: no row
    // lock may be held across the Stripe calls below).
    const curRes = await db.query(
      `SELECT id, name, description, monthly_price_cents, stripe_price_id, active
         FROM plans
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, planId],
    );
    if (curRes.rows.length === 0) {
      return res.status(404).json({ error: 'plan not found' });
    }
    const plan = curRes.rows[0];

    const synced = plan.stripe_price_id !== null;
    const priceChanging =
      synced &&
      d.monthly_price_cents !== undefined &&
      d.monthly_price_cents !== plan.monthly_price_cents;
    const productChanging =
      synced &&
      ((d.name !== undefined && d.name !== plan.name) ||
        (d.description !== undefined && d.description !== plan.description));

    if (priceChanging && d.monthly_price_cents === 0) {
      return res.status(409).json({
        error: 'cannot re-price a Stripe-synced plan to free; deactivate it and create a free plan instead',
      });
    }

    let newPriceId;
    let oldPriceId = null;
    let stripeAccountId = null;
    if (priceChanging || productChanging) {
      const connRes = await db.query(
        `SELECT stripe_account_id FROM stripe_connections WHERE tenant_id = $1`,
        [tenant.id],
      );
      if (connRes.rows.length === 0) {
        return res.status(409).json({
          error: 'plan is Stripe-synced but tenant has no Stripe connection',
        });
      }
      stripeAccountId = connRes.rows[0].stripe_account_id;
      const stripe = getStripe();
      const opts = { stripeAccount: stripeAccountId };

      try {
        // The stored price knows its Product — that's the anchor for
        // both the Product update and the replacement Price.
        const oldPrice = await stripe.prices.retrieve(plan.stripe_price_id, opts);

        if (productChanging) {
          await stripe.products.update(
            oldPrice.product,
            {
              ...(d.name !== undefined ? { name: d.name } : {}),
              ...(d.description !== undefined
                ? { description: d.description ?? undefined }
                : {}),
            },
            opts,
          );
        }

        if (priceChanging) {
          const newPrice = await stripe.prices.create(
            {
              product: oldPrice.product,
              unit_amount: d.monthly_price_cents,
              currency: 'usd',
              recurring: { interval: 'month' },
              metadata: {
                courtside_plan_id: plan.id,
                courtside_tenant_id: tenant.id,
              },
            },
            opts,
          );
          newPriceId = newPrice.id;
          oldPriceId = plan.stripe_price_id;
        }
      } catch (err) {
        const msg = err?.message ?? 'Stripe API error';
        const status = err?.statusCode === 400 ? 400 : 502;
        return res.status(status).json({ error: `stripe error: ${msg}` });
      }
    }

    const { clauses, values, nextIndex } = buildSetClause({
      name: d.name,
      description: d.description,
      monthly_price_cents: d.monthly_price_cents,
      credits_per_week: d.credits_per_week,
      allowed_categories: d.allowed_categories,
      display_order: d.display_order,
      active: d.active,
      stripe_price_id: newPriceId,
    });

    // Optimistic guard replaces the row lock: when we minted a
    // replacement Price (or pushed name/description to Stripe based
    // on the stripe_price_id we read), the UPDATE only lands if
    // stripe_price_id is still what we read. 0 rows = concurrent
    // rotation → clean up our now-orphaned Price and 409.
    const guarded = priceChanging || productChanging;
    const guardClause = guarded
      ? ` AND stripe_price_id = $${nextIndex + 2}`
      : '';
    let updated;
    try {
      const result = await db.query(
        `UPDATE plans
            SET ${clauses.join(', ')}
          WHERE tenant_id = $${nextIndex} AND id = $${nextIndex + 1}${guardClause}
          ${PLAN_RETURNING}`,
        [
          ...values,
          tenant.id,
          planId,
          ...(guarded ? [plan.stripe_price_id] : []),
        ],
      );
      updated = result.rows[0];
      if (guarded && !updated) {
        if (newPriceId) {
          // Archive the price we created for an update that lost the
          // race — fire-and-forget, same failure tolerance as the
          // post-commit archive below.
          getStripe()
            .prices.update(newPriceId, { active: false }, { stripeAccount: stripeAccountId })
            .catch((archiveErr) =>
              console.error(
                `failed to archive orphaned Stripe price ${newPriceId}:`,
                archiveErr,
              ),
            );
        }
        return res.status(409).json({
          error: 'plan was modified concurrently; reload and retry',
        });
      }
    } catch (err) {
      if (err.code === '23505') {
        // plans_active_name_unique (rename / reactivate collision)
        // or plans_stripe_price_unique.
        return res
          .status(409)
          .json({ error: 'plan name or stripe_price_id already in use' });
      }
      if (err.code === '23514') {
        return res.status(400).json({ error: 'invalid plan: schema CHECK failed' });
      }
      throw err;
    }

    if (oldPriceId) {
      // Archive the replaced Price after COMMIT (see header comment).
      const archiveOpts = { stripeAccount: stripeAccountId };
      const priceToArchive = oldPriceId;
      res.on('finish', () => {
        getStripe()
          .prices.update(priceToArchive, { active: false }, archiveOpts)
          .catch((err) =>
            console.error(`failed to archive Stripe price ${priceToArchive}:`, err),
          );
      });
    }

    res.json({
      plan: updated,
      stripe_price_rotated: Boolean(oldPriceId),
      ...(oldPriceId ? { previous_stripe_price_id: oldPriceId } : {}),
    });
  } catch (err) {
    next(err);
  }
}

const onboardingSchema = z.object({
  return_url: z.string().url(),
  refresh_url: z.string().url(),
});

export async function startOnboarding(req, res, next) {
  try {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { return_url, refresh_url } = parsed.data;
    const { tenant, db } = req;
    const stripe = getStripe();

    // Look up existing connection.
    const existing = await db.query(
      `SELECT stripe_account_id FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );

    let stripe_account_id;
    if (existing.rows.length > 0) {
      stripe_account_id = existing.rows[0].stripe_account_id;
    } else {
      // Create a fresh Standard Connect account. Pre-fill business_type
      // from the tenant — Stripe lets the user override during their
      // own onboarding form. We DO NOT pass capabilities; Standard
      // accounts get card_payments + transfers automatically.
      //
      // The JWT payload deliberately carries only IDs (see signToken in
      // auth.js) — req.user.email does not exist, so look the email up.
      // Reading req.user.email directly here used to silently pre-fill
      // nothing (undefined) on every onboarding.
      const emailRow = await db.query(
        `SELECT email FROM users WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, req.user.user_id],
      );
      const adminEmail = emailRow.rows[0]?.email;
      const account = await stripe.accounts.create({
        type: 'standard',
        email: adminEmail ?? undefined,
        country: 'US',
        metadata: {
          courtside_tenant_id: tenant.id,
          courtside_subdomain: tenant.subdomain,
        },
      });
      stripe_account_id = account.id;
      await db.query(
        `INSERT INTO stripe_connections (
           tenant_id, stripe_account_id,
           details_submitted, charges_enabled, payouts_enabled
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [
          tenant.id,
          stripe_account_id,
          account.details_submitted,
          account.charges_enabled,
          account.payouts_enabled,
        ],
      );
    }

    // Account links are short-lived (~5 min). Generate fresh on every
    // call — admins might revisit the page.
    const link = await stripe.accountLinks.create({
      account: stripe_account_id,
      type: 'account_onboarding',
      return_url,
      refresh_url,
    });

    res.json({
      stripe_account_id,
      onboarding_url: link.url,
      expires_at: link.expires_at,
    });
  } catch (err) {
    next(err);
  }
}

export async function getConnection(req, res, next) {
  try {
    const { tenant, db } = req;
    const refresh = String(req.query.refresh) === 'true';

    const r = await db.query(
      `SELECT stripe_account_id, details_submitted, charges_enabled,
              payouts_enabled, platform_fee_basis_points,
              connected_at, fully_onboarded_at
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (r.rows.length === 0) {
      return res.json({ connection: null });
    }
    let row = r.rows[0];

    if (refresh) {
      // Pull fresh state from Stripe and reconcile the DB. Useful
      // right after the admin returns from the Stripe-hosted
      // onboarding flow to see updated flags without waiting for
      // the webhook (slice 2).
      const stripe = getStripe();
      let account;
      try {
        account = await stripe.accounts.retrieve(row.stripe_account_id);
      } catch (err) {
        // If the Stripe account was deleted out from under us, surface
        // it but don't blow up — keep the cached row.
        return res.json({
          connection: row,
          refresh_error: err.message,
        });
      }

      const fully = account.details_submitted && account.charges_enabled;
      const upd = await db.query(
        `UPDATE stripe_connections
            SET details_submitted = $1,
                charges_enabled    = $2,
                payouts_enabled    = $3,
                fully_onboarded_at = COALESCE(fully_onboarded_at,
                                              CASE WHEN $4 THEN now() ELSE NULL END)
          WHERE tenant_id = $5
          RETURNING stripe_account_id, details_submitted, charges_enabled,
                    payouts_enabled, platform_fee_basis_points,
                    connected_at, fully_onboarded_at`,
        [
          account.details_submitted,
          account.charges_enabled,
          account.payouts_enabled,
          fully,
          tenant.id,
        ],
      );
      row = upd.rows[0];
    }

    res.json({ connection: row });
  } catch (err) {
    next(err);
  }
}
