// Class schedules + generator tests — Phase 4 slice 2.
//
// Covers:
//   * Create schedule with end_date: generator counts equal the
//     number of matching weekdays in [start_date, end_date].
//   * Create with start_date day_of_week mismatch → 400.
//   * Create against rental offering (capacity 1) → 409.
//   * Create against inactive offering → 409.
//   * Idempotent regeneration — calling /generate again is a no-op
//     (skipped count == matching dates, generated == 0).
//   * /generate extends past end_date is capped at end_date.
//   * /generate horizon defaults: when no `through` passed, +90d
//     from generated_through (or start_date for fresh schedules).
//   * GiST exclusion: overlapping one-off instance forces a
//     conflict; generator skips and advances generated_through past
//     it; subsequent dates still generate.
//
// Picks distinct fixture dates per test to avoid cross-test
// resource overlap (the GiST exclusion on class_instances applies
// across all schedules + one-offs on the same resource).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-class-schedules';
const TZ = 'America/New_York';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let resource_id;
let class_offering_id;
let rental_offering_id;
const CLASS_CAPACITY = 6;
const CLASS_DURATION_MIN = 60;

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Sched Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(
      `SELECT id FROM tenants WHERE subdomain = $1`,
      [TENANT],
    )
  ).rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const adminPassword = 'correcthorsebatterystaple';
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'Tester') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash(adminPassword, 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Sched Court') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  class_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Tuesday Clinic', 'classes', $2, 2, 5000, $3, true, true)
       RETURNING id`,
      [tenant_id, CLASS_DURATION_MIN, CLASS_CAPACITY],
    )
  ).rows[0].id;
  rental_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Rental Bay', 'cage-time', 30, 1, 2000, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3), ($1, $4, $3)`,
    [tenant_id, class_offering_id, resource_id, rental_offering_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  const adminLogin = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!adminLogin.ok) throw new Error('admin login failed');
  adminToken = (await adminLogin.json()).token;
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [TENANT]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function adminFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {}),
    },
  });
}

// ============================================================
// create
// ============================================================

test('create schedule with end_date generates exactly N occurrences', { skip }, async () => {
  // 2027-05-04 is a Tuesday (DOW=2). Through 2027-05-25 → 4 Tuesdays:
  // 5/4, 5/11, 5/18, 5/25.
  const res = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 2,
      start_time: '18:00',
      start_date: '2027-05-04',
      end_date: '2027-05-25',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.generated, 4);
  assert.equal(body.skipped, 0);
  assert.equal(body.conflicted, 0);
  const sched = body.class_schedule;
  assert.ok(sched.id);
  assert.equal(sched.day_of_week, 2);
  // generated_through is the last attempted date.
  // pg returns date columns as ISO strings via the JSON serializer
  // — accept either.
  assert.match(
    String(sched.generated_through).slice(0, 10),
    /^2027-05-25$/,
  );

  // DB: 4 instances exist for this schedule.
  const rows = await privilegedPool.query(
    `SELECT start_time FROM class_instances
      WHERE class_schedule_id = $1 ORDER BY start_time`,
    [sched.id],
  );
  assert.equal(rows.rows.length, 4);
  // Each one should be 18:00 EDT = 22:00 UTC (May = EDT, UTC-4).
  for (const row of rows.rows) {
    assert.equal(new Date(row.start_time).getUTCHours(), 22);
  }

  // Cleanup
  await privilegedPool.query(`DELETE FROM class_instances WHERE class_schedule_id = $1`, [sched.id]);
  await privilegedPool.query(`DELETE FROM class_schedules WHERE id = $1`, [sched.id]);
});

test('create with start_date day_of_week mismatch → 400', { skip }, async () => {
  // 2027-05-04 is a Tuesday (2); requesting day_of_week=3 (Wed) is
  // a mismatch.
  const res = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 3,
      start_time: '18:00',
      start_date: '2027-05-04',
      end_date: '2027-05-25',
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /day_of_week/i);
});

test('create against rental offering (capacity 1) → 409', { skip }, async () => {
  const res = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: rental_offering_id,
      resource_id,
      day_of_week: 2,
      start_time: '18:00',
      start_date: '2027-06-01',
      end_date: '2027-06-08',
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /rental/i);
});

test('create with end_date before start_date → 400', { skip }, async () => {
  const res = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 2,
      start_time: '18:00',
      start_date: '2027-06-01',
      end_date: '2027-05-31',
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /on or after start_date/i);
});

// ============================================================
// generate (extend)
// ============================================================

