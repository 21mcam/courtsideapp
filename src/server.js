// Process entry. Loads env, imports the configured app, listens.
// Tests import `app` from src/app.js directly and bind to a random port.

import 'dotenv/config';

import { app } from './app.js';
import { pool } from './db/pool.js';

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
}
