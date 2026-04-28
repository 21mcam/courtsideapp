// Admin endpoints for operating_hours and booking_policies.
//
// These two tables are catalog-adjacent: the wizard doesn't touch
// them yet, but Phase 3's availability engine + cancel flow does.
// Phase 3 prep slice ships the API; the wizard / admin UI integration
// follows when Phase 3's booking surface needs it.
//
// operating_hours is per-resource, per-day-of-week, open→close in
// LOCAL time (DST-stable). Multi-row per (resource, day) allowed —
// schema's exclusion constraint enforces non-overlap. We don't
// expose PATCH; admins delete + re-create to edit.
//
// booking_policies is singleton-per-tenant. For tenants created via
// create_tenant_with_owner (migration 012), the row exists with
// schema defaults. For older tenants (e.g. Momentum), no row may
// exist — GET returns schema defaults; PUT UPSERTs.

import { z } from 'zod';

// ============================================================
// operating_hours
// ============================================================

// HH:MM or HH:MM:SS (24-hour). Postgres `time` accepts both.
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const operatingHoursCreateSchema = z
  .object({
    resource_id: z.string().uuid(),
    day_of_week: z.number().int().min(0).max(6),
    open_time: z.string().regex(TIME_REGEX, 'open_time must be HH:MM or HH:MM:SS'),
    close_time: z.string().regex(TIME_REGEX, 'close_time must be HH:MM or HH:MM:SS'),
  })
  .refine((d) => d.close_time > d.open_time, {
    message: 'close_time must be after open_time',
  });

