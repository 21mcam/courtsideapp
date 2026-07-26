// Process entry. Loads env, imports the configured app, listens.
// Tests import `app` from src/app.js directly and bind to a random port.

import 'dotenv/config';

import { app } from './app.js';
import { pool } from './db/pool.js';
import { runCleanupSweep } from './controllers/cleanup.js';
import { runHorizonSweep } from './controllers/classSchedules.js';

const port = Number.parseInt(process.env.PORT, 10) || 3000;

app.listen(port, () => {
  console.log(`courtside listening on :${port}`);
});

// Weekly credit reset scheduler — hourly call into the idempotent SQL
// function (migration 022). It no-ops unless a tenant's local clock
// has crossed Monday 00:00 since its last reset, so calling it every
// hour (and once at boot, to cover restarts that straddle a Monday)
// is cheap. Disable with SCHEDULER_ENABLED=false (e.g. when pg_cron
// is active and you don't want the belt-and-suspenders run — the
// function's SKIP LOCKED guard makes overlap harmless either way).
// TODO: replace with pg_cron once enabled in Supabase
if (process.env.SCHEDULER_ENABLED !== 'false') {
  const runWeeklyCreditResets = () =>
    pool
      .query('SELECT * FROM run_weekly_credit_resets()')
      .then((r) => {
        if (r.rows.length > 0) {
          console.log(
            `[scheduler] weekly credit reset applied for ${r.rows.length} tenant(s)`,
          );
        }
      })
      .catch((err) =>
        console.error('[scheduler] weekly credit reset failed:', err),
      );
  runWeeklyCreditResets();
  setInterval(runWeeklyCreditResets, 60 * 60 * 1000).unref();

  // Stale-state cleanup sweep — every 10 minutes (and once at boot).
  // Cancels expired pending_payment holds, settles past confirmed
  // bookings to completed, and cancels abandoned incomplete
  // subscriptions. Idempotent per run; per-tenant errors are logged
  // inside the sweep and never kill the interval.
  // TODO: outbox/pg_cron — move to pg_cron once enabled in Supabase.
  const cleanupSweep = () =>
    runCleanupSweep()
      .then((results) => {
        const touched = results.filter(
          (r) =>
            r.bookings_cancelled > 0 ||
            r.bookings_completed > 0 ||
            r.subscriptions_cancelled > 0,
        );
        if (touched.length > 0) {
          console.log(
            `[scheduler] cleanup sweep touched ${touched.length} tenant(s)`,
          );
        }
      })
      .catch((err) => console.error('[scheduler] cleanup sweep failed:', err));
  cleanupSweep();
  setInterval(cleanupSweep, 10 * 60 * 1000).unref();

  // Class-schedule horizon extension — daily (and once at boot).
  // Keeps every active schedule's class_instances materialized ~90
  // days ahead so recurring classes never silently stop appearing.
  // Idempotent (unique index + ON CONFLICT DO NOTHING).
  // TODO: outbox/pg_cron — move to pg_cron once enabled in Supabase.
  const horizonSweep = () =>
    runHorizonSweep()
      .then((results) => {
        const extended = results.filter((r) => r.schedules_extended > 0);
        if (extended.length > 0) {
          console.log(
            `[scheduler] class-schedule horizon extended for ${extended.length} tenant(s)`,
          );
        }
      })
      .catch((err) =>
        console.error('[scheduler] horizon sweep failed:', err),
      );
  horizonSweep();
  setInterval(horizonSweep, 24 * 60 * 60 * 1000).unref();
}
