// Class schedules + recurrence generator — Phase 4 slice 2.
//
// Admins create a recurring schedule ("every Tuesday 6pm starting
// 2026-05-12 through 2026-07-21") and the generator materializes
// class_instance rows for the dates within the chosen horizon. The
// schema's UNIQUE INDEX on (tenant_id, class_schedule_id, start_time)
// makes regeneration idempotent.
//
// DST: Postgres `(date + time) AT TIME ZONE tz` resolves the local
// wall-clock instant correctly across spring-forward / fall-back. We
// compute each occurrence per-iteration through SQL, not via JS Date
// math, so DST drift never enters the picture.
//
// Skipped occurrences:
//   * Already-generated dates (unique index hit) → skipped silently,
//     reported in `skipped_count`.
//   * Resource conflict at that slot (e.g. an existing one-off class
//     instance or rental booking) → the GiST exclusion / overlap
//     trigger raises 23P01; we catch per-row and report under
//     `conflicted_count` so the admin knows to resolve manually.
//
// The generator advances `generated_through` to the last date it
// *attempted* (inserted, skipped, or conflicted), so re-running a
// generate call always picks up where it left off and never loops
// over dates that aren't going to change.

import { z } from 'zod';

// ---------- helpers ----------

// Iterate dates in [from, to] inclusive (both YYYY-MM-DD strings),
// yielding { date, dow } pairs where dow matches the schedule.
// Date arithmetic in UTC to dodge DST — these are calendar dates,
// not instants.
function* eachMatchingDay(fromIso, toIso, day_of_week) {
  const fromMs = Date.parse(`${fromIso}T00:00:00Z`);
  const toMs = Date.parse(`${toIso}T00:00:00Z`);
  for (let ms = fromMs; ms <= toMs; ms += 24 * 60 * 60 * 1000) {
    const d = new Date(ms);
    if (d.getUTCDay() === day_of_week) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      yield `${y}-${m}-${dd}`;
    }
  }
}

