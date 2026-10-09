// GET /api/customers/home — public facility home page data.
//
// Proves: no auth needed; hours are the union across ACTIVE resources
// only; plans are limited to what a visitor can actually buy (active +
// Stripe price), in display order; tenant isolation holds.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import pg from 'pg';

import { app } from '../src/app.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let priv;
const subA = `home-a-${randomUUID().slice(0, 8)}`;
const subB = `home-b-${randomUUID().slice(0, 8)}`;

async function makeTenant(sub) {
  const t = await priv.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Home Test', 'America/New_York') RETURNING id`,
    [sub],
  );
  return t.rows[0].id;
}

// Writes under FORCE RLS need the tenant GUC even for the privileged
// role in some setups; set it per statement batch.
async function asTenant(tenantId, fn) {
  const c = await priv.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const a = await makeTenant(subA);
  await asTenant(a, async (c) => {
    const cage1 = (await c.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1') RETURNING id`, [a])).rows[0].id;
    const cage2 = (await c.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 2') RETURNING id`, [a])).rows[0].id;
    const retired = (await c.query(`INSERT INTO resources (tenant_id, name, active) VALUES ($1, 'Old Cage', false) RETURNING id`, [a])).rows[0].id;
    const hours = [
      [cage1, 1, '09:00', '17:00'],
      [cage2, 1, '12:00', '21:00'],
      // Only the retired cage is open Sunday — must NOT show.
      [retired, 0, '08:00', '12:00'],
    ];
    for (const [r, d, o, cl] of hours) {
      await c.query(
        `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [a, r, d, o, cl],
      );
    }
    const plans = [
      ['Pro', 26900, 20, 'price_pro', true, 2],
      ['Basic', 9900, 5, 'price_basic', true, 1],
      ['Draft (no Stripe price)', 5000, 2, null, true, 0],
      ['Retired', 1000, 1, 'price_old', false, 0],
    ];
    for (const [name, cents, credits, price, active, order] of plans) {
      await c.query(
        `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week, stripe_price_id, active, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [a, name, cents, credits, price, active, order],
      );
    }
  });

  await makeTenant(subB);
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM tenants WHERE subdomain = ANY($1::text[])', [[subA, subB]]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

test('home: public, merged active-resource hours, buyable plans only', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/customers/home?tenant=${subA}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.hours.length, 7);
  assert.deepEqual(body.hours[1].intervals, [{ open: '09:00', close: '21:00' }]);
  assert.deepEqual(body.hours[0].intervals, [], 'inactive resource hours excluded');

  assert.deepEqual(
    body.plans.map((p) => p.name),
    ['Basic', 'Pro'],
    'only active plans with a Stripe price, in display order',
  );
  assert.equal(body.plans[0].monthly_price_cents, 9900);
  assert.equal(body.plans[0].credits_per_week, 5);
  assert.equal('stripe_price_id' in body.plans[0], false, 'no Stripe ids on a public endpoint');
});

test('home: another tenant sees only its own (empty) data', { skip }, async () => {
  const res = await fetch(`${baseUrl}/api/customers/home?tenant=${subB}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.hours.every((d) => d.intervals.length === 0));
  assert.deepEqual(body.plans, []);
});
