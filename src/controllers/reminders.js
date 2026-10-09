// Booking reminder emails (customer-side slice 3, migration 033).
//
// runReminderSweep() runs every 10 minutes from src/server.js (under
// SCHEDULER_ENABLED, like the cleanup sweep). For each tenant whose
// billing is OK and whose booking_policies.reminders_enabled is on, it
// finds confirmed bookings starting within reminder_hours_before and
// emails each one once:
//
//   * rentals (bookings) and class spots (class_bookings)
//   * members (members.email) and walk-ins (customer_email)
//
// Skipped on purpose:
//   * bookings made — or rescheduled — INSIDE the reminder window: the
//     confirmation/reschedule email just went out; a reminder minutes
//     later is noise. (They're skipped, not marked, so the condition is
//     simply re-evaluated and stays false.)
//   * cancelled class instances; anything not 'confirmed'.
//
// Idempotence: reminder_sent_at is stamped inside the tenant
// transaction (FOR UPDATE SKIP LOCKED, so an overlapping run can't pick
// the same row); emails are sent only AFTER COMMIT (CLAUDE.md: no
// external calls inside a transaction). A send that fails after commit
// is logged and not retried — at-most-once is the right failure mode
// for a reminder. TODO: outbox.
//
// Walk-in rental reminders get a no-login manage link when the tenant
// has reminder_include_manage_link on. The confirmation-email token is
// only stored hashed, so the reminder mints its own
// (bookings.reminder_manage_token_hash); the manage endpoints accept
// either. Only paid walk-ins with a manage token (i.e. ones that got a
// confirmation link) get one — admin-created cash bookings never had a
// manage capability and don't gain one here.

import crypto from 'node:crypto';

import { pool } from '../db/pool.js';
import { buildManageUrl, sendBookingReminder } from '../services/email.js';
import { hashManageToken } from './customerBookings.js';

