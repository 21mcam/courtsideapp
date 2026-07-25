// Reports + CSV export endpoints (Tier-A sell-readiness slice).
//
// Covers:
//   1. Summary math against seeded data, with the tenant-timezone
//      week edge pinned: a booking late Sunday night tenant-local
//      (already Monday in UTC) must count in LAST week, which a
//      UTC-week implementation would get wrong.
//   2. Honest revenue: walk-in payments summed net of refunds for the
//      current tenant-local month; packs/subscriptions are null
//      ("not tracked"), never zero-pretending.
//   3. Credit liability from the ledger-backed balances.
//   4. CSV escaping incl. the formula-injection prefix, quoting, and
//      Content-Disposition attachment headers.
//   5. bookings.csv ?from=&to= filtering + validation.
//   6. Tenant isolation: a second tenant's members/bookings/credits
//      never bleed into the first tenant's numbers or exports.
//   7. Auth: 401 without a token, 403 for member tokens.
//
// Self-contained: throwaway tenants + fixtures via the privileged
// pool, dropped on teardown.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';
import {
  csvCell,
  tenantWeekBoundaries,
  tenantMonthStart,
} from '../src/controllers/reports.js';
import { localDateString } from '../client/src/lib/tz.js';

const TENANT_A = 'verify-reports';
const TENANT_B = 'verify-reports-b';
const TZ = 'America/New_York';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED is required to set up reports fixtures';

let server;
let baseUrl;
let privilegedPool;
let tenantAId;
let tenantBId;
let adminTokenA;
let adminTokenB;
let memberToken;
let memberAEmail;
let memberBEmail;
let sundayBookingId;
let sundayLocalDate;
let futureBookingId;
// Computed at setup: is the now+2d booking still inside "this week"?
let futureIsThisWeek;

async function makeAdmin(tenantId, subdomain) {
  const email = `admin-${randomUUID()}@example.com`;
  const hash = await bcrypt.hash('correcthorsebatterystaple', 10);
  const user = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenantId, email, hash],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenantId, user.rows[0].id],
  );
  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${subdomain}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correcthorsebatterystaple' }),
  });
  return (await login.json()).token;
}

