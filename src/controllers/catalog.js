// Admin catalog CRUD — Phase 2, slice 2.
//
// Resources, offerings, and the offering↔resource link table. All
// endpoints sit under /api/admin/* and require the admin role
// (gated by requireAdmin in the routes file).
//
// This slice is create + list. Update and deactivate land in a
// follow-up slice once the admin UI demands them. Schema-level
// soft-delete (active = false) is the model — bookings reference
// these rows so we never DELETE.

import { z } from 'zod';

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

// ============================================================
// offerings
// ============================================================

// Mirrors schema.sql's category_key domain regex. Reserved names
// aren't enforced here; the schema doesn't reserve any (only tenants
// has a reserved-subdomain CHECK).
const CATEGORY_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const offeringCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().regex(CATEGORY_REGEX, 'category must be lowercase, hyphenated, alphanumeric'),
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
      `SELECT id, name, category, duration_minutes, credit_cost, dollar_price,
              capacity, allow_member_booking, allow_public_booking, active,
              display_order, created_at, updated_at
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
           tenant_id, name, category, duration_minutes, credit_cost,
           dollar_price, capacity, allow_member_booking, allow_public_booking,
           display_order
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, name, category, duration_minutes, credit_cost,
                   dollar_price, capacity, allow_member_booking,
                   allow_public_booking, active, display_order,
                   created_at, updated_at`,
        [
          req.tenant.id,
          d.name,
          d.category,
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
      `SELECT id, name, description, monthly_price_cents, credits_per_week,
              allowed_categories, stripe_price_id, active, display_order,
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
                   credits_per_week, allowed_categories, stripe_price_id,
                   active, display_order, created_at, updated_at`,
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
