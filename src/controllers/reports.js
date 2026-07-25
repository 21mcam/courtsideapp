// Admin reports + CSV exports (Tier-A sell-readiness slice).
//
// Endpoints (all mounted under /api/admin, so requireAuth →
// requireAdmin → withTenantContext already ran; every query goes
// through req.db with the tenant GUC set):
//
//   GET /reports/summary       — dashboard numbers
//   GET /reports/members.csv   — full member roster export
//   GET /reports/bookings.csv  — booking export, ?from=&to= (YYYY-MM-DD,
//                                tenant-local dates; default last 90 days)
//
// Week/month boundaries are computed in the TENANT's timezone
// (CLAUDE.md gotcha #6) via the pure tz helpers in src/lib/tz.js —
// the backend's copy of the same DST-safe functions the frontend uses
// (client/src/lib/tz.js), kept in sync by tests/tz.test.js. The
// product's week convention is Monday 00:00 tenant-local (matching
// run_weekly_credit_resets(), migration 022).
//
// ---------------------------------------------------------------
// REVENUE METHOD (read before trusting the number)
// ---------------------------------------------------------------
// revenueThisMonthCents is an HONEST sum of only the money we
// actually record in our own database, attributed to the current
// tenant-local calendar month:
//
//   walkIns — SUM(amount_paid_cents - amount_refunded_cents) over
//     bookings + class_bookings rows with amount_paid_cents > 0,
//     attributed by the row's created_at (we do not store a separate
//     "paid at" timestamp; the Stripe webhook stamps amount_paid on
//     the row created moments earlier at checkout, so creation month
//     ≈ payment month). Cash-on-arrival front-desk bookings are NOT
//     included: nothing ever marks them paid (payment_status stays
//     'pending'), so counting their amount_due would be inventing
//     revenue.
//
//   packs — NULL (not tracked). Pack purchases move money on Stripe
//     and grant credits via the ledger, but the dollar amount is
//     never persisted on our side (only in the receipt email).
//
//   subscriptions — NULL (not tracked). invoice.payment_succeeded
//     reconciles period bounds but we do not record invoice amounts.
//
// The breakdown object returns NULL (not 0) for untracked streams so
// the UI can say "not tracked" instead of lying with a zero. When a
// later slice records pack/invoice amounts, flip the stream from
// NULL to a real sum here and the UI picks it up.
// ---------------------------------------------------------------

import { z } from 'zod';

import { addDays, localDateString, zonedTimeToUtc } from '../lib/tz.js';

// Non-terminal subscription statuses (glossary: everything except
// 'cancelled'). Mirrors subscriptions_one_active_per_member.
const NON_TERMINAL = ['pending', 'active', 'past_due', 'incomplete'];

// ---------------------------------------------------------------
// Tenant-timezone boundary math (exported for tests)
// ---------------------------------------------------------------

// Monday-00:00-tenant-local week boundaries around `now`.
// Returns UTC instants: [lastWeekStart, thisWeekStart) is last week,
// [thisWeekStart, nextWeekStart) is this week.
export function tenantWeekBoundaries(tz, now = new Date()) {
  const todayStr = localDateString(now, tz);
  // Day-of-week of the tenant-local calendar date. Pure calendar
  // math on the date string — timezone already applied above.
  const dow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0 = Sun
  const daysSinceMonday = (dow + 6) % 7;
  const thisWeekStartStr = addDays(todayStr, -daysSinceMonday);
  return {
    lastWeekStart: zonedTimeToUtc(addDays(thisWeekStartStr, -7), '00:00', tz),
    thisWeekStart: zonedTimeToUtc(thisWeekStartStr, '00:00', tz),
    nextWeekStart: zonedTimeToUtc(addDays(thisWeekStartStr, 7), '00:00', tz),
  };
}

// First-of-the-month 00:00 tenant-local, as a UTC instant.
export function tenantMonthStart(tz, now = new Date()) {
  const todayStr = localDateString(now, tz);
  return zonedTimeToUtc(`${todayStr.slice(0, 8)}01`, '00:00', tz);
}