// Resource + offering + link; returns ids. Offering allows both
// audiences so both member and customer bookings can be inserted.
async function makeCatalog(tenantId, resourceName, offeringName) {
  const resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, resourceName],
    )
  ).rows[0].id;
  const offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, $2, 'cage-time', 60, 1, 3000, true, true)
       RETURNING id`,
      [tenantId, offeringName],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenantId, offering_id, resource_id],
  );
  return { resource_id, offering_id };
}

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;

  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `DELETE FROM tenants WHERE subdomain = ANY($1::text[])`,
    [[TENANT_A, TENANT_B]],
  );
  tenantAId = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Reports Tests', $2) RETURNING id`,
      [TENANT_A, TZ],
    )
  ).rows[0].id;
  tenantBId = (
    await privilegedPool.query(
      `INSERT INTO tenants (subdomain, name, timezone)
       VALUES ($1, 'Reports Isolation Tests', $2) RETURNING id`,
      [TENANT_B, TZ],
    )
  ).rows[0].id;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  adminTokenA = await makeAdmin(tenantAId, TENANT_A);
  adminTokenB = await makeAdmin(tenantBId, TENANT_B);

  // ---- Tenant A people ----

  // member1: registered (member token for 403 tests), active
  // subscription on a plan, +7 credits via the ledger.
  memberAEmail = `member-${randomUUID()}@example.com`;
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT_A}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: memberAEmail,
        password: 'password123',
        first_name: 'Reports',
        last_name: 'Member',
      }),
    },
  );
  assert.equal(reg.status, 201);
  const regBody = await reg.json();
  memberToken = regBody.token;
  const member1Id = regBody.member_id;

  const planId = (
    await privilegedPool.query(
      `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
       VALUES ($1, 'Reports Pro', 26900, 20) RETURNING id`,
      [tenantAId],
    )
  ).rows[0].id;
  const subId = (
    await privilegedPool.query(
      `INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
       VALUES ($1, $2, 'active', now()) RETURNING id`,
      [tenantAId, member1Id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id)
     VALUES ($1, $2, $3)`,
    [tenantAId, subId, planId],
  );

  for (const amount of [5, -2, 4]) {
    const res = await adminFetchA(
      `/api/admin/members/${member1Id}/credit-adjustments`,
      { method: 'POST', body: JSON.stringify({ amount, note: 'seed' }) },
    );
    assert.equal(res.status, 201);
  }

  // member2: formula-injection name (CSV escaping test).
  const m2 = await adminFetchA('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      email: `formula-${randomUUID()}@example.com`,
      first_name: '=SUM(A1:A9)',
      last_name: 'Cell',
    }),
  });
  assert.equal(m2.status, 201);

  // member3: quotes + comma in the name (CSV quoting test).
  const m3 = await adminFetchA('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      email: `quotes-${randomUUID()}@example.com`,
      first_name: 'Comma',
      last_name: `O'Brien, "The" Bat`,
    }),
  });
  assert.equal(m3.status, 201);
  const member3Id = (await m3.json()).member.id;

  // member3 also has a CANCELLED subscription — terminal, so they
  // must NOT count toward activeMembers.
  await privilegedPool.query(
    `INSERT INTO subscriptions (tenant_id, member_id, status, ended_at)
     VALUES ($1, $2, 'cancelled', now())`,
    [tenantAId, member3Id],
  );

  // ---- Tenant A bookings ----

  const { resource_id, offering_id } = await makeCatalog(
    tenantAId,
    'Report Cage',
    'report-cage-60',
  );

  const now = new Date();
  const { thisWeekStart, nextWeekStart } = tenantWeekBoundaries(TZ, now);
  const monthStart = tenantMonthStart(TZ, now);
  const MIN = 60 * 1000;

  async function insertMemberBooking(start, end, status, extra = {}) {
    return (
      await privilegedPool.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id, member_id,
           start_time, end_time, status,
           amount_due_cents, credit_cost_charged, payment_status,
           cancelled_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 1, 'not_required', $8)
         RETURNING id`,
        [
          tenantAId,
          offering_id,
          resource_id,
          member1Id,
          start,
          end,
          status,
          extra.cancelled_at ?? null,
        ],
      )
    ).rows[0].id;
  }

  // THE WEEK-EDGE FIXTURE: 30 min before Monday 00:00 tenant-local,
  // i.e. Sunday 23:30 in New York — which is already Monday morning
  // in UTC. Must count as LAST week.
  const sundayStart = new Date(thisWeekStart.getTime() - 30 * MIN);
  sundayLocalDate = localDateString(sundayStart, TZ);
  sundayBookingId = await insertMemberBooking(
    sundayStart,
    new Date(sundayStart.getTime() + 5 * MIN),
    'confirmed',
  );

  // A booking safely inside this week and in the past: midpoint of
  // [thisWeekStart, now] — never collides with `now` however close
  // to the week boundary the test runs.
  const midweekStart = new Date((thisWeekStart.getTime() + now.getTime()) / 2);
  await insertMemberBooking(
    midweekStart,
    new Date(midweekStart.getTime() + 5 * MIN),
    'confirmed',
  );

  // Upcoming booking (now + 2 days). Whether it falls in "this week"
  // depends on the day the suite runs — compute the expectation.
  const futureStart = new Date(now.getTime() + 2 * 24 * 60 * MIN);
  futureIsThisWeek = futureStart < nextWeekStart;
  futureBookingId = await insertMemberBooking(
    futureStart,
    new Date(futureStart.getTime() + 60 * MIN),
    'confirmed',
  );

  // Cancelled booking tomorrow — excluded from every count.
  const cancelledStart = new Date(now.getTime() + 24 * 60 * MIN);
  await insertMemberBooking(
    cancelledStart,
    new Date(cancelledStart.getTime() + 60 * MIN),
    'cancelled',
    { cancelled_at: now },
  );

  // ---- Tenant A revenue fixtures (walk-ins, two weeks back so they
  // stay clear of the week-count windows; created_at controls the
  // month attribution) ----

  async function insertWalkIn({
    startOffsetMin,
    due,
    paid,
    refunded,
    payment_status,
    created_at,
    first_name,
  }) {
    const start = new Date(
      thisWeekStart.getTime() - 14 * 24 * 60 * MIN + startOffsetMin * MIN,
    );
    return (
      await privilegedPool.query(
        `INSERT INTO bookings (
           tenant_id, offering_id, resource_id,
           customer_first_name, customer_last_name, customer_email,
           start_time, end_time, status,
           amount_due_cents, amount_paid_cents, amount_refunded_cents,
           payment_status, created_at
         ) VALUES ($1, $2, $3, $4, 'Walkin', $5, $6, $7, 'completed',
                   $8, $9, $10, $11, COALESCE($12, now()))
         RETURNING id`,
        [
          tenantAId,
          offering_id,
          resource_id,
          first_name,
          `walkin-${randomUUID()}@example.com`,
          start,
          new Date(start.getTime() + 30 * MIN),
          due,
          paid,
          refunded,
          payment_status,
          created_at ?? null,
        ],
      )
    ).rows[0].id;
  }

  // Paid this month: +3000. Customer name doubles as the CSV
  // formula-injection fixture on the bookings export.
  await insertWalkIn({
    startOffsetMin: 0,
    due: 3000,
    paid: 3000,
    refunded: 0,
    payment_status: 'paid',
    first_name: '=2+5',
  });
  // Partially refunded this month: +5000 -2000 = +3000.
  await insertWalkIn({
    startOffsetMin: 120,
    due: 5000,
    paid: 5000,
    refunded: 2000,
    payment_status: 'partial_refund',
    first_name: 'Partial',
  });
  // Paid LAST month (created_at backdated) — excluded from revenue.
  await insertWalkIn({
    startOffsetMin: 240,
    due: 9900,
    paid: 9900,
    refunded: 0,
    payment_status: 'paid',
    created_at: new Date(monthStart.getTime() - 2 * 24 * 60 * MIN),
    first_name: 'LastMonth',
  });

  // ---- Tenant B (isolation): own member, subscription, credits,
  // and a paid walk-in this month ----

  memberBEmail = `member-b-${randomUUID()}@example.com`;
  const regB = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT_B}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: memberBEmail,
        password: 'password123',
        first_name: 'Isolated',
        last_name: 'Member',
      }),
    },
  );
  assert.equal(regB.status, 201);
  const memberBId = (await regB.json()).member_id;

  await privilegedPool.query(
    `INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
     VALUES ($1, $2, 'active', now())`,
    [tenantBId, memberBId],
  );
  const adjB = await adminFetchB(
    `/api/admin/members/${memberBId}/credit-adjustments`,
    { method: 'POST', body: JSON.stringify({ amount: 50, note: 'seed' }) },
  );
  assert.equal(adjB.status, 201);

  const catB = await makeCatalog(tenantBId, 'B Cage', 'b-cage-60');
  const bStart = new Date(thisWeekStart.getTime() + 60 * MIN);
  await privilegedPool.query(
    `INSERT INTO bookings (
       tenant_id, offering_id, resource_id,
       customer_first_name, customer_last_name, customer_email,
       start_time, end_time, status,
       amount_due_cents, amount_paid_cents, amount_refunded_cents,
       payment_status
     ) VALUES ($1, $2, $3, 'Bee', 'Walkin', $4, $5, $6, 'confirmed',
               12345, 12345, 0, 'paid')`,
    [
      tenantBId,
      catB.offering_id,
      catB.resource_id,
      `b-walkin-${randomUUID()}@example.com`,
      bStart,
      new Date(bStart.getTime() + 30 * MIN),
    ],
  );
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM tenants WHERE subdomain = ANY($1::text[])`,
      [[TENANT_A, TENANT_B]],
    );
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function tenantFetch(tenant, token, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${tenant}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}
function adminFetchA(path, init = {}) {
  return tenantFetch(TENANT_A, adminTokenA, path, init);
}
function adminFetchB(path, init = {}) {
  return tenantFetch(TENANT_B, adminTokenB, path, init);
}

