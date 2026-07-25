// plans.allowed_categories enforcement tests.
//
// A member whose current plan whitelists categories (non-NULL
// allowed_categories) may only spend credits on offerings in the
// whitelist — enforced with a 403 naming the plan and category, in
// BOTH the rental flow (POST /api/bookings) and the class flow
// (POST /api/class-bookings). NULL allowed_categories = all
// categories; members with no subscription at all (admin-granted
// credits) are unrestricted. Walk-in/cash flows are untouched by
// design (no plan, no restriction).
//
// Fixtures: one tenant with a rental offering ('cage-time'), two
// class offerings ('classes' and 'hittrax'), a restricted plan
// (allowed_categories = ['classes']) and an open plan (NULL).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';
import { app } from '../src/app.js';

const TENANT = 'verify-plan-categories';
const TZ = 'America/New_York';
const RESTRICTED_PLAN_NAME = 'Classes Only';

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let cage_resource_id;
let class_resource_id;
let cage_offering_id; // category 'cage-time', capacity 1
let classes_instance_id; // instance of a 'classes' offering
let hittrax_instance_id; // instance of a 'hittrax' offering
let restricted_plan_id; // allowed_categories = ['classes']
let open_plan_id; // allowed_categories = NULL

// Mondays in 2027, EST (winter, offset -05:00). Op hours 09:00-17:00.
const DOW_MONDAY = 1;
const CAGE_SLOT_403 = '2027-03-01T19:00:00.000Z'; // 14:00 EST
const CAGE_SLOT_OPEN = '2027-03-01T20:00:00.000Z'; // 15:00 EST
const CAGE_SLOT_NOSUB = '2027-03-01T21:00:00.000Z'; // 16:00 EST

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });

  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Plan Category Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ])
  ).rows[0].id;

  // Rental fixture: cage resource + 'cage-time' offering + hours.
  cage_resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  cage_offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, allow_member_booking, allow_public_booking)
       VALUES ($1, '60-min cage', 'cage-time', 60, 3, 3000, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, cage_offering_id, cage_resource_id],
  );
  await privilegedPool.query(
    `INSERT INTO operating_hours
       (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, $3, '09:00', '17:00')`,
    [tenant_id, cage_resource_id, DOW_MONDAY],
  );

  // Class fixtures: one 'classes' offering (whitelisted for the
  // restricted plan) and one 'hittrax' offering (not whitelisted),
  // each with a future instance on the class resource.
  class_resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Class Court') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  const mkClassOffering = async (name, category) => {
    const offeringId = (
      await privilegedPool.query(
        `INSERT INTO offerings
           (tenant_id, name, category, duration_minutes, credit_cost,
            dollar_price, capacity, allow_member_booking, allow_public_booking)
         VALUES ($1, $2, $3, 60, 2, 5000, 8, true, true)
         RETURNING id`,
        [tenant_id, name, category],
      )
    ).rows[0].id;
    await privilegedPool.query(
      `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
       VALUES ($1, $2, $3)`,
      [tenant_id, offeringId, class_resource_id],
    );
    return offeringId;
  };
  const mkInstance = async (offeringId, startIso) => {
    const start = new Date(startIso);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return (
      await privilegedPool.query(
        `INSERT INTO class_instances
           (tenant_id, class_schedule_id, offering_id, resource_id,
            start_time, end_time, capacity)
         VALUES ($1, NULL, $2, $3, $4, $5, 8)
         RETURNING id`,
        [tenant_id, offeringId, class_resource_id, start, end],
      )
    ).rows[0].id;
  };
  const classesOfferingId = await mkClassOffering('Hitting Clinic', 'classes');
  const hittraxOfferingId = await mkClassOffering('HitTrax Lab', 'hittrax');
  classes_instance_id = await mkInstance(
    classesOfferingId,
    '2027-03-02T19:00:00.000Z',
  );
  hittrax_instance_id = await mkInstance(
    hittraxOfferingId,
    '2027-03-02T21:00:00.000Z',
  );

  // Plans: restricted whitelist vs NULL (= everything allowed).
  restricted_plan_id = (
    await privilegedPool.query(
      `INSERT INTO plans
         (tenant_id, name, monthly_price_cents, credits_per_week, allowed_categories)
       VALUES ($1, $2, 9900, 10, $3::category_key[])
       RETURNING id`,
      [tenant_id, RESTRICTED_PLAN_NAME, ['classes']],
    )
  ).rows[0].id;
  open_plan_id = (
    await privilegedPool.query(
      `INSERT INTO plans
         (tenant_id, name, monthly_price_cents, credits_per_week, allowed_categories)
       VALUES ($1, 'All Access', 19900, 20, NULL)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;

  // Permissive advance window so the 2027 fixtures are bookable.
  await privilegedPool.query(
    `INSERT INTO booking_policies (
       tenant_id, free_cancel_hours_before, allow_member_self_cancel,
       min_advance_booking_minutes, max_advance_booking_days
     ) VALUES ($1, 24, true, 0, 730)
     ON CONFLICT (tenant_id) DO UPDATE SET
       min_advance_booking_minutes = EXCLUDED.min_advance_booking_minutes,
       max_advance_booking_days    = EXCLUDED.max_advance_booking_days`,
    [tenant_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ============================================================
// helpers
// ============================================================

async function withTenant(fn) {
  const c = await privilegedPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
      tenant_id,
    ]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// Register via the API (need a real member JWT), optionally attach an
// active subscription on planId, and grant spending credits.
async function newMember({ planId = null, credits = 20 } = {}) {
  const email = `member-${randomUUID()}@example.com`;
  const reg = await fetch(
    `${baseUrl}/api/auth/register-member?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'correcthorsebatterystaple',
        first_name: 'Category',
        last_name: 'Tester',
      }),
    },
  );
  if (!reg.ok) throw new Error(`register-member failed: HTTP ${reg.status}`);
  const body = await reg.json();

  await withTenant(async (c) => {
    if (planId) {
      const subId = (
        await c.query(
          `INSERT INTO subscriptions (tenant_id, member_id, status, activated_at)
           VALUES ($1, $2, 'active', now()) RETURNING id`,
          [tenant_id, body.member_id],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO subscription_plan_periods
           (tenant_id, subscription_id, plan_id)
         VALUES ($1, $2, $3)`,
        [tenant_id, subId, planId],
      );
    }
    if (credits > 0) {
      await c.query(
        `SELECT apply_credit_change($1, $2, $3, 'admin_adjustment',
                                    NULL, NULL, NULL, NULL)`,
        [tenant_id, body.member_id, credits],
      );
    }
  });
  return body;
}

function memberFetch(token, path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

function bookCage(token, start_time) {
  return memberFetch(token, '/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id: cage_offering_id,
      resource_id: cage_resource_id,
      start_time,
    }),
  });
}

function bookClass(token, class_instance_id) {
  return memberFetch(token, '/api/class-bookings', {
    method: 'POST',
    body: JSON.stringify({ class_instance_id }),
  });
}

// ============================================================
// rental flow
// ============================================================

test('restricted plan: rental outside the whitelist → 403 naming plan and category; nothing spent', { skip }, async () => {
  const m = await newMember({ planId: restricted_plan_id });

  const res = await bookCage(m.token, CAGE_SLOT_403);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(
    body.error.includes(RESTRICTED_PLAN_NAME),
    `error should name the plan: ${body.error}`,
  );
  assert.ok(
    body.error.includes('cage-time'),
    `error should name the category: ${body.error}`,
  );

  // No booking row, no credits spent — the 403 fired before any write.
  const bookings = await privilegedPool.query(
    `SELECT 1 FROM bookings WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, m.member_id],
  );
  assert.equal(bookings.rows.length, 0);
  const bal = await privilegedPool.query(
    `SELECT current_credits FROM credit_balances
      WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, m.member_id],
  );
  assert.equal(bal.rows[0].current_credits, 20);
});

test('NULL allowed_categories plan books any category', { skip }, async () => {
  const m = await newMember({ planId: open_plan_id });
  const res = await bookCage(m.token, CAGE_SLOT_OPEN);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.booking.status, 'confirmed');
  assert.equal(body.balance_after, 17); // 20 - 3
});

test('member with no subscription (admin-granted credits) is unrestricted', { skip }, async () => {
  const m = await newMember(); // no plan
  const res = await bookCage(m.token, CAGE_SLOT_NOSUB);
  assert.equal(res.status, 201);
});

// ============================================================
// class flow
// ============================================================

test('restricted plan: class in a whitelisted category → 201', { skip }, async () => {
  const m = await newMember({ planId: restricted_plan_id });
  const res = await bookClass(m.token, classes_instance_id);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.class_booking.status, 'confirmed');
});

test('restricted plan: class outside the whitelist → 403 naming plan and category', { skip }, async () => {
  const m = await newMember({ planId: restricted_plan_id });
  const res = await bookClass(m.token, hittrax_instance_id);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.error.includes(RESTRICTED_PLAN_NAME), body.error);
  assert.ok(body.error.includes('hittrax'), body.error);

  const cb = await privilegedPool.query(
    `SELECT 1 FROM class_bookings WHERE tenant_id = $1 AND member_id = $2`,
    [tenant_id, m.member_id],
  );
  assert.equal(cb.rows.length, 0);
});
