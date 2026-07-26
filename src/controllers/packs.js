// One-time credit packs — credit-packs slice.
//
// "Buy a 10-pack, no subscription." Two audiences:
//
//   Admin (/api/admin/packs, requireAdmin):
//     * GET    — full catalog including deactivated packs
//     * POST   — create
//     * PATCH  — partial update + soft activate/deactivate (mirrors
//       the catalog PATCH endpoints; packs are never DELETEd — the
//       ledger notes reference their names and history matters)
//
//   Member (/api/packs, requireAuth):
//     * GET           — active packs only (the storefront)
//     * POST /:id/checkout — Stripe Checkout Session (mode='payment')
//       on the tenant's connected account. The webhook
//       (checkout.session.completed with metadata
//       courtside_type='pack_purchase') grants the credits via
//       apply_credit_change — see stripeWebhook.js.
//
// Credits granted at webhook time are the SNAPSHOT taken here
// (metadata.courtside_credits), so an admin editing the pack while a
// member sits on the Stripe-hosted page can't change what the member
// paid for.
//
// No DB writes happen before the Stripe call — the open req.db
// transaction is read-only at that point (same shape as the
// subscription checkout in memberSubscriptions.js), so nothing is
// held hostage to Stripe latency.

import { z } from 'zod';
import { getStripe } from '../services/stripe.js';
import { isUuid, buildSetClause } from './catalog.js';

const PACK_COLUMNS = `id, name, credits, price_cents, active, created_at, updated_at`;

// ============================================================
// admin
// ============================================================

const packCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  credits: z.number().int().positive(),
  price_cents: z.number().int().positive(),
});

export async function listPacksAdmin(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT ${PACK_COLUMNS}
         FROM credit_packs
        WHERE tenant_id = $1
        ORDER BY active DESC, price_cents ASC, name ASC`,
      [req.tenant.id],
    );
    res.json({ packs: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createPack(req, res, next) {
  try {
    const parsed = packCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;

    try {
      const result = await req.db.query(
        `INSERT INTO credit_packs (tenant_id, name, credits, price_cents)
         VALUES ($1, $2, $3, $4)
         RETURNING ${PACK_COLUMNS}`,
        [req.tenant.id, d.name, d.credits, d.price_cents],
      );
      res.status(201).json({ pack: result.rows[0] });
    } catch (err) {
      if (err.code === '23514') {
        return res
          .status(400)
          .json({ error: 'invalid pack: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

const packUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  credits: z.number().int().positive().optional(),
  price_cents: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});

// PATCH /api/admin/packs/:id — partial update + soft
// activate/deactivate. Deactivated packs disappear from the member
// storefront and are rejected at checkout; already-granted credits
// are untouched (the ledger snapshot is the record).
export async function updatePack(req, res, next) {
  try {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(404).json({ error: 'pack not found' });
    }
    const parsed = packUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const { clauses, values, nextIndex } = buildSetClause({
      name: d.name,
      credits: d.credits,
      price_cents: d.price_cents,
      active: d.active,
    });
    if (clauses.length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    try {
      const result = await req.db.query(
        `UPDATE credit_packs
            SET ${clauses.join(', ')}
          WHERE tenant_id = $${nextIndex} AND id = $${nextIndex + 1}
          RETURNING ${PACK_COLUMNS}`,
        [...values, req.tenant.id, id],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'pack not found' });
      }
      res.json({ pack: result.rows[0] });
    } catch (err) {
      if (err.code === '23514') {
        return res
          .status(400)
          .json({ error: 'invalid pack: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// ============================================================
// member
// ============================================================

// GET /api/packs — the storefront: active packs only, cheapest first.
export async function listActivePacks(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT id, name, credits, price_cents
         FROM credit_packs
        WHERE tenant_id = $1 AND active
        ORDER BY price_cents ASC, name ASC`,
      [req.tenant.id],
    );
    res.json({ packs: result.rows });
  } catch (err) {
    next(err);
  }
}

const checkoutSchema = z.object({
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

// POST /api/packs/:id/checkout — mint a Stripe Checkout Session for
// the pack. Grant happens in the webhook, never here.
export async function startPackCheckout(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res.status(403).json({ error: 'must be signed in as a member' });
    }
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(404).json({ error: 'pack not found' });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { success_url, cancel_url } = parsed.data;
    const { tenant, db, user } = req;

    // 1. Pack must exist and be active.
    const packRes = await db.query(
      `SELECT id, name, credits, price_cents, active
         FROM credit_packs
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    );
    if (packRes.rows.length === 0) {
      return res.status(404).json({ error: 'pack not found' });
    }
    const pack = packRes.rows[0];
    if (!pack.active) {
      return res.status(409).json({ error: 'pack is no longer available' });
    }

    // 2. Connection must be charges-enabled.
    const connRes = await db.query(
      `SELECT stripe_account_id, charges_enabled
         FROM stripe_connections WHERE tenant_id = $1`,
      [tenant.id],
    );
    if (connRes.rows.length === 0 || !connRes.rows[0].charges_enabled) {
      return res
        .status(409)
        .json({ error: 'tenant not yet ready to accept payments' });
    }
    const conn = connRes.rows[0];

    // 3. Member contact for the Checkout page prefill + receipt.
    const memberRes = await db.query(
      `SELECT email FROM members WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, user.member_id],
    );
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ error: 'member record missing' });
    }
    const member = memberRes.rows[0];

    // 4. Create the session. price_data is inline — no Stripe Product
    //    per pack. Metadata is the bridge the webhook reads:
    //    courtside_type routes the mode='payment' event to the pack
    //    handler (vs the walk-in booking handler), courtside_credits
    //    snapshots the grant size at purchase time.
    try {
      const session = await getStripe().checkout.sessions.create(
        {
          mode: 'payment',
          customer_email: member.email,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                unit_amount: pack.price_cents,
                product_data: {
                  name: `${pack.name} (${pack.credits} credit${pack.credits === 1 ? '' : 's'})`,
                },
              },
              quantity: 1,
            },
          ],
          success_url,
          cancel_url,
          metadata: {
            courtside_type: 'pack_purchase',
            courtside_tenant_id: tenant.id,
            courtside_pack_id: pack.id,
            courtside_member_id: user.member_id,
            courtside_credits: String(pack.credits),
          },
        },
        { stripeAccount: conn.stripe_account_id },
      );
      res.status(201).json({ url: session.url, session_id: session.id });
    } catch (err) {
      const msg = err?.message ?? 'Stripe API error';
      const status = err?.statusCode === 400 ? 400 : 502;
      return res.status(status).json({ error: `stripe error: ${msg}` });
    }
  } catch (err) {
    next(err);
  }
}
