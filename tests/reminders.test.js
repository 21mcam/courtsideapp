// Booking reminder emails (migration 033, controllers/reminders.js).
//
// Proves: who gets reminded (confirmed rentals + class spots, members +
// walk-ins, inside the window, booked before the window opened) and who
// doesn't; exactly once; the walk-in reminder's own manage link works
// while the confirmation link keeps working; tenant settings (off, no
// link, hours) are honored; locked-out tenants send nothing; the
// policy API keeps reminder settings when a client omits them.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { app } from '../src/app.js';
import { runReminderSweep } from '../src/controllers/reminders.js';
import { hashManageToken } from '../src/controllers/customerBookings.js';
import { __clearSkippedEmails, __getSkippedEmails } from '../src/services/email.js';

const skip = !process.env.DATABASE_URL_PRIVILEGED && 'DATABASE_URL_PRIVILEGED required';
const SUB = `rem-${randomUUID().slice(0, 8)}`;
const HOUR = 3600000;

let server;
let baseUrl;
let priv;
let tenantId;
let adminToken;
const ids = {};
const confirmationToken = crypto.randomBytes(32).toString('base64url');

const at = (hoursFromNow) => new Date(Date.now() + hoursFromNow * HOUR);

async function q(sql, params) {
  const c = await priv.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } finally {
    c.release();
  }
}

async function rental({ start, created, member = false, status = 'confirmed', walkInToken = null, resource }) {
  const end = new Date(start.getTime() + HOUR);
  const r = await q(
    member
      ? `INSERT INTO bookings (tenant_id, offering_id, resource_id, member_id, start_time, end_time,
                              status, amount_due_cents, credit_cost_charged, payment_status, created_at,
                              cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 3, 'not_required', $8,
                 CASE WHEN $7 = 'cancelled' THEN now() END)
         RETURNING id`
      : `INSERT INTO bookings (tenant_id, offering_id, resource_id, customer_first_name, customer_last_name,
                              customer_email, customer_phone, start_time, end_time, status,
                              amount_due_cents, amount_paid_cents, payment_status, manage_token_hash,
                              created_at, cancelled_at)
         VALUES ($1, $2, $3, 'Wally', 'Walker', 'wally@example.com', '555-0100', $5, $6, $7,
                 4000, 4000, 'paid', $4, $8, CASE WHEN $7 = 'cancelled' THEN now() END)
         RETURNING id`,
    member
      ? [tenantId, ids.offering, resource ?? ids.cage, ids.member, start, end, status, created]
      : [tenantId, ids.offering, resource ?? ids.cage, walkInToken ? hashManageToken(walkInToken) : null,
         start, end, status, created],
  );
  return r.rows[0].id;
}

