// Family management — a member's dependents (migration 034,
// docs/design/FAMILY_ACCOUNTS.md, PR 1 of 3).
//
//   GET    /api/me/dependents        active dependents
//   POST   /api/me/dependents        add (max MAX_DEPENDENTS active)
//   PATCH  /api/me/dependents/:id    edit name / birth year
//   DELETE /api/me/dependents/:id    remove = deactivate; refused while
//                                    the dependent has upcoming bookings
//
// Members only (the household = the member's subscription). Every query
// is scoped by BOTH tenant_id and the caller's member_id — a member can
// never read or touch another household's kids, even by guessing ids.
// Read-only support sessions are refused non-GETs by requireAuth.

import { z } from 'zod';

export const MAX_DEPENDENTS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const thisYear = () => new Date().getUTCFullYear();

const fields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  // Optional; null clears it. Bounded to plausible ages.
  birth_year: z
    .number()
    .int()
    .refine((y) => y >= thisYear() - 100 && y <= thisYear(), 'enter a valid birth year')
    .nullable()
    .optional(),
};
const createSchema = z.object(fields);
const updateSchema = z
  .object({
    first_name: fields.first_name.optional(),
    last_name: fields.last_name.optional(),
    birth_year: fields.birth_year,
  })
  .refine((d) => Object.keys(d).length > 0, 'nothing to update');

const COLUMNS = 'id, first_name, last_name, birth_year, created_at';

function requireMember(req, res) {
  if (!req.user?.member_id) {
    res.status(403).json({ error: 'only members can manage family' });
    return false;
  }
  return true;
}

export async function listDependents(req, res, next) {
  try {
    if (!req.user?.member_id) return res.json({ dependents: [], max: MAX_DEPENDENTS });
    const r = await req.db.query(
      `SELECT ${COLUMNS} FROM dependents
        WHERE tenant_id = $1 AND member_id = $2 AND active
        ORDER BY created_at`,
      [req.tenant.id, req.user.member_id],
    );
    res.json({ dependents: r.rows, max: MAX_DEPENDENTS });
  } catch (err) {
    next(err);
  }
}

export async function createDependent(req, res, next) {
  try {
    if (!requireMember(req, res)) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { db, tenant, user } = req;

    // Lock the household's member row so two concurrent adds can't both
    // pass the cap check.
    await db.query(`SELECT 1 FROM members WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
      tenant.id,
      user.member_id,
    ]);
    const count = await db.query(
      `SELECT count(*)::int AS n FROM dependents
        WHERE tenant_id = $1 AND member_id = $2 AND active`,
      [tenant.id, user.member_id],
    );
    if (count.rows[0].n >= MAX_DEPENDENTS) {
      return res
        .status(409)
        .json({ error: `a household can have up to ${MAX_DEPENDENTS} family members` });
    }

    const { first_name, last_name, birth_year } = parsed.data;
    const r = await db.query(
      `INSERT INTO dependents (tenant_id, member_id, first_name, last_name, birth_year)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [tenant.id, user.member_id, first_name, last_name, birth_year ?? null],
    );
    res.status(201).json({ dependent: r.rows[0] });
  } catch (err) {
    next(err);
  }
}

export async function updateDependent(req, res, next) {
  try {
    if (!requireMember(req, res)) return;
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const d = parsed.data;
    const r = await req.db.query(
      `UPDATE dependents
          SET first_name = COALESCE($1, first_name),
              last_name  = COALESCE($2, last_name),
              birth_year = CASE WHEN $3::boolean THEN $4::integer ELSE birth_year END
        WHERE tenant_id = $5 AND member_id = $6 AND id = $7 AND active
        RETURNING ${COLUMNS}`,
      [
        d.first_name ?? null,
        d.last_name ?? null,
        Object.hasOwn(d, 'birth_year'),
        d.birth_year ?? null,
        req.tenant.id,
        req.user.member_id,
        req.params.id,
      ],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json({ dependent: r.rows[0] });
  } catch (err) {
    next(err);
  }
}

export async function removeDependent(req, res, next) {
  try {
    if (!requireMember(req, res)) return;
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    const { db, tenant, user } = req;

    const dep = await db.query(
      `SELECT id, first_name FROM dependents
        WHERE tenant_id = $1 AND member_id = $2 AND id = $3 AND active
        FOR UPDATE`,
      [tenant.id, user.member_id, req.params.id],
    );
    if (dep.rows.length === 0) return res.status(404).json({ error: 'not found' });

    const upcoming = await db.query(
      `SELECT (
         (SELECT count(*) FROM bookings
           WHERE tenant_id = $1 AND dependent_id = $2
             AND status IN ('confirmed', 'pending_payment') AND start_time > now())
         +
         (SELECT count(*) FROM class_bookings cb
            JOIN class_instances ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
           WHERE cb.tenant_id = $1 AND cb.dependent_id = $2
             AND cb.status IN ('confirmed', 'pending_payment') AND ci.start_time > now())
       )::int AS n`,
      [tenant.id, req.params.id],
    );
    if (upcoming.rows[0].n > 0) {
      return res.status(409).json({
        error: `cancel ${dep.rows[0].first_name}'s upcoming bookings first`,
        code: 'has_upcoming_bookings',
      });
    }

    await db.query(`UPDATE dependents SET active = false WHERE tenant_id = $1 AND id = $2`, [
      tenant.id,
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