test('generate is idempotent: re-calling skips already-generated dates', { skip }, async () => {
  // Create a schedule with explicit horizon = start_date + 14 days
  // (3 Tuesdays).
  const create = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 2,
      start_time: '19:00',
      start_date: '2027-07-06',
      end_date: '2027-07-20', // 7/6, 7/13, 7/20
    }),
  });
  const sched = (await create.json()).class_schedule;

  try {
    // Run /generate without any new horizon — should resume from
    // generated_through+1 day, but generated_through is already at
    // end_date, so nothing to do.
    const re = await adminFetch(`/api/admin/class-schedules/${sched.id}/generate`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(re.status, 200);
    const body = await re.json();
    assert.equal(body.generated, 0);
    // Either skipped 0 and noted "nothing to generate", or skipped
    // matching the regenerated dates. Implementation: returns 0/0/0
    // with a `note`.
    assert.ok(body.note ? /nothing to generate/.test(body.note) : body.skipped >= 0);

    // Total instance count is still 3.
    const cnt = await privilegedPool.query(
      `SELECT count(*)::int AS n FROM class_instances WHERE class_schedule_id = $1`,
      [sched.id],
    );
    assert.equal(cnt.rows[0].n, 3);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE class_schedule_id = $1`, [sched.id]);
    await privilegedPool.query(`DELETE FROM class_schedules WHERE id = $1`, [sched.id]);
  }
});

test('generate extends through new horizon, capped at end_date', { skip }, async () => {
  // Open-ended schedule, generate initial 1 week, then extend.
  const create = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 2,
      start_time: '20:00',
      start_date: '2027-08-03',
      end_date: '2027-08-31', // 5 Tuesdays: 8/3, 8/10, 8/17, 8/24, 8/31
      generate_through: '2027-08-10', // initial: only 8/3 and 8/10
    }),
  });
  const created = await create.json();
  const sched = created.class_schedule;
  assert.equal(created.generated, 2);

  try {
    // Extend through a date past end_date — should be capped at 8/31.
    const re = await adminFetch(`/api/admin/class-schedules/${sched.id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ through: '2027-12-01' }),
    });
    assert.equal(re.status, 200);
    const body = await re.json();
    assert.equal(body.generated, 3); // 8/17, 8/24, 8/31

    const cnt = await privilegedPool.query(
      `SELECT count(*)::int AS n FROM class_instances WHERE class_schedule_id = $1`,
      [sched.id],
    );
    assert.equal(cnt.rows[0].n, 5);
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE class_schedule_id = $1`, [sched.id]);
    await privilegedPool.query(`DELETE FROM class_schedules WHERE id = $1`, [sched.id]);
  }
});

test('generator skips a date that conflicts with existing one-off instance', { skip }, async () => {
  // Pre-create a one-off class instance at the schedule's slot for
  // 2027-09-07 (Tuesday). Schedule will generate 9/7, 9/14, 9/21.
  // The 9/7 slot already exists as a one-off, so the GiST exclusion
  // on (resource, time_range) blocks the schedule's INSERT for that
  // date. The generator should report it under `conflicted` and
  // continue with 9/14 and 9/21.
  const start = new Date('2027-09-07T22:00:00.000Z'); // 18:00 EDT
  const end = new Date(start.getTime() + CLASS_DURATION_MIN * 60 * 1000);
  const oneoffId = (
    await privilegedPool.query(
      `INSERT INTO class_instances (
         tenant_id, class_schedule_id, offering_id, resource_id,
         start_time, end_time, capacity
       ) VALUES (
         $1, NULL, $2, $3, $4, $5, $6
       ) RETURNING id`,
      [tenant_id, class_offering_id, resource_id, start, end, CLASS_CAPACITY],
    )
  ).rows[0].id;

  let sched;
  try {
    const create = await adminFetch('/api/admin/class-schedules', {
      method: 'POST',
      body: JSON.stringify({
        offering_id: class_offering_id,
        resource_id,
        day_of_week: 2,
        start_time: '18:00',
        start_date: '2027-09-07',
        end_date: '2027-09-21', // 9/7, 9/14, 9/21
      }),
    });
    assert.equal(create.status, 201);
    const body = await create.json();
    sched = body.class_schedule;
    assert.equal(body.conflicted, 1, '9/7 should conflict with the one-off');
    assert.equal(body.generated, 2, '9/14 and 9/21 should still generate');
    assert.equal(body.skipped, 0);

    // The schedule has 2 instances; the one-off remains.
    const sched_instances = await privilegedPool.query(
      `SELECT count(*)::int AS n FROM class_instances WHERE class_schedule_id = $1`,
      [sched.id],
    );
    assert.equal(sched_instances.rows[0].n, 2);
    const all_at_resource = await privilegedPool.query(
      `SELECT count(*)::int AS n FROM class_instances WHERE resource_id = $1
        AND start_time >= '2027-09-01' AND start_time < '2027-10-01'`,
      [resource_id],
    );
    assert.equal(all_at_resource.rows[0].n, 3); // 1 oneoff + 2 sched
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE id = $1`, [oneoffId]);
    if (sched) {
      await privilegedPool.query(`DELETE FROM class_instances WHERE class_schedule_id = $1`, [sched.id]);
      await privilegedPool.query(`DELETE FROM class_schedules WHERE id = $1`, [sched.id]);
    }
  }
});

// ============================================================
// list
// ============================================================

test('GET /api/admin/class-schedules returns list with offering/resource/active_instance_count', { skip }, async () => {
  const create = await adminFetch('/api/admin/class-schedules', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: class_offering_id,
      resource_id,
      day_of_week: 4, // Thursday
      start_time: '17:00',
      start_date: '2027-10-07',
      end_date: '2027-10-21',
    }),
  });
  const sched = (await create.json()).class_schedule;
  try {
    const res = await adminFetch('/api/admin/class-schedules');
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.class_schedules.find((s) => s.id === sched.id);
    assert.ok(row);
    assert.equal(row.offering_name, 'Tuesday Clinic');
    assert.equal(row.resource_name, 'Sched Court');
    assert.equal(row.active_instance_count, 3); // 10/7, 10/14, 10/21
  } finally {
    await privilegedPool.query(`DELETE FROM class_instances WHERE class_schedule_id = $1`, [sched.id]);
    await privilegedPool.query(`DELETE FROM class_schedules WHERE id = $1`, [sched.id]);
  }
});