function addressLine(t) {
  const parts = [
    t.address_street,
    t.address_city,
    [t.address_state, t.address_zip].filter(Boolean).join(' '),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Collect due reminders for one tenant inside `db` (tenant GUC set),
// stamping reminder_sent_at. Returns the emails to send after commit.
export async function collectTenantReminders(db, tenant) {
  const policyRes = await db.query(
    `SELECT reminders_enabled, reminder_hours_before, reminder_include_manage_link,
            customer_reschedule_hours_before
       FROM booking_policies WHERE tenant_id = $1`,
    [tenant.id],
  );
  const policy = policyRes.rows[0] ?? {
    reminders_enabled: true,
    reminder_hours_before: 24,
    reminder_include_manage_link: true,
    customer_reschedule_hours_before: 24,
  };
  if (!policy.reminders_enabled) return [];
  const hours = policy.reminder_hours_before;

  const rentals = await db.query(
    `SELECT b.id, b.start_time, b.member_id, b.manage_token_hash,
            b.payment_status,
            COALESCE(m.email, b.customer_email) AS email,
            COALESCE(m.first_name, b.customer_first_name) AS first_name,
            o.name AS offering_name, r.name AS resource_name,
            d.first_name || ' ' || d.last_name AS participant_name
       FROM bookings b
       JOIN offerings o ON o.tenant_id = b.tenant_id AND o.id = b.offering_id
       JOIN resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
       LEFT JOIN members m ON m.tenant_id = b.tenant_id AND m.id = b.member_id
       LEFT JOIN dependents d ON d.tenant_id = b.tenant_id AND d.id = b.dependent_id
      WHERE b.tenant_id = $1
        AND b.status = 'confirmed'
        AND b.reminder_sent_at IS NULL
        AND b.start_time > now()
        AND b.start_time <= now() + ($2 * interval '1 hour')
        AND COALESCE(b.rescheduled_at, b.created_at) <= b.start_time - ($2 * interval '1 hour')
      ORDER BY b.start_time
      FOR UPDATE OF b SKIP LOCKED`,
    [tenant.id, hours],
  );

  const classes = await db.query(
    `SELECT cb.id, ci.start_time,
            COALESCE(m.email, cb.customer_email) AS email,
            COALESCE(m.first_name, cb.customer_first_name) AS first_name,
            o.name AS offering_name, r.name AS resource_name,
            d.first_name || ' ' || d.last_name AS participant_name
       FROM class_bookings cb
       JOIN class_instances ci ON ci.tenant_id = cb.tenant_id AND ci.id = cb.class_instance_id
       JOIN offerings o ON o.tenant_id = ci.tenant_id AND o.id = ci.offering_id
       JOIN resources r ON r.tenant_id = ci.tenant_id AND r.id = ci.resource_id
       LEFT JOIN members m ON m.tenant_id = cb.tenant_id AND m.id = cb.member_id
       LEFT JOIN dependents d ON d.tenant_id = cb.tenant_id AND d.id = cb.dependent_id
      WHERE cb.tenant_id = $1
        AND cb.status = 'confirmed'
        AND cb.reminder_sent_at IS NULL
        AND ci.cancelled_at IS NULL
        AND ci.start_time > now()
        AND ci.start_time <= now() + ($2 * interval '1 hour')
        AND cb.created_at <= ci.start_time - ($2 * interval '1 hour')
      ORDER BY ci.start_time
      FOR UPDATE OF cb SKIP LOCKED`,
    [tenant.id, hours],
  );

  const address = addressLine(tenant);
  const jobs = [];

  for (const b of rentals.rows) {
    let manageUrl = null;
    let canReschedule = false;
    const walkInWithLink =
      b.member_id === null && b.manage_token_hash !== null && b.payment_status === 'paid';
    if (policy.reminder_include_manage_link && walkInWithLink) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `UPDATE bookings SET reminder_manage_token_hash = $1 WHERE tenant_id = $2 AND id = $3`,
        [hashManageToken(token), tenant.id, b.id],
      );
      manageUrl = buildManageUrl(tenant.subdomain, token);
      const cutoff =
        new Date(b.start_time).getTime() - policy.customer_reschedule_hours_before * 3600000;
      canReschedule = Date.now() < cutoff;
    }
    await db.query(
      `UPDATE bookings SET reminder_sent_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, b.id],
    );
    if (b.email) {
      jobs.push({
        to: b.email,
        recipientName: b.first_name,
        offeringName: b.offering_name,
        resourceName: b.resource_name,
        startTime: b.start_time,
        address,
        manageUrl,
        canReschedule,
        participantName: b.participant_name,
      });
    }
  }

  for (const c of classes.rows) {
    await db.query(
      `UPDATE class_bookings SET reminder_sent_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, c.id],
    );
    if (c.email) {
      jobs.push({
        to: c.email,
        recipientName: c.first_name,
        offeringName: c.offering_name,
        resourceName: c.resource_name,
        startTime: c.start_time,
        address,
        participantName: c.participant_name,
      });
    }
  }

  return jobs;
}

// Cross-tenant sweep. Pass { tenantId } to scope to one tenant (tests).
// Returns [{ tenant_id, reminders }] for tenants that sent any.
export async function runReminderSweep({ tenantId } = {}) {
  const tenantsRes = tenantId
    ? await pool.query('SELECT * FROM tenant_lookup WHERE id = $1', [tenantId])
    : await pool.query('SELECT * FROM tenant_lookup WHERE is_billing_ok');

  const results = [];
  for (const tenant of tenantsRes.rows) {
    if (!tenant.is_billing_ok) continue; // locked-out tenant: send nothing
    const client = await pool.connect();
    let jobs = [];
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant.id]);
      jobs = await collectTenantReminders(client, tenant);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[scheduler] reminder sweep failed for tenant ${tenant.id}:`, err);
      jobs = [];
    } finally {
      client.release();
    }

    for (const job of jobs) {
      sendBookingReminder({ tenant, ...job }).catch((err) =>
        console.error('[email] booking reminder send failed:', err),
      );
    }
    if (jobs.length) results.push({ tenant_id: tenant.id, reminders: jobs.length });
  }
  return results;
}