// ---------------------------------------------------------------
// csvCell unit behavior (pure function — no DB needed)
// ---------------------------------------------------------------

test('csvCell quotes, escapes quotes, and blocks formula injection', () => {
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(7), '"7"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  // Formula-injection prefixes
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('-2'), `"'-2"`);
  assert.equal(csvCell('@cmd'), `"'@cmd"`);
  assert.equal(csvCell('\t=x'), `"'\t=x"`);
  // Combined: quote-escape after prefixing
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
});

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------

test('summary math: week edges, active members, liability, honest revenue', { skip }, async () => {
  const res = await adminFetchA('/api/admin/reports/summary');
  assert.equal(res.status, 200);
  const body = await res.json();

  // Sunday-23:30-tenant-local booking is LAST week even though its
  // UTC timestamp is already Monday. A UTC-week implementation
  // returns 0 here.
  assert.equal(body.bookingsLastWeek, 1);

  // This week: the midweek booking, plus the now+2d booking when it
  // lands before next Monday. Cancelled + two-weeks-ago fixtures
  // never count.
  assert.equal(body.bookingsThisWeek, 1 + (futureIsThisWeek ? 1 : 0));

  // Upcoming 7 days: only the now+2d booking (cancelled tomorrow's
  // is excluded, everything else is in the past).
  assert.equal(body.upcomingBookings7d, 1);

  // Only member1 has a non-terminal subscription (member3's is
  // cancelled = terminal).
  assert.equal(body.activeMembers, 1);

  // 5 - 2 + 4 through the ledger.
  assert.equal(body.creditLiability, 7);

  // Revenue: 3000 paid + (5000 - 2000) net of refund; last month's
  // 9900 excluded. Packs/subscriptions honestly null, not zero.
  assert.equal(body.revenueThisMonthCents, 6000);
  assert.deepEqual(body.revenueBreakdown, {
    walkIns: 6000,
    packs: null,
    subscriptions: null,
  });

  // Boundaries are computed in the tenant's zone and echoed back.
  assert.equal(body.boundaries.timezone, TZ);
  const { thisWeekStart, lastWeekStart } = tenantWeekBoundaries(TZ);
  assert.equal(body.boundaries.thisWeekStart, thisWeekStart.toISOString());
  assert.equal(body.boundaries.lastWeekStart, lastWeekStart.toISOString());
});