before(async () => {
  if (skip) return;
  priv = new pg.Pool({ connectionString: process.env.DATABASE_URL_PRIVILEGED });
  tenantId = (
    await priv.query(
      `INSERT INTO tenants (subdomain, name, timezone, address_street, address_city, address_state, address_zip)
       VALUES ($1, 'Reminder Gym', 'America/New_York', '1 Main St', 'Brooklyn', 'NY', '11220') RETURNING id`,
      [SUB],
    )
  ).rows[0].id;
  await q(`INSERT INTO booking_policies (tenant_id) VALUES ($1)`, [tenantId]);

  ids.cage = (await q(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Cage 1') RETURNING id`, [tenantId])).rows[0].id;
  ids.field = (await q(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Field') RETURNING id`, [tenantId])).rows[0].id;
  ids.offering = (
    await q(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
                             capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, '60-Minute Cage', 'cage-time', 60, 3, 4000, 1, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  ids.classOffering = (
    await q(
      `INSERT INTO offerings (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
                             capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Hitting Clinic', 'classes', 60, 2, 2500, 10, true, true) RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  for (const [o, r] of [[ids.offering, ids.cage], [ids.classOffering, ids.field]]) {
    await q(`INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES ($1, $2, $3)`, [tenantId, o, r]);
  }
  const user = (
    await q(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
       VALUES ($1, 'mia@example.com', 'x', 'Mia', 'Member') RETURNING id`,
      [tenantId],
    )
  ).rows[0].id;
  ids.member = (
    await q(
      `INSERT INTO members (tenant_id, user_id, email, first_name, last_name)
       VALUES ($1, $2, 'mia@example.com', 'Mia', 'Member') RETURNING id`,
      [tenantId, user],
    )
  ).rows[0].id;
  const admin = (
    await q(`INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`, [tenantId, user])
  ).rows[0].id;
  adminToken = jwt.sign(
    { tenant_id: tenantId, user_id: user, member_id: ids.member, admin_id: admin, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );

  const daysAgo = at(-72);
  ids.memberDue = await rental({ start: at(10), created: daysAgo, member: true });
  ids.walkInDue = await rental({ start: at(20), created: daysAgo, walkInToken: confirmationToken });
  ids.notYet = await rental({ start: at(30), created: daysAgo, member: true });
  ids.bookedLate = await rental({ start: at(5), created: at(-1), member: true });
  ids.cancelled = await rental({ start: at(8), created: daysAgo, member: true, status: 'cancelled' });

  const ci = (
    await q(
      `INSERT INTO class_instances (tenant_id, class_schedule_id, offering_id, resource_id, start_time, end_time, capacity)
       VALUES ($1, NULL, $2, $3, $4, $5, 10) RETURNING id`,
      [tenantId, ids.classOffering, ids.field, at(12), at(13)],
    )
  ).rows[0].id;
  ids.classDue = (
    await q(
      `INSERT INTO class_bookings (tenant_id, class_instance_id, customer_first_name, customer_last_name,
                                   customer_email, customer_phone, status, amount_due_cents,
                                   amount_paid_cents, payment_status, created_at)
       VALUES ($1, $2, 'Cleo', 'Class', 'cleo@example.com', '555', 'confirmed', 2500, 2500, 'paid', $3)
       RETURNING id`,
      [tenantId, ci, daysAgo],
    )
  ).rows[0].id;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  if (!skip) __clearSkippedEmails();
});

after(async () => {
  if (skip) return;
  await priv.query('DELETE FROM class_bookings WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM class_instances WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM bookings WHERE tenant_id = $1', [tenantId]);
  await priv.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await priv.end();
});

const mine = () => __getSkippedEmails().filter((e) => /^Reminder:/.test(e.subject));

test('sweep reminds exactly the due bookings, once', { skip }, async () => {
  const [res] = await runReminderSweep({ tenantId });
  assert.equal(res.reminders, 3);
  // Sends are fire-and-forget after commit; let them land.
  await new Promise((r) => setTimeout(r, 50));
  const sent = mine();
  assert.deepEqual(sent.map((e) => e.to).sort(), ['cleo@example.com', 'mia@example.com', 'wally@example.com']);

  const stamped = await priv.query(
    `SELECT id FROM bookings WHERE tenant_id = $1 AND reminder_sent_at IS NOT NULL`,
    [tenantId],
  );
  assert.deepEqual(stamped.rows.map((r) => r.id).sort(), [ids.memberDue, ids.walkInDue].sort());
  const cls = await priv.query(`SELECT reminder_sent_at FROM class_bookings WHERE id = $1`, [ids.classDue]);
  assert.ok(cls.rows[0].reminder_sent_at);

  const member = sent.find((e) => e.to === 'mia@example.com');
  assert.match(member.subject, /60-Minute Cage/);
  assert.match(member.text, /1 Main St, Brooklyn, NY 11220/);
  assert.doesNotMatch(member.text, /walk-in\/manage/, 'members get no manage link');

  __clearSkippedEmails();
  assert.deepEqual(await runReminderSweep({ tenantId }), [], 'second run sends nothing');
});

test("walk-in reminder carries its own working link; the confirmation link still works", { skip }, async () => {
  const row = await priv.query(`SELECT reminder_manage_token_hash FROM bookings WHERE id = $1`, [ids.walkInDue]);
  assert.match(row.rows[0].reminder_manage_token_hash, /^[0-9a-f]{64}$/);

  // Re-run for this booking alone to capture its email.
  await priv.query(`UPDATE bookings SET reminder_sent_at = NULL WHERE id = $1`, [ids.walkInDue]);
  await runReminderSweep({ tenantId });
  await new Promise((r) => setTimeout(r, 50));
  const email = mine().find((e) => e.to === 'wally@example.com');
  const link = email.text.match(/walk-in\/manage\?token=([A-Za-z0-9_-]+)/);
  assert.ok(link, 'manage link present');
  // 20h out with the default 24h reschedule cutoff → view-only label.
  assert.match(email.text, /View your booking:/);

  for (const token of [decodeURIComponent(link[1]), confirmationToken]) {
    const res = await fetch(`${baseUrl}/api/customers/bookings/manage/${token}?tenant=${SUB}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).booking.id, ids.walkInDue);
  }
});

test('tenant settings: off sends nothing; link off sends no link; billing lock sends nothing', { skip }, async () => {
  const reset = () =>
    priv.query(`UPDATE bookings SET reminder_sent_at = NULL WHERE id = ANY($1::uuid[])`, [[ids.memberDue, ids.walkInDue]]);

  await reset();
  await q(`UPDATE booking_policies SET reminders_enabled = false WHERE tenant_id = $1`, [tenantId]);
  assert.deepEqual(await runReminderSweep({ tenantId }), []);

  await q(
    `UPDATE booking_policies SET reminders_enabled = true, reminder_include_manage_link = false WHERE tenant_id = $1`,
    [tenantId],
  );
  await runReminderSweep({ tenantId });
  await new Promise((r) => setTimeout(r, 50));
  const walkIn = mine().find((e) => e.to === 'wally@example.com');
  assert.doesNotMatch(walkIn.text, /walk-in\/manage/);
  assert.match(walkIn.text, /Reply to this email/);

  await reset();
  await priv.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [tenantId]);
  try {
    assert.deepEqual(await runReminderSweep({ tenantId }), []);
  } finally {
    await priv.query(`UPDATE tenants SET trial_ends_at = NULL WHERE id = $1`, [tenantId]);
    await q(`UPDATE booking_policies SET reminder_include_manage_link = true WHERE tenant_id = $1`, [tenantId]);
  }
});

test('reminder window follows reminder_hours_before', { skip }, async () => {
  // The 30h booking enters a 48h window.
  await q(`UPDATE booking_policies SET reminder_hours_before = 48 WHERE tenant_id = $1`, [tenantId]);
  try {
    await runReminderSweep({ tenantId });
    const r = await priv.query(`SELECT reminder_sent_at FROM bookings WHERE id = $1`, [ids.notYet]);
    assert.ok(r.rows[0].reminder_sent_at);
    const late = await priv.query(`SELECT reminder_sent_at FROM bookings WHERE id = $1`, [ids.bookedLate]);
    assert.equal(late.rows[0].reminder_sent_at, null, 'booked inside the window → no reminder');
  } finally {
    await q(`UPDATE booking_policies SET reminder_hours_before = 24 WHERE tenant_id = $1`, [tenantId]);
  }
});

test('policy API: set reminder settings; omitting them keeps them', { skip }, async () => {
  const put = (body) =>
    fetch(`${baseUrl}/api/admin/booking-policies?tenant=${SUB}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    });

  let res = await put({ reminders_enabled: false, reminder_hours_before: 4, reminder_include_manage_link: false });
  assert.equal(res.status, 200);
  let p = (await res.json()).booking_policies;
  assert.deepEqual(
    [p.reminders_enabled, p.reminder_hours_before, p.reminder_include_manage_link],
    [false, 4, false],
  );

  res = await put({ free_cancel_hours_before: 12 });
  p = (await res.json()).booking_policies;
  assert.deepEqual(
    [p.reminders_enabled, p.reminder_hours_before, p.reminder_include_manage_link],
    [false, 4, false],
    'older payloads must not reset reminder settings',
  );

  assert.equal((await put({ reminder_hours_before: 0 })).status, 400);
  assert.equal((await put({ reminder_hours_before: 169 })).status, 400);
});
