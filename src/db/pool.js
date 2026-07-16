// Single shared pg connection pool. Imported anywhere DB access is needed.
//
// `dotenv/config` is loaded here (idempotent) so direct imports of this
// module from tests / scripts pick up DATABASE_URL without depending on
// server.js having loaded dotenv first.
//
// DATABASE_URL must point at the runtime role (`app_runtime`), NOT
// postgres / superuser. The whole privilege boundary in migration 011
// is meaningless if the backend connects as a BYPASSRLS role.
//
// Append `?family=4` to force IPv4 — works around IPv6 issues some
// networks have with Supabase. CLAUDE.md gotcha #8.

import 'dotenv/config';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

// Return Postgres `date` columns as plain 'YYYY-MM-DD' strings instead
// of JS Date objects. node-postgres's default parses a date as
// midnight in the SERVER's local timezone; res.json then serializes it
// via toISOString (UTC), so on any server east of UTC every date field
// (class_schedules.start_date / end_date / generated_through) would
// come out shifted a day — and clients doing String(d).slice(0, 10)
// would render the wrong calendar date. A calendar date is not an
// instant; keep it a string end-to-end. (OID 1082 = date.)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Surface unexpected pool-level errors. Per-query errors come back via
// the query promise and are handled at the call site.
pool.on('error', (err) => {
  console.error('pg pool error:', err);
});