export async function listOperatingHours(req, res, next) {
  try {
    // Optional ?resource_id=... filter so the admin UI can scope.
    const resourceId = req.query.resource_id;
    let result;
    if (resourceId) {
      result = await req.db.query(
        `SELECT id, resource_id, day_of_week, open_time, close_time,
                created_at, updated_at
           FROM operating_hours
          WHERE tenant_id = $1 AND resource_id = $2
          ORDER BY day_of_week ASC, open_time ASC`,
        [req.tenant.id, resourceId],
      );
    } else {
      result = await req.db.query(
        `SELECT id, resource_id, day_of_week, open_time, close_time,
                created_at, updated_at
           FROM operating_hours
          WHERE tenant_id = $1
          ORDER BY resource_id ASC, day_of_week ASC, open_time ASC`,
        [req.tenant.id],
      );
    }
    res.json({ operating_hours: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function createOperatingHours(req, res, next) {
  try {
    const parsed = operatingHoursCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { resource_id, day_of_week, open_time, close_time } = parsed.data;

    try {
      const result = await req.db.query(
        `INSERT INTO operating_hours
           (tenant_id, resource_id, day_of_week, open_time, close_time)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, resource_id, day_of_week, open_time, close_time,
                   created_at, updated_at`,
        [req.tenant.id, resource_id, day_of_week, open_time, close_time],
      );
      res.status(201).json({ operating_hours: result.rows[0] });
    } catch (err) {
      if (err.code === '23P01') {
        // exclusion_violation — overlapping hours for this
        // (resource, day). The schema's GiST exclusion catches it.
        return res
          .status(409)
          .json({ error: 'overlapping hours for this resource on this day' });
      }
      if (err.code === '23503') {
        // FK violation — composite (tenant_id, resource_id) doesn't
        // resolve to a resource in this tenant.
        return res
          .status(400)
          .json({ error: 'resource not found in this tenant' });
      }
      if (err.code === '23514') {
        return res
          .status(400)
          .json({ error: 'invalid hours: schema CHECK failed' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

export async function deleteOperatingHours(req, res, next) {
  try {
    const id = req.params.id;
    const result = await req.db.query(
      `DELETE FROM operating_hours
        WHERE tenant_id = $1 AND id = $2
        RETURNING id`,
      [req.tenant.id, id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'operating_hours row not found' });
    }
    res.json({ ok: true, deleted_id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// booking_policies (singleton per tenant)
// ============================================================

// Defaults match the schema's column DEFAULTs / CHECKs. GET returns
// these when no row exists yet (older tenants).
const POLICY_DEFAULTS = {
  free_cancel_hours_before: 24,
  partial_refund_hours_before: null,
  partial_refund_percent: null,
  no_show_action: 'none',
  no_show_fee_cents: null,
  min_advance_booking_minutes: 0,
  max_advance_booking_days: 30,
  allow_member_self_cancel: true,
  allow_customer_self_cancel: true,
};

const bookingPoliciesUpsertSchema = z
  .object({
    free_cancel_hours_before: z.number().int().nonnegative().optional(),
    partial_refund_hours_before: z.number().int().nonnegative().nullable().optional(),
    partial_refund_percent: z.number().int().min(0).max(100).nullable().optional(),
    no_show_action: z
      .enum(['none', 'forfeit_credits', 'charge_fee', 'block_member'])
      .optional(),
    no_show_fee_cents: z.number().int().nonnegative().nullable().optional(),
    min_advance_booking_minutes: z.number().int().nonnegative().optional(),
    max_advance_booking_days: z.number().int().positive().optional(),
    allow_member_self_cancel: z.boolean().optional(),
    allow_customer_self_cancel: z.boolean().optional(),
  });

export async function getBookingPolicies(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT free_cancel_hours_before, partial_refund_hours_before,
              partial_refund_percent, no_show_action, no_show_fee_cents,
              min_advance_booking_minutes, max_advance_booking_days,
              allow_member_self_cancel, allow_customer_self_cancel,
              created_at, updated_at
         FROM booking_policies
        WHERE tenant_id = $1`,
      [req.tenant.id],
    );
    if (result.rows.length === 0) {
      // Older tenants (pre-migration-012) may not have a row. Return
      // schema defaults so the admin UI has something to render.
      return res.json({ booking_policies: { ...POLICY_DEFAULTS, exists: false } });
    }
    res.json({ booking_policies: { ...result.rows[0], exists: true } });
  } catch (err) {
    next(err);
  }
}

export async function upsertBookingPolicies(req, res, next) {
  try {
    const parsed = bookingPoliciesUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = { ...POLICY_DEFAULTS, ...parsed.data };

    try {
      const result = await req.db.query(
        `INSERT INTO booking_policies (
           tenant_id, free_cancel_hours_before, partial_refund_hours_before,
           partial_refund_percent, no_show_action, no_show_fee_cents,
           min_advance_booking_minutes, max_advance_booking_days,
           allow_member_self_cancel, allow_customer_self_cancel
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           free_cancel_hours_before    = EXCLUDED.free_cancel_hours_before,
           partial_refund_hours_before = EXCLUDED.partial_refund_hours_before,
           partial_refund_percent      = EXCLUDED.partial_refund_percent,
           no_show_action              = EXCLUDED.no_show_action,
           no_show_fee_cents           = EXCLUDED.no_show_fee_cents,
           min_advance_booking_minutes = EXCLUDED.min_advance_booking_minutes,
           max_advance_booking_days    = EXCLUDED.max_advance_booking_days,
           allow_member_self_cancel    = EXCLUDED.allow_member_self_cancel,
           allow_customer_self_cancel  = EXCLUDED.allow_customer_self_cancel
         RETURNING free_cancel_hours_before, partial_refund_hours_before,
                   partial_refund_percent, no_show_action, no_show_fee_cents,
                   min_advance_booking_minutes, max_advance_booking_days,
                   allow_member_self_cancel, allow_customer_self_cancel,
                   created_at, updated_at`,
        [
          req.tenant.id,
          d.free_cancel_hours_before,
          d.partial_refund_hours_before,
          d.partial_refund_percent,
          d.no_show_action,
          d.no_show_fee_cents,
          d.min_advance_booking_minutes,
          d.max_advance_booking_days,
          d.allow_member_self_cancel,
          d.allow_customer_self_cancel,
        ],
      );
      res.json({ booking_policies: { ...result.rows[0], exists: true } });
    } catch (err) {
      if (err.code === '23514') {
        return res.status(400).json({
          error:
            'invalid policy: failed schema CHECK (e.g. partial-refund half-set, charge_fee without fee, advance-window inconsistent)',
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}
