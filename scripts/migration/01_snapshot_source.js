// 01_snapshot_source.js — dump Diamond Club's live DB (+ the Setmore
// CSV export) to out/source/ and seal it with a fail-closed manifest.
//
// Why snapshot is a separate stage from transform:
//
//   1. Reproducibility — the snapshot is a frozen point-in-time
//      reference. If 03_load fails halfway and we need to retry, we
//      rerun against the same hashed files, not whatever is currently
//      in Diamond (which may have drifted in the minutes since
//      cutover started). The manifest's sha256s are what make "same"
//      checkable rather than hoped-for: 02_transform reads every
//      input through readVerified and refuses drifted bytes.
//
//   2. Testability — 02_transform is a pure function over JSON. We
//      can run the transform on a staging snapshot (or a hand-built
//      fixture with a hand-built manifest) without ever touching the
//      source DB.
//
// All DB reads happen on ONE connection inside a REPEATABLE READ,
// READ ONLY transaction, so every table sees the same MVCC snapshot —
// a booking dumped here can't reference a member created mid-dump.
// The cutover runbook puts Diamond in read-only mode first anyway;
// the transaction makes staging rehearsals against a live DB equally
// safe. Each table dump runs under a savepoint so one failure doesn't
// poison the transaction — we collect EVERY table-level problem and
// abort with the full list, instead of making the operator replay the
// script once per discovery.

import 'dotenv/config';
import pg from 'pg';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { banner, info, warn } from './shared/log.js';
import {
  MANIFEST_NAME,
  sha256File,
  writeJsonWithHash,
  writeManifest,
} from './shared/manifest.js';
import { parseCsv } from './shared/csv.js';

const OUT_DIR = new URL('./out/source/', import.meta.url).pathname;
const SETMORE_CSV = 'setmore_bookings.csv';

// Tables 02_transform actually consumes. A query failure on any of
// these (missing table, dead connection) is fatal — there is no
// "partial snapshot" concept.
//
// `mayBeEmpty`: members/services/credit_balances/bookings with zero
// rows means we connected to the wrong database (a facility with no
// members is not a real snapshot) — fatal. credit_grants (maybe no
// gift card was ever sold) and member_status_changes (audit history
// starts empty) can legitimately be empty; the file is still written
// and hashed so transform reads a verified [] instead of guessing.
const REQUIRED_TABLES = [
  { table: 'members', orderBy: 'id', mayBeEmpty: false },
  { table: 'services', orderBy: 'id', mayBeEmpty: false },
  { table: 'credit_balances', orderBy: 'member_id', mayBeEmpty: false },
  { table: 'bookings', orderBy: 'id', mayBeEmpty: false },
  { table: 'credit_grants', orderBy: 'id', mayBeEmpty: true },
  { table: 'member_status_changes', orderBy: 'id', mayBeEmpty: true },
];

// Snapshot-for-the-record tables. Never loaded into Courtside — they
// exist so "keep the source 30 days" survives even after the Diamond
// DB is finally torn down. All have a uuid/serial `id` PK. If one
// doesn't exist at the source (older install that never ran the POS
// migrations), that's recorded in the manifest's `skips`, not a
// failure — but any OTHER error (permissions, connection) still is.
const ARCHIVE_TABLES = [
  'pos_catalog',
  'transactions',
  'terminal_readers',
  'facility_settings',
  'checkout_handoffs',
  'password_reset_tokens',
];

// Host (no credentials) for the manifest's provenance block, so a
// post-mortem can tell a staging-rehearsal snapshot from the real
// one. Informational only — an unparseable DSN (pg also accepts
// key=value form) degrades to null with a warning, it doesn't abort.
function parseSourceHost(connString) {
  try {
    const u = new URL(connString);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    warn('MOMENTUM_SOURCE_URL is not URL-shaped; manifest source.host will be null');
    return null;
  }
}

// SELECT * under a savepoint. The savepoint is what lets the caller
// keep using the shared transaction after a failed query (Postgres
// otherwise aborts the whole transaction on first error) — that's
// the mechanism behind "collect all problems, fail once".
// `table`/`orderBy` come from the constant lists above, never from
// input, so direct interpolation is safe.
async function dumpTable(client, table, orderBy) {
  await client.query('SAVEPOINT table_dump');
  try {
    const res = await client.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    await client.query('RELEASE SAVEPOINT table_dump');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT table_dump');
    throw err;
  }
}

// The Setmore export is the ONLY source for walk-in appointments —
// Diamond's bookings table holds member bookings exclusively. The
// operator drops the CSV at out/source/setmore_bookings.csv BEFORE
// running this script; we hash and row-count it here so the transform
// stage reads the exact bytes the operator vouched for. Parse errors
// are fatal HERE — a corrupt export must fail at the snapshot line,
// not twenty minutes later inside the transform.
//
// SETMORE_EXPORT_SKIP=1 is the deliberate escape hatch for DB-only
// staging rehearsals (see runbook); it records the skip in the
// manifest so 02_transform can hard-fail if it turns out to need the
// file. Nothing is ever silently absent.
async function snapshotSetmoreCsv(skips) {
  const path = join(OUT_DIR, SETMORE_CSV);
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (process.env.SETMORE_EXPORT_SKIP === '1') {
      const reason =
        'SETMORE_EXPORT_SKIP=1 — operator skipped the Setmore export; ' +
        'walk-in history will NOT be in this snapshot and the transform ' +
        'stage will refuse to run any step that needs it';
      warn('setmore export skipped by operator', { file: SETMORE_CSV });
      skips.push({ file: SETMORE_CSV, reason });
      return null;
    }
    throw new Error(
      `Setmore export missing: ${path}\n` +
        `Export appointments from the Setmore admin UI and drop the CSV at ` +
        `that exact path BEFORE running this script. It is the only source ` +
        `for walk-in bookings. To deliberately snapshot without it (staging ` +
        `rehearsal of DB-only steps — see runbook), set SETMORE_EXPORT_SKIP=1.`,
    );
  }
  let records;
  try {
    ({ records } = parseCsv(text));
  } catch (err) {
    throw new Error(`${SETMORE_CSV}: ${err.message}`);
  }
  if (records.length === 0) {
    // Header-only export parses clean but is almost certainly a bad
    // filter in the Setmore UI. Loud warning, operator's call.
    warn('setmore export has a header but ZERO data rows — verify the export filters', {
      file: SETMORE_CSV,
    });
  }
  return { rows: records.length, sha256: await sha256File(path), required: true };
}