// ---------------------------------------------------------------
// members.csv
// ---------------------------------------------------------------

test('members.csv: attachment headers, quoting, formula prefix, subscription join', { skip }, async () => {
  const res = await adminFetchA('/api/admin/reports/members.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(
    res.headers.get('content-disposition'),
    /^attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"$/,
  );

  const text = await res.text();
  const lines = text.trim().split('\r\n');
  assert.equal(
    lines[0],
    '"first_name","last_name","email","phone","credits","subscription_status","plan","joined_at"',
  );

  // Formula-injection name is prefixed with an apostrophe.
  assert.ok(text.includes(`"'=SUM(A1:A9)"`), 'formula name must be prefixed');
  // Embedded quotes doubled, comma kept inside the quoted cell.
  assert.ok(text.includes(`"O'Brien, ""The"" Bat"`), 'quote escaping');

  // member1's row carries the subscription + plan + credits.
  const m1line = lines.find((l) => l.includes(memberAEmail));
  assert.ok(m1line, 'member1 row present');
  assert.ok(m1line.includes('"active"'));
  assert.ok(m1line.includes('"Reports Pro"'));
  assert.ok(m1line.includes('"7"'));

  // member3 (cancelled subscription) exports as "none".
  const m3line = lines.find((l) => l.includes(`O'Brien`));
  assert.ok(m3line.includes('"none"'));
});