// "YYYY-MM-DD HH:MM" wall-clock rendering of an instant in `tz`.
// Unambiguous and spreadsheet-sortable, unlike locale date formats.
function localDateTimeString(value, tz) {
  const d = new Date(value);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${localDateString(d, tz)} ${time}`;
}

// ---------------------------------------------------------------
// GET /api/admin/reports/summary
// ---------------------------------------------------------------

export async function getReportsSummary(req, res, next) {
  try {
    const { tenant, db } = req;
    const tz = tenant.timezone;
    const { lastWeekStart, thisWeekStart, nextWeekStart } =
      tenantWeekBoundaries(tz);
    const monthStart = tenantMonthStart(tz);

    // Members with a non-terminal subscription. DISTINCT is belt and
    // braces — the partial unique index already allows at most one
    // non-terminal subscription per member.
    const activeMembersRes = await db.query(
      `SELECT count(DISTINCT member_id)::int AS n
         FROM subscriptions
        WHERE tenant_id = $1
          AND status = ANY($2::text[])`,
      [tenant.id, NON_TERMINAL],
    );

    // Booking counts. Rental bookings only (the bookings table);
    // class rosters live on class_bookings and are not counted here.
    // Cancelled bookings are excluded — they didn't/won't happen.
    const bookingCountsRes = await db.query(
      `SELECT
         count(*) FILTER (WHERE start_time >= $2 AND start_time < $3)::int
           AS this_week,
         count(*) FILTER (WHERE start_time >= $4 AND start_time < $2)::int
           AS last_week,
         count(*) FILTER (
           WHERE start_time >= now() AND start_time < now() + interval '7 days'
         )::int AS upcoming
         FROM bookings
        WHERE tenant_id = $1
          AND status <> 'cancelled'`,
      [tenant.id, thisWeekStart, nextWeekStart, lastWeekStart],
    );

    // Outstanding credits across all members — the tenant's "credit
    // liability". The singleton balance table makes this a single sum
    // (invariant: balances always match the ledger's latest
    // balance_after, enforced by apply_credit_change).
    const liabilityRes = await db.query(
      `SELECT COALESCE(sum(current_credits), 0)::int AS n
         FROM credit_balances
        WHERE tenant_id = $1`,
      [tenant.id],
    );

    // Walk-in revenue — see REVENUE METHOD in the header comment.
    const walkInRes = await db.query(
      `SELECT
         COALESCE((SELECT sum(amount_paid_cents - amount_refunded_cents)
                     FROM bookings
                    WHERE tenant_id = $1
                      AND amount_paid_cents > 0
                      AND created_at >= $2), 0)::int
       + COALESCE((SELECT sum(amount_paid_cents - amount_refunded_cents)
                     FROM class_bookings
                    WHERE tenant_id = $1
                      AND amount_paid_cents > 0
                      AND created_at >= $2), 0)::int AS walk_ins`,
      [tenant.id, monthStart],
    );

    const counts = bookingCountsRes.rows[0];
    const walkIns = walkInRes.rows[0].walk_ins;

    res.json({
      activeMembers: activeMembersRes.rows[0].n,
      bookingsThisWeek: counts.this_week,
      bookingsLastWeek: counts.last_week,
      upcomingBookings7d: counts.upcoming,
      creditLiability: liabilityRes.rows[0].n,
      // Sum of the streams we actually track (currently walk-ins
      // only). NULL streams are excluded, not treated as zero — the
      // number is "at least this much", which the UI spells out.
      revenueThisMonthCents: walkIns,
      revenueBreakdown: {
        walkIns,
        packs: null, // dollar amounts not persisted (see header)
        subscriptions: null, // invoice amounts not persisted (see header)
      },
      boundaries: {
        timezone: tz,
        lastWeekStart: lastWeekStart.toISOString(),
        thisWeekStart: thisWeekStart.toISOString(),
        monthStart: monthStart.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------
// CSV encoding
// ---------------------------------------------------------------

// One CSV cell. Every field is quoted (embedded quotes doubled), and
// cells starting with =, +, -, @, tab, or CR additionally get a
// leading apostrophe so spreadsheet apps treat them as text instead
// of executing them as formulas (CSV/formula injection).
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

// Buffered CSV document: header row + data rows, CRLF line endings
// (RFC 4180). Small tenants — buffering the whole document is fine.
export function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

function sendCsv(res, filenameBase, tz, csv) {
  const stamp = localDateString(new Date(), tz);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filenameBase}-${stamp}.csv"`,
  );
  res.send(csv);
}

// ---------------------------------------------------------------
// GET /api/admin/reports/members.csv
// ---------------------------------------------------------------