async function main() {
  banner('01 snapshot source');

  if (!process.env.MOMENTUM_SOURCE_URL) {
    throw new Error(
      'MOMENTUM_SOURCE_URL required — the Diamond/Momentum Postgres ' +
        'connection string (read-only replica or snapshot). This is NOT ' +
        'MIGRATION_DATABASE_URL; that one is the privileged Courtside DB.',
    );
  }

  await mkdir(OUT_DIR, { recursive: true });

  // Kill any manifest from a previous run FIRST. The manifest is the
  // pipeline's "this snapshot is complete" seal — if this run fails
  // partway, a stale seal from an earlier successful run must not
  // survive to let 02_transform verify against yesterday's bytes.
  // Only a run that reaches writeManifest below leaves one behind.
  await rm(join(OUT_DIR, MANIFEST_NAME), { force: true });

  const files = {};
  const skips = [];

  // CSV first: it needs no network, so a forgotten export fails in
  // milliseconds instead of after a full DB dump.
  const setmoreEntry = await snapshotSetmoreCsv(skips);
  if (setmoreEntry) {
    files[SETMORE_CSV] = setmoreEntry;
    info('hashed', { file: SETMORE_CSV, rows: setmoreEntry.rows });
  }

  // Deliberately NOT shared/db.js — that pool is the privileged
  // COURTSIDE database. This one points at the system we're leaving.
  const sourcePool = new pg.Pool({
    connectionString: process.env.MOMENTUM_SOURCE_URL,
    max: 1, // one connection: every read shares one MVCC snapshot
  });
  sourcePool.on('error', (err) => {
    console.error('momentum source pg pool error:', err);
  });

  // Reachability outside the per-table loop: a dead host or bad
  // credentials should read as ONE clear error, not twelve identical
  // ones buried in the table list.
  let client;
  try {
    client = await sourcePool.connect();
    await client.query('SELECT 1');
  } catch (err) {
    throw new Error(
      `cannot reach Momentum source DB (${parseSourceHost(process.env.MOMENTUM_SOURCE_URL) ?? 'unparsed host'}): ${err.message}`,
    );
  }

  const problems = []; // every table-level failure, reported together
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    for (const { table, orderBy, mayBeEmpty } of REQUIRED_TABLES) {
      let rows;
      try {
        rows = await dumpTable(client, table, orderBy);
      } catch (err) {
        problems.push(`${table}: query failed — ${err.message}`);
        continue;
      }
      if (rows.length === 0 && !mayBeEmpty) {
        problems.push(
          `${table}: 0 rows — a facility with an empty ${table} table is ` +
            `not a real snapshot; is MOMENTUM_SOURCE_URL pointing at the right DB?`,
        );
        continue;
      }
      // pg hands back Date objects for timestamptz; JSON.stringify
      // serializes them as ISO-8601 UTC strings, which is exactly the
      // shape 02_transform parses back.
      const entry = await writeJsonWithHash(OUT_DIR, `${table}.json`, rows);
      files[`${table}.json`] = { ...entry, required: true };
      info('dumped', { table, rows: entry.rows });
    }

    for (const table of ARCHIVE_TABLES) {
      let rows;
      try {
        rows = await dumpTable(client, table, 'id');
      } catch (err) {
        if (err.code === '42P01') {
          // undefined_table — this Diamond install never created it.
          // Recorded, not fatal: archive tables are never loaded.
          skips.push({ file: `${table}.json`, reason: `table does not exist at source: ${err.message}` });
          info('archive table absent at source, recorded in skips', { table });
        } else {
          problems.push(`${table} (archive): query failed — ${err.message}`);
        }
        continue;
      }
      const entry = await writeJsonWithHash(OUT_DIR, `${table}.json`, rows);
      files[`${table}.json`] = { ...entry, required: false, purpose: 'archive' };
      info('dumped (archive)', { table, rows: entry.rows });
    }

    await client.query('COMMIT'); // read-only txn; COMMIT just closes it
  } finally {
    client.release();
    await sourcePool.end();
  }

  if (problems.length > 0) {
    // No manifest gets written on this path — downstream stages
    // refuse to run without one, so a broken dump is unusable by
    // construction, not by convention.
    throw new Error(
      `snapshot failed for ${problems.length} table(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  await writeManifest(OUT_DIR, {
    kind: 'source',
    source: { host: parseSourceHost(process.env.MOMENTUM_SOURCE_URL) },
    files,
    skips,
  });

  banner('01 snapshot source — complete');
  info('snapshot sealed', {
    out_dir: OUT_DIR,
    files: Object.keys(files).length,
    required_tables: REQUIRED_TABLES.length,
    archive_tables_dumped: ARCHIVE_TABLES.length - skips.filter((s) => s.file !== SETMORE_CSV).length,
    skips: skips.length,
    setmore_rows: setmoreEntry ? setmoreEntry.rows : 'SKIPPED',
  });
}

main().catch((err) => {
  console.error('snapshot failed:', err);
  process.exit(1);
});