// ---------------------------------------------------------------
// bookings.csv
// ---------------------------------------------------------------

test('bookings.csv: default range, escaping, and from/to filter', { skip }, async () => {
  const res = await adminFetchA('/api/admin/reports/bookings.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(
    res.headers.get('content-disposition'),
    /^attachment; filename="bookings-\d{4}-\d{2}-\d{2}\.csv"$/,
  );

  const text = await res.text();
  // Default window is the last 90 days ending today — past bookings
  // are in, the future booking is out.
  assert.ok(text.includes(sundayBookingId), 'sunday booking in default range');
  assert.ok(
    !text.includes(futureBookingId),
    'future booking excluded from default range',
  );
  // Walk-in customer name with a formula prefix is neutralized.
  assert.ok(text.includes(`"'=2+5"`), 'customer formula name prefixed');
  assert.ok(text.includes('"report-cage-60"'));
  assert.ok(text.includes('"Report Cage"'));
  assert.ok(text.includes('"walk-in"'));
  assert.ok(text.includes('"member"'));

  // Narrow to the Sunday-edge booking's tenant-local date: exactly
  // one data row.
  const narrow = await adminFetchA(
    `/api/admin/reports/bookings.csv?from=${sundayLocalDate}&to=${sundayLocalDate}`,
  );
  assert.equal(narrow.status, 200);
  const narrowLines = (await narrow.text()).trim().split('\r\n');
  assert.equal(narrowLines.length, 2, 'header + exactly one booking');
  assert.ok(narrowLines[1].includes(sundayBookingId));
});

test('bookings.csv: invalid ranges are 400', { skip }, async () => {
  const bad = await adminFetchA('/api/admin/reports/bookings.csv?from=not-a-date');
  assert.equal(bad.status, 400);

  const inverted = await adminFetchA(
    '/api/admin/reports/bookings.csv?from=2026-07-10&to=2026-07-01',
  );
  assert.equal(inverted.status, 400);
});

// ---------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------

test('two tenants: summaries and exports never bleed', { skip }, async () => {
  // Tenant B sees only its own numbers.
  const resB = await adminFetchB('/api/admin/reports/summary');
  assert.equal(resB.status, 200);
  const b = await resB.json();
  assert.equal(b.activeMembers, 1);
  assert.equal(b.creditLiability, 50);
  assert.equal(b.revenueThisMonthCents, 12345);
  assert.equal(b.revenueBreakdown.walkIns, 12345);

  // Tenant A's summary was asserted in detail above; spot-check that
  // B's 12345 walk-in and 50 credits didn't leak in.
  const resA = await adminFetchA('/api/admin/reports/summary');
  const a = await resA.json();
  assert.equal(a.creditLiability, 7);
  assert.equal(a.revenueThisMonthCents, 6000);

  // CSV exports are tenant-scoped both ways.
  const csvA = await (await adminFetchA('/api/admin/reports/members.csv')).text();
  assert.ok(!csvA.includes(memberBEmail), 'tenant B member not in A export');
  const csvB = await (await adminFetchB('/api/admin/reports/members.csv')).text();
  assert.ok(csvB.includes(memberBEmail));
  assert.ok(!csvB.includes(memberAEmail), 'tenant A member not in B export');
  const bookingsB = await (
    await adminFetchB('/api/admin/reports/bookings.csv')
  ).text();
  assert.ok(!bookingsB.includes(sundayBookingId));
});

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

test('reports require admin auth', { skip }, async () => {
  const anon = await tenantFetch(TENANT_A, null, '/api/admin/reports/summary');
  assert.equal(anon.status, 401);

  for (const path of [
    '/api/admin/reports/summary',
    '/api/admin/reports/members.csv',
    '/api/admin/reports/bookings.csv',
  ]) {
    const asMember = await tenantFetch(TENANT_A, memberToken, path);
    assert.equal(asMember.status, 403, `${path} must reject member tokens`);
  }
});