// Default horizon: 90 days from start_date (or generated_through).
function defaultHorizon(fromIso) {
  const ms = Date.parse(`${fromIso}T00:00:00Z`) + 90 * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function dateAfter(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function dateMin(a, b) {
  return a <= b ? a : b;
}

// Run the generator for a schedule over [from, to] inclusive. Caller
// supplies an open transaction-bound db. Returns counts + the last
// date attempted. Does NOT update class_schedules.generated_through —
// caller does that so it can compose with other writes.
async function runGenerator({ db, tenant, schedule, fromIso, toIso, durationMin, capacity }) {
  let generated = 0;
  let skipped = 0;
  let conflicted = 0;
  let lastAttempted = null;

  for (const dateIso of eachMatchingDay(fromIso, toIso, schedule.day_of_week)) {
    lastAttempted = dateIso;

    // Convert (dateIso + start_time) at tenant tz → UTC instants for
    // both endpoints. Postgres handles DST in a single round-trip.
    const tsRes = await db.query(
      `SELECT
         ($1::date + $2::time)::timestamp AT TIME ZONE $3                           AS start_ts,
         ($1::date + $2::time)::timestamp AT TIME ZONE $3 + ($4 * INTERVAL '1 minute') AS end_ts`,
      [dateIso, schedule.start_time, tenant.timezone, durationMin],
    );
    const { start_ts, end_ts } = tsRes.rows[0];

    try {
      const insertRes = await db.query(
        `INSERT INTO class_instances (
           tenant_id, class_schedule_id, offering_id, resource_id,
           start_time, end_time, capacity
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7
         )
         ON CONFLICT (tenant_id, class_schedule_id, start_time)
           WHERE class_schedule_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          tenant.id,
          schedule.id,
          schedule.offering_id,
          schedule.resource_id,
          start_ts,
          end_ts,
          capacity,
        ],
      );
      if (insertRes.rows.length === 1) {
        generated += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      // GiST exclusion (resource overlap) or cross-table booking
      // overlap trigger raise here. Don't let one conflict kill the
      // whole batch — log and continue. Admin can resolve manually
      // and re-run the generator.
      if (err.code === '23P01') {
        conflicted += 1;
        continue;
      }
      throw err;
    }
  }

  return { generated, skipped, conflicted, lastAttempted };
}

// ---------- POST /api/admin/class-schedules ----------

const createSchema = z.object({
  offering_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'start_time must be HH:MM or HH:MM:SS'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start_date must be YYYY-MM-DD'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'end_date must be YYYY-MM-DD')
    .nullable()
    .optional(),
  // Defaults to start_date + 90 days. Capped at end_date if set.
  generate_through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'generate_through must be YYYY-MM-DD')
    .optional(),
});

export async function createClassSchedule(req, res, next) {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { offering_id, resource_id, day_of_week, start_time, start_date, end_date, generate_through } = parsed.data;
    const { tenant, db } = req;

    // start_date day-of-week must match (schema CHECK also enforces;
    // catching here gives a friendlier error).
    const startDow = new Date(`${start_date}T00:00:00Z`).getUTCDay();
    if (startDow !== day_of_week) {
      return res.status(400).json({
        error: `start_date ${start_date} is day ${startDow} but schedule day_of_week is ${day_of_week}`,
      });
    }
    if (end_date && end_date < start_date) {
      return res.status(400).json({ error: 'end_date must be on or after start_date' });
    }

    // Pull offering for duration + capacity defaults.
    const offerRes = await db.query(
      `SELECT id, duration_minutes, capacity, active
         FROM offerings
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, offering_id],
    );
    if (offerRes.rows.length === 0) {
      return res.status(404).json({ error: 'offering not found' });
    }
    const offering = offerRes.rows[0];
    if (!offering.active) {
      return res.status(409).json({ error: 'offering is inactive' });
    }
    if (offering.capacity === 1) {
      return res.status(409).json({
        error: 'offering is a rental (capacity 1); schedules are for classes only',
      });
    }

    // Determine generation horizon. Default = start_date + 90 days,
    // capped at end_date if set.
    let horizon = generate_through ?? defaultHorizon(start_date);
    if (end_date) horizon = dateMin(horizon, end_date);
    if (horizon < start_date) horizon = start_date;

    // Insert the schedule. Trigger validates link/active state.
    let schedule;
    try {
      const r = await db.query(
        `INSERT INTO class_schedules (
           tenant_id, offering_id, resource_id,
           day_of_week, start_time, start_date, end_date
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7
         )
         RETURNING id, offering_id, resource_id, day_of_week,
                   start_time, start_date, end_date, generated_through,
                   active, created_at`,
        [
          tenant.id,
          offering_id,
          resource_id,
          day_of_week,
          start_time,
          start_date,
          end_date ?? null,
        ],
      );
      schedule = r.rows[0];
    } catch (err) {
      // Trigger / FK error translation.
      if (err.code === '23503' || err.code === '23514' || err.code === '23P01') {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    // Run initial generation [start_date, horizon].
    const result = await runGenerator({
      db,
      tenant,
      schedule,
      fromIso: start_date,
      toIso: horizon,
      durationMin: offering.duration_minutes,
      capacity: offering.capacity,
    });

    if (result.lastAttempted) {
      await db.query(
        `UPDATE class_schedules SET generated_through = $1
          WHERE tenant_id = $2 AND id = $3`,
        [result.lastAttempted, tenant.id, schedule.id],
      );
      schedule.generated_through = result.lastAttempted;
    }

    res.status(201).json({
      class_schedule: schedule,
      generated: result.generated,
      skipped: result.skipped,
      conflicted: result.conflicted,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- GET /api/admin/class-schedules ----------

export async function listClassSchedules(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT cs.id, cs.offering_id, cs.resource_id,
              cs.day_of_week, cs.start_time, cs.start_date,
              cs.end_date, cs.generated_through, cs.active,
              cs.created_at, cs.updated_at,
              o.name AS offering_name,
              r.name AS resource_name,
              COALESCE((
                SELECT count(*) FROM class_instances ci
                 WHERE ci.tenant_id = cs.tenant_id
                   AND ci.class_schedule_id = cs.id
                   AND ci.cancelled_at IS NULL
              ), 0)::integer AS active_instance_count
         FROM class_schedules cs
         JOIN offerings o ON o.tenant_id = cs.tenant_id AND o.id = cs.offering_id
         JOIN resources r ON r.tenant_id = cs.tenant_id AND r.id = cs.resource_id
        WHERE cs.tenant_id = $1
        ORDER BY cs.created_at DESC`,
      [req.tenant.id],
    );
    res.json({ class_schedules: result.rows });
  } catch (err) {
    next(err);
  }
}

// ---------- POST /api/admin/class-schedules/:id/generate ----------
//
// Extends generation through a new horizon. Body: { through: 'YYYY-MM-DD' }.
// Default horizon = generated_through + 90 days (or start_date + 90
// days if never generated). Capped at end_date.

const generateSchema = z.object({
  through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'through must be YYYY-MM-DD')
    .optional(),
});

export async function generateClassSchedule(req, res, next) {
  try {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { through } = parsed.data;
    const { tenant, db } = req;
    const id = req.params.id;

    const schedRes = await db.query(
      `SELECT id, offering_id, resource_id, day_of_week, start_time,
              start_date, end_date, generated_through, active
         FROM class_schedules
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    );
    if (schedRes.rows.length === 0) {
      return res.status(404).json({ error: 'class schedule not found' });
    }
    const schedule = schedRes.rows[0];
    if (!schedule.active) {
      return res
        .status(409)
        .json({ error: 'class schedule is inactive; reactivate before generating' });
    }

    // Pull offering for duration + capacity (snapshot of "now").
    const offerRes = await db.query(
      `SELECT duration_minutes, capacity, active
         FROM offerings
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, schedule.offering_id],
    );
    const offering = offerRes.rows[0];
    if (!offering || !offering.active) {
      return res
        .status(409)
        .json({ error: 'offering is inactive; cannot generate' });
    }

    // Resume from the day after generated_through, or from start_date
    // if nothing's been generated yet.
    const fromIso = schedule.generated_through
      ? dateAfter(toIsoDate(schedule.generated_through))
      : toIsoDate(schedule.start_date);

    // Default horizon = fromIso + 90 days, capped at end_date.
    let toIso = through ?? defaultHorizon(fromIso);
    if (schedule.end_date) toIso = dateMin(toIso, toIsoDate(schedule.end_date));

    if (toIso < fromIso) {
      // Already generated through end_date or beyond. No-op.
      return res.json({
        class_schedule_id: id,
        generated: 0,
        skipped: 0,
        conflicted: 0,
        generated_through: schedule.generated_through,
        note: 'nothing to generate; horizon at or before existing generated_through',
      });
    }

    const result = await runGenerator({
      db,
      tenant,
      schedule,
      fromIso,
      toIso,
      durationMin: offering.duration_minutes,
      capacity: offering.capacity,
    });

    let newGeneratedThrough = schedule.generated_through
      ? toIsoDate(schedule.generated_through)
      : null;
    if (result.lastAttempted) {
      newGeneratedThrough = result.lastAttempted;
      await db.query(
        `UPDATE class_schedules SET generated_through = $1
          WHERE tenant_id = $2 AND id = $3`,
        [result.lastAttempted, tenant.id, id],
      );
    }

    res.json({
      class_schedule_id: id,
      generated: result.generated,
      skipped: result.skipped,
      conflicted: result.conflicted,
      generated_through: newGeneratedThrough,
    });
  } catch (err) {
    next(err);
  }
}

// pg returns date columns as Date objects (UTC midnight). Coerce to
// YYYY-MM-DD string for the generator's date math.
function toIsoDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  throw new Error(`expected date or string, got ${typeof d}`);
}
