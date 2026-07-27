// Admin catalog CRUD — Phase 2, slice 2 (create + list) and the
// Tier-A sell-readiness slice (update + deactivate/reactivate).
//
// Resources, offerings, and the offering↔resource link table. All
// endpoints sit under /api/admin/* and require the admin role
// (gated by requireAdmin in the routes file).
//
// Schema-level soft-delete (active = false) is the model — bookings
// reference these rows so we never DELETE. Deactivated rows are
// hidden from member/public booking + new purchase paths (those
// already filter on `active`); existing bookings/subscriptions are
// untouched because bookings snapshot cost at creation and
// subscriptions reference their own Stripe price.
//
// Plan updates live in stripeConnect.js (updatePlan) because
// re-pricing a Stripe-synced plan rotates the Stripe Price.

import { z } from 'zod';

// UUID sanity check for :id route params. Without this a malformed
// id reaches Postgres as an invalid uuid literal (22P02) and surfaces
// as a 500 instead of a 404.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// Shared helper for the PATCH endpoints: build a dynamic
// `SET col = $n` list from only the fields the admin actually sent.
// `fields` maps column name → value (undefined = not provided; null
// is a real value, e.g. clearing plans.allowed_categories).
export function buildSetClause(fields, startIndex = 1) {
  const clauses = [];
  const values = [];
  let i = startIndex;
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    clauses.push(`${col} = $${i}`);
    values.push(val);
    i += 1;
  }
  return { clauses, values, nextIndex: i };
}

// ============================================================
// resources
// ============================================================

const resourceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  display_order: z.number().int().nonnegative().optional(),
});