export async function exportMembersCsv(req, res, next) {
  try {
    const { tenant, db } = req;
    const tz = tenant.timezone;

    // One row per member: profile + credit balance + their current
    // non-terminal subscription (at most one, partial unique index)
    // joined with its active plan period for the plan name.
    const result = await db.query(
      `SELECT m.first_name, m.last_name, m.email, m.phone, m.created_at,
              COALESCE(cb.current_credits, 0) AS current_credits,
              s.status AS subscription_status,
              p.name AS plan_name
         FROM members m
    LEFT JOIN credit_balances cb
           ON cb.tenant_id = m.tenant_id AND cb.member_id = m.id
    LEFT JOIN LATERAL (
           SELECT sub.id, sub.status
             FROM subscriptions sub
            WHERE sub.tenant_id = m.tenant_id
              AND sub.member_id = m.id
              AND sub.status = ANY($2::text[])
            ORDER BY sub.created_at DESC
            LIMIT 1
         ) s ON true
    LEFT JOIN subscription_plan_periods spp
           ON spp.tenant_id = m.tenant_id
          AND spp.subscription_id = s.id
          AND spp.ended_at IS NULL
    LEFT JOIN plans p
           ON p.tenant_id = m.tenant_id AND p.id = spp.plan_id
        WHERE m.tenant_id = $1
        ORDER BY m.created_at ASC`,
      [tenant.id, NON_TERMINAL],
    );

    const header = [
      'first_name',
      'last_name',
      'email',
      'phone',
      'credits',
      'subscription_status',
      'plan',
      'joined_at',
    ];
    const rows = result.rows.map((m) => [
      m.first_name,
      m.last_name,
      m.email,
      m.phone,
      m.current_credits,
      m.subscription_status ?? 'none',
      m.plan_name,
      localDateString(m.created_at, tz),
    ]);

    sendCsv(res, 'members', tz, toCsv(header, rows));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------
// GET /api/admin/reports/bookings.csv?from=&to=
// ---------------------------------------------------------------

// from/to are tenant-local calendar dates (YYYY-MM-DD), both
// inclusive; the window is [from 00:00, to+1day 00:00) tenant time
// on start_time. Default: the last 90 days ending today.
const bookingsCsvQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')
    .optional(),
});

// Buffered export cap. A busy single-resource facility books ~500
// slots/month, so 20k rows covers 90 days for even large multi-
// resource tenants; beyond that, narrow the date range. Exceeding the
// cap is a 400 (never a silently truncated file — an admin would
// reconcile revenue against incomplete data without knowing it).
const BOOKINGS_CSV_MAX_ROWS = 20000;

export async function exportBookingsCsv(req, res, next) {
  try {
    const parsed = bookingsCsvQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid query', details: parsed.error.flatten() });
    }
    const { tenant, db } = req;
    const tz = tenant.timezone;

    const today = localDateString(new Date(), tz);
    const to = parsed.data.to ?? today;
    const from = parsed.data.from ?? addDays(to, -90);
    // ISO date strings compare lexicographically.
    if (from > to) {
      return res.status(400).json({ error: 'from must not be after to' });
    }

    const fromTs = zonedTimeToUtc(from, '00:00', tz);
    const toTs = zonedTimeToUtc(addDays(to, 1), '00:00', tz); // inclusive `to`

    const result = await db.query(
      `SELECT b.id, b.status, b.start_time, b.end_time, b.created_at,
              b.credit_cost_charged, b.amount_due_cents,
              b.amount_paid_cents, b.amount_refunded_cents,
              b.payment_status,
              o.name AS offering_name,
              r.name AS resource_name,
              m.first_name AS member_first_name,
              m.last_name  AS member_last_name,
              m.email      AS member_email,
              b.customer_first_name, b.customer_last_name,
              b.customer_email, b.member_id
         FROM bookings b
         JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
         JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
    LEFT JOIN members   m ON m.tenant_id = b.tenant_id AND m.id = b.member_id
        WHERE b.tenant_id = $1
          AND b.start_time >= $2
          AND b.start_time <  $3
        ORDER BY b.start_time ASC
        LIMIT ${BOOKINGS_CSV_MAX_ROWS + 1}`,
      [tenant.id, fromTs, toTs],
    );

    // LIMIT cap+1 detects overflow: refuse rather than silently
    // truncate (see BOOKINGS_CSV_MAX_ROWS comment).
    if (result.rows.length > BOOKINGS_CSV_MAX_ROWS) {
      return res.status(400).json({
        error: `export exceeds ${BOOKINGS_CSV_MAX_ROWS} rows; narrow the from/to date range`,
        max_rows: BOOKINGS_CSV_MAX_ROWS,
      });
    }

    const header = [
      'booking_id',
      'start_time_local',
      'end_time_local',
      'status',
      'offering',
      'resource',
      'booked_by',
      'first_name',
      'last_name',
      'email',
      'credit_cost_charged',
      'amount_due_cents',
      'amount_paid_cents',
      'amount_refunded_cents',
      'payment_status',
      'start_time_utc',
      'created_at_utc',
    ];
    const rows = result.rows.map((b) => {
      const isMember = b.member_id != null;
      return [
        b.id,
        localDateTimeString(b.start_time, tz),
        localDateTimeString(b.end_time, tz),
        b.status,
        b.offering_name,
        b.resource_name,
        isMember ? 'member' : 'walk-in',
        isMember ? b.member_first_name : b.customer_first_name,
        isMember ? b.member_last_name : b.customer_last_name,
        isMember ? b.member_email : b.customer_email,
        b.credit_cost_charged,
        b.amount_due_cents,
        b.amount_paid_cents,
        b.amount_refunded_cents,
        b.payment_status,
        new Date(b.start_time).toISOString(),
        new Date(b.created_at).toISOString(),
      ];
    });

    sendCsv(res, 'bookings', tz, toCsv(header, rows));
  } catch (err) {
    next(err);
  }
}
