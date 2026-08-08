// Manifest helpers — the fail-closed backbone of the migration pipeline.
//
// Every stage writes a manifest describing exactly what it produced
// (file → row count + sha256), and every downstream stage REFUSES to
// run unless the manifest it depends on exists, parses, and matches
// the bytes on disk. A dataset that silently went missing between
// stages becomes a hard error instead of an empty import that
// "verifies" clean.
//
// Three manifest kinds flow through the pipeline:
//
//   out/source/manifest.json        written by 01_snapshot_source
//   out/transformed/manifest.json   written by 02_transform
//   out/load_report.json            written by 03_load
//
// All share { manifest_version, kind, created_at } and a `files` map
// for the JSON/CSV artifacts they cover. The transformed manifest
// additionally carries `expected` (the reconciliation numbers
// 05_verify checks the live DB against) and `blockers` (conditions
// that must be resolved — or explicitly acknowledged via
// MIGRATION_ACK_BLOCKERS — before load/verify will proceed).

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';

export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

// Serialize `data` to <dir>/<name> and return the manifest entry for
// it: { rows, sha256 }. `rows` is the array length, or 1 for a single
// object — callers dumping non-array payloads get an explicit count.
//
// Hash/byte consistency: we hash the exact string we write, and
// writeFile encodes that string to UTF-8 — the very bytes sha256File
// and readVerified will hash later. String-hash here and byte-hash
// there therefore always agree for files written by this function.
export async function writeJsonWithHash(dir, name, data) {
  const path = join(dir, name);
  const text = JSON.stringify(data, null, 2);
  await writeFile(path, text);
  return {
    rows: Array.isArray(data) ? data.length : 1,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

// Write <dir>/manifest.json. Stamps version + created_at; the caller
// provides kind, files, and any stage-specific fields.
export async function writeManifest(dir, manifest) {
  const full = {
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    ...manifest,
  };
  await writeFile(join(dir, MANIFEST_NAME), JSON.stringify(full, null, 2));
  return full;
}

// Read <dir>/manifest.json or throw. A missing manifest means the
// upstream stage never completed — refusing here is the point.
export async function readManifest(dir, expectedKind) {
  const path = join(dir, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `manifest missing: ${path} — run the upstream stage first; ` +
          `the pipeline does not proceed without it`,
      );
    }
    throw err;
  }
  const manifest = JSON.parse(raw);
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    throw new Error(
      `manifest version mismatch at ${path}: ` +
        `got ${manifest.manifest_version}, want ${MANIFEST_VERSION}`,
    );
  }
  if (expectedKind && manifest.kind !== expectedKind) {
    throw new Error(
      `manifest kind mismatch at ${path}: got ${JSON.stringify(manifest.kind)}, want ${JSON.stringify(expectedKind)}`,
    );
  }
  return manifest;
}

// Throw (listing every gap at once) unless the manifest covers all of
// `names`. Use before touching any file so the operator sees the full
// shortfall, not the first one.
export function requireFiles(manifest, names) {
  const missing = names.filter((n) => !manifest.files?.[n]);
  if (missing.length > 0) {
    throw new Error(
      `manifest is missing required dataset(s): ${missing.join(', ')} — ` +
        `refusing to continue with a partial source`,
    );
  }
}

// Read <dir>/<name>, confirm it is listed in the manifest and its
// bytes still hash to the recorded sha256, then return the parsed
// JSON (or raw text when `raw: true`, e.g. for CSV). Any mismatch —
// unlisted file, missing file, checksum drift — throws.
//
// The hash runs over the RAW BYTES, exactly like sha256File did when
// the manifest was written. Hashing a UTF-8-decoded string instead
// would turn any non-UTF-8 byte (e.g. a Windows-1252 CSV) into U+FFFD
// and raise a false tamper error on a byte-identical file.
export async function readVerified(dir, manifest, name, { raw = false } = {}) {
  const entry = manifest.files?.[name];
  if (!entry) {
    throw new Error(
      `${name} is not listed in the manifest — refusing to read an untracked input`,
    );
  }
  const path = join(dir, name);
  let buf;
  try {
    buf = await readFile(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `${name} is in the manifest but missing on disk (${path}) — ` +
          `the snapshot directory has been tampered with or partially deleted`,
      );
    }
    throw err;
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(
      `${name} checksum mismatch: manifest ${entry.sha256}, disk ${actual} — ` +
        `file changed since the manifest was written`,
    );
  }
  const text = buf.toString('utf-8');
  return raw ? text : JSON.parse(text);
}

// Blocker gate. `blockers` is the manifest's array of
// { code, count, detail_file } objects. Codes listed in the
// MIGRATION_ACK_BLOCKERS env var (comma-separated) are treated as
// operator-acknowledged; anything else aborts. Returns the array of
// acknowledged codes so the caller can record them in its own output.
export function enforceBlockers(blockers, envValue = process.env.MIGRATION_ACK_BLOCKERS) {
  const list = Array.isArray(blockers) ? blockers : [];
  if (list.length === 0) return [];
  const acked = new Set(
    (envValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const unacked = list.filter((b) => !acked.has(b.code));
  if (unacked.length > 0) {
    const lines = unacked
      .map((b) => `  - ${b.code} (${b.count}) — see ${b.detail_file}`)
      .join('\n');
    throw new Error(
      `unresolved migration blockers:\n${lines}\n` +
        `Resolve them at the source, or acknowledge deliberately with ` +
        `MIGRATION_ACK_BLOCKERS=<code,...> after recording the operational ` +
        `plan in the runbook.`,
    );
  }
  return list.map((b) => b.code);
}