export async function listResources(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT id, name, display_order, active, created_at, updated_at
         FROM resources
        WHERE tenant_id = $1
        ORDER BY display_order ASC, name ASC`,
      [req.tenant.id],
    );
    res.json({ resources: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createResource(req, res, next) {
  try {
    const parsed = resourceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { name, display_order } = parsed.data;

    try {
      const result = await req.db.query(
        `INSERT INTO resources (tenant_id, name, display_order)
         VALUES ($1, $2, $3)
         RETURNING id, name, display_order, active, created_at, updated_at`,
        [req.tenant.id, name, display_order ?? 0],
      );
      res.status(201).json({ resource: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        // UNIQUE (tenant_id, name) — admin tried to use an existing
        // resource name.
        return res
          .status(409)
          .json({ error: 'resource name already exists in this tenant' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

const resourceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  display_order: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

// PATCH /api/admin/resources/:id — partial update + soft
// activate/deactivate. Deactivated resources are hidden from
// availability and rejected at booking time (existing checks on
// resources.active); historical bookings keep referencing the row.
export async function updateResource(req, res, next) {
  try {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(404).json({ error: 'resource not found' });
    }
    const parsed = resourceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const { clauses, values, nextIndex } = buildSetClause({
      name: d.name,
      display_order: d.display_order,
      active: d.active,
    });
    if (clauses.length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    try {
      const result = await req.db.query(
        `UPDATE resources
            SET ${clauses.join(', ')}
          WHERE tenant_id = $${nextIndex} AND id = $${nextIndex + 1}
          RETURNING id, name, display_order, active, created_at, updated_at`,
        [...values, req.tenant.id, id],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'resource not found' });
      }
      res.json({ resource: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: 'resource name already exists in this tenant' });
      }
      if (err.code === '23514') {
        return res
          .status(400)
          .json({ error: 'invalid resource: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// ============================================================
// offerings
// ============================================================

// Mirrors schema.sql's category_key domain regex. Reserved names
// aren't enforced here; the schema doesn't reserve any (only tenants
// has a reserved-subdomain CHECK).
const CATEGORY_REGEX = /^[a-z0-9][a-z0-9-]*$/;

// Customer-facing blurb for the booking page's details expander.
// Whitespace-only → null (the DB CHECK rejects blank non-null).
const descriptionSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(5000).nullable().optional(),
);

const offeringCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().regex(CATEGORY_REGEX, 'category must be lowercase, hyphenated, alphanumeric'),
  description: descriptionSchema,
  duration_minutes: z.number().int().positive(),
  credit_cost: z.number().int().nonnegative(),
  // dollar_price is in cents — clarified in CLAUDE.md
  dollar_price: z.number().int().nonnegative(),
  capacity: z.number().int().min(1).optional(),
  allow_member_booking: z.boolean().optional(),
  allow_public_booking: z.boolean().optional(),
  display_order: z.number().int().nonnegative().optional(),
});

export async function listOfferings(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT id, name, category, description, duration_minutes, credit_cost,
              dollar_price, capacity, allow_member_booking,
              allow_public_booking, active, display_order,
              created_at, updated_at
         FROM offerings
        WHERE tenant_id = $1
        ORDER BY display_order ASC, name ASC`,
      [req.tenant.id],
    );
    res.json({ offerings: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createOffering(req, res, next) {
  try {
    const parsed = offeringCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;

    // Pre-validate the no-audience CHECK at the app layer for a
    // cleaner error than a 23514 from the DB. Active offerings (the
    // default) need at least one allow_*_booking = true.
    const memberOk = d.allow_member_booking ?? true;
    const publicOk = d.allow_public_booking ?? false;
    if (!memberOk && !publicOk) {
      return res.status(400).json({
        error: 'an active offering must allow at least one of member or public booking',
      });
    }

    try {
      const result = await req.db.query(
        `INSERT INTO offerings (
           tenant_id, name, category, description, duration_minutes,
           credit_cost, dollar_price, capacity, allow_member_booking,
           allow_public_booking, display_order
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, name, category, description, duration_minutes,
                   credit_cost, dollar_price, capacity, allow_member_booking,
                   allow_public_booking, active, display_order,
                   created_at, updated_at`,
        [
          req.tenant.id,
          d.name,
          d.category,
          d.description ?? null,
          d.duration_minutes,
          d.credit_cost,
          d.dollar_price,
          d.capacity ?? 1,
          memberOk,
          publicOk,
          d.display_order ?? 0,
        ],
      );
      res.status(201).json({ offering: result.rows[0] });
    } catch (err) {
      // Domain CHECK on category, capacity CHECK, etc.
      if (err.code === '23514') {
        return res.status(400).json({ error: 'invalid offering: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

const offeringUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z
    .string()
    .regex(CATEGORY_REGEX, 'category must be lowercase, hyphenated, alphanumeric')
    .optional(),
  description: descriptionSchema,
  duration_minutes: z.number().int().positive().optional(),
  credit_cost: z.number().int().nonnegative().optional(),
  dollar_price: z.number().int().nonnegative().optional(),
  capacity: z.number().int().min(1).optional(),
  allow_member_booking: z.boolean().optional(),
  allow_public_booking: z.boolean().optional(),
  display_order: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  // Full reconcile of offering↔resource links: resources listed here
  // end up linked+active, everything else is soft-unlinked
  // (active = false — the row survives for historical bookings).
  resource_ids: z.array(z.string().uuid()).optional(),
});

// PATCH /api/admin/offerings/:id — partial update + soft
// activate/deactivate + resource-association reconcile.
//
// Price/credit-cost changes affect only NEW bookings: bookings
// snapshot amount_due_cents + credit_cost_charged at creation
// (migration 007), so history is untouched.
export async function updateOffering(req, res, next) {
  try {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(404).json({ error: 'offering not found' });
    }
    const parsed = offeringUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (Object.keys(d).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    // Lock the current row: we need it to validate the merged
    // audience state app-side (cleaner error than the DB's 23514)
    // and as the response body when only links change.
    const curRes = await req.db.query(
      `SELECT id, name, category, description, duration_minutes, credit_cost,
              dollar_price, capacity, allow_member_booking,
              allow_public_booking, active, display_order,
              created_at, updated_at
         FROM offerings
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [req.tenant.id, id],
    );
    if (curRes.rows.length === 0) {
      return res.status(404).json({ error: 'offering not found' });
    }
    const current = curRes.rows[0];

    // Merged post-update state must satisfy the "active offerings
    // need at least one audience" rule.
    const mergedActive = d.active ?? current.active;
    const mergedMember = d.allow_member_booking ?? current.allow_member_booking;
    const mergedPublic = d.allow_public_booking ?? current.allow_public_booking;
    if (mergedActive && !mergedMember && !mergedPublic) {
      return res.status(400).json({
        error: 'an active offering must allow at least one of member or public booking',
      });
    }

    // Reconcile resource links first (same transaction — atomic with
    // the field update).
    if (d.resource_ids !== undefined) {
      if (d.resource_ids.length > 0) {
        const found = await req.db.query(
          `SELECT count(*)::int AS n FROM resources
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
          [req.tenant.id, d.resource_ids],
        );
        if (found.rows[0].n !== new Set(d.resource_ids).size) {
          return res
            .status(400)
            .json({ error: 'one or more resources not found in this tenant' });
        }
        await req.db.query(
          `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
           SELECT $1, $2, unnest($3::uuid[])
           ON CONFLICT (tenant_id, offering_id, resource_id)
           DO UPDATE SET active = true`,
          [req.tenant.id, id, d.resource_ids],
        );
      }
      // Soft-unlink everything not in the list. ANY over an empty
      // array matches nothing, so resource_ids: [] unlinks all.
      await req.db.query(
        `UPDATE offering_resources
            SET active = false
          WHERE tenant_id = $1 AND offering_id = $2
            AND active
            AND NOT (resource_id = ANY($3::uuid[]))`,
        [req.tenant.id, id, d.resource_ids],
      );
    }

    const { clauses, values, nextIndex } = buildSetClause({
      name: d.name,
      category: d.category,
      description: d.description,
      duration_minutes: d.duration_minutes,
      credit_cost: d.credit_cost,
      dollar_price: d.dollar_price,
      capacity: d.capacity,
      allow_member_booking: d.allow_member_booking,
      allow_public_booking: d.allow_public_booking,
      display_order: d.display_order,
      active: d.active,
    });

    let offering = current;
    if (clauses.length > 0) {
      try {
        const result = await req.db.query(
          `UPDATE offerings
              SET ${clauses.join(', ')}
            WHERE tenant_id = $${nextIndex} AND id = $${nextIndex + 1}
            RETURNING id, name, category, description, duration_minutes,
                      credit_cost, dollar_price, capacity,
                      allow_member_booking, allow_public_booking, active,
                      display_order, created_at, updated_at`,
          [...values, req.tenant.id, id],
        );
        offering = result.rows[0];
      } catch (err) {
        if (err.code === '23514') {
          return res
            .status(400)
            .json({ error: 'invalid offering: schema CHECK failed' });
        }
        throw err;
      }
    }

    res.json({ offering });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// offering_resources (the link table)
// ============================================================

const linkResourceSchema = z.object({
  resource_id: z.string().uuid(),
});

export async function listOfferingResources(req, res, next) {
  try {
    const offering_id = req.params.id;
    const result = await req.db.query(
      `SELECT r.id            AS resource_id,
              r.name          AS resource_name,
              r.display_order AS resource_display_order,
              r.active        AS resource_active,
              orx.active      AS link_active,
              orx.created_at  AS linked_at
         FROM offering_resources orx
         JOIN resources r
           ON r.tenant_id = orx.tenant_id
          AND r.id        = orx.resource_id
        WHERE orx.tenant_id  = $1
          AND orx.offering_id = $2
        ORDER BY r.display_order ASC, r.name ASC`,
      [req.tenant.id, offering_id],
    );
    res.json({ resources: result.rows });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// plans
// ============================================================

const planCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    monthly_price_cents: z.number().int().nonnegative(),
    credits_per_week: z.number().int().nonnegative(),
    // null/undefined = all categories allowed; non-empty array =
    // whitelist. Empty array is rejected at schema CHECK level
    // (cardinality > 0); we add an app-level guard for clarity too.
    allowed_categories: z
      .array(z.string().regex(CATEGORY_REGEX))
      .min(1, 'allowed_categories must be null/omitted or contain at least one category')
      .optional()
      .nullable(),
    stripe_price_id: z.string().optional().nullable(),
    display_order: z.number().int().nonnegative().optional(),
  });

export async function listPlans(req, res, next) {
  try {
    const result = await req.db.query(
      // allowed_categories is category_key[] (domain over text). pg's
      // built-in type parsers don't know about the domain OID, so it
      // comes back as the literal '{classes}' string. Casting to
      // text[] gives pg a known type to parse.
      `SELECT id, name, description, monthly_price_cents, credits_per_week,
              allowed_categories::text[] AS allowed_categories,
              stripe_price_id, active, display_order,
              created_at, updated_at
         FROM plans
        WHERE tenant_id = $1
        ORDER BY display_order ASC, name ASC`,
      [req.tenant.id],
    );
    res.json({ plans: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createPlan(req, res, next) {
  try {
    const parsed = planCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;

    try {
      const result = await req.db.query(
        `INSERT INTO plans (
           tenant_id, name, description, monthly_price_cents,
           credits_per_week, allowed_categories, stripe_price_id,
           display_order
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, description, monthly_price_cents,
                   credits_per_week,
                   allowed_categories::text[] AS allowed_categories,
                   stripe_price_id, active, display_order,
                   created_at, updated_at`,
        [
          req.tenant.id,
          d.name,
          d.description ?? null,
          d.monthly_price_cents,
          d.credits_per_week,
          d.allowed_categories ?? null,
          d.stripe_price_id ?? null,
          d.display_order ?? 0,
        ],
      );
      res.status(201).json({ plan: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        // Either the partial unique index plans_active_name_unique
        // (case-insensitive name + active = true) or the global
        // unique index on stripe_price_id.
        return res.status(409).json({ error: 'plan name or stripe_price_id already in use' });
      }
      if (err.code === '23514') {
        // Domain category_key, allowed_categories cardinality, or
        // any other CHECK.
        return res.status(400).json({ error: 'invalid plan: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

export async function linkResourceToOffering(req, res, next) {
  try {
    const offering_id = req.params.id;
    const parsed = linkResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input' });
    }
    const { resource_id } = parsed.data;

    try {
      await req.db.query(
        `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
         VALUES ($1, $2, $3)`,
        [req.tenant.id, offering_id, resource_id],
      );
      res.status(201).json({ ok: true, offering_id, resource_id });
    } catch (err) {
      if (err.code === '23505') {
        return res
          .status(409)
          .json({ error: 'resource already linked to this offering' });
      }
      if (err.code === '23503') {
        // Composite FK violation — offering or resource doesn't
        // exist in this tenant.
        return res
          .status(400)
          .json({ error: 'offering or resource not found in this tenant' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

// ============================================================
// category_display (section labels + ordering, migration 028)
// ============================================================
//
// Pure display overlay for the public booking page: a label + section
// order per category key. A key with no row falls back to a
// client-derived label (formatCategoryLabel). Deleting a row reverts
// to the derived label; nothing here touches offerings or plan
// restrictions.

const categoryDisplaySchema = z.object({
  label: z.string().trim().min(1).max(200),
  display_order: z.number().int().nonnegative().optional(),
});

// GET /api/admin/category-display — the overlay rows PLUS every
// category key currently in use by offerings, so the admin UI can
// show unlabeled keys and prune orphans.
export async function listCategoryDisplay(req, res, next) {
  try {
    const rowsRes = await req.db.query(
      `SELECT category, label, display_order, updated_at
         FROM category_display
        WHERE tenant_id = $1
        ORDER BY display_order ASC, category ASC`,
      [req.tenant.id],
    );
    const usedRes = await req.db.query(
      `SELECT DISTINCT category FROM offerings
        WHERE tenant_id = $1
        ORDER BY category ASC`,
      [req.tenant.id],
    );
    res.json({
      categories: rowsRes.rows,
      categories_in_use: usedRes.rows.map((r) => r.category),
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/category-display/:category — upsert label + order.
export async function upsertCategoryDisplay(req, res, next) {
  try {
    const category = req.params.category;
    if (!CATEGORY_REGEX.test(category)) {
      return res.status(400).json({
        error: 'category must be lowercase, hyphenated, alphanumeric',
      });
    }
    const parsed = categoryDisplaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const result = await req.db.query(
      `INSERT INTO category_display (tenant_id, category, label, display_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, category) DO UPDATE SET
         label = EXCLUDED.label,
         display_order = EXCLUDED.display_order
       RETURNING category, label, display_order, updated_at`,
      [req.tenant.id, category, d.label, d.display_order ?? 0],
    );
    res.json({ category_display: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin/category-display/:category — revert to derived.
export async function deleteCategoryDisplay(req, res, next) {
  try {
    const category = req.params.category;
    if (!CATEGORY_REGEX.test(category)) {
      return res.status(404).json({ error: 'category display not found' });
    }
    const result = await req.db.query(
      `DELETE FROM category_display
        WHERE tenant_id = $1 AND category = $2
        RETURNING category`,
      [req.tenant.id, category],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'category display not found' });
    }
    res.json({ ok: true, deleted_category: result.rows[0].category });
  } catch (err) {
    next(err);
  }
}
