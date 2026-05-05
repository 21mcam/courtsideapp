// 01_snapshot_source.js — dump Momentum source data to JSON files.
//
// Skeleton. Fill in once Momentum's source schema is inventoried.
// The point of separating snapshot from transform is two-fold:
//
//   1. Reproducibility — the snapshot is a frozen point-in-time
//      reference. If 03_load fails halfway and we need to retry,
//      we run against the same snapshot, not whatever is currently
//      in Momentum (which may have drifted in the few minutes
//      since cutover started).
//
//   2. Testability — `02_transform.js` is a pure function over
//      JSON. We can run the transform on a sample snapshot in
//      tests / staging without ever touching the source DB.
//
// Output goes to `scripts/migration/out/source/*.json`. Each file
// is a JSON array of source rows.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info } from './shared/log.js';

const OUT_DIR = new URL('./out/source/', import.meta.url).pathname;

async function main() {
  banner('01 snapshot source');

  await mkdir(OUT_DIR, { recursive: true });

  // TODO once source schema is known. Fill in connection logic for
  // Momentum's DB (likely a Supabase or RDS read replica) + queries
  // for each table we care about. Pseudocode for shape:
  //
  //   const sourcePool = new pg.Pool({ connectionString: process.env.MOMENTUM_SOURCE_URL });
  //   const users     = await sourcePool.query('SELECT * FROM users');
  //   const subs      = await sourcePool.query('SELECT * FROM subscriptions');
  //   const balances  = await sourcePool.query('SELECT user_id, credits FROM credit_balances');
  //   const bookings  = await sourcePool.query('SELECT * FROM setmore_bookings_archive');
  //   await dump('users.json', users.rows);
  //   await dump('subscriptions.json', subs.rows);
  //   ...
  //
  // For Setmore data: if there's no API export, ask Momentum's old
  // admin to do a manual CSV export from the Setmore admin UI and
  // drop the file in `out/source/setmore_bookings.csv`. The
  // transformer reads CSV or JSON.

  info('skeleton: source snapshot logic not yet implemented', {
    note: 'fill in after Momentum source inventory is complete',
  });
}

// eslint-disable-next-line no-unused-vars
async function dump(filename, rows) {
  const path = join(OUT_DIR, filename);
  await writeFile(path, JSON.stringify(rows, null, 2));
  info('dumped', { path, count: rows.length });
}

main().catch((err) => {
  console.error('snapshot failed:', err);
  process.exit(1);
});
