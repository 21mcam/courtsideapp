#!/usr/bin/env node
// Create a platform console login (migration 032).
//
//   node scripts/platform/create-admin.js you@example.com "Your Name"
//
// Prompts for a password (not echoed), generates a TOTP secret, and
// PRINTS the SQL to run in the Supabase SQL editor — it never connects
// to a database. That keeps the privileged write in the same place as
// every migration (by hand, as the DDL role) and means this script
// needs no credentials at all.
//
// Then add the secret to your authenticator app (1Password, Google
// Authenticator, Authy...): scan nothing, choose "enter a setup key",
// and paste the key — or open the otpauth:// link on a device that
// handles it.
//
// Re-running for the same email prints an upsert that REPLACES the
// password and TOTP secret (lost phone / forgotten password recovery).

import bcrypt from 'bcryptjs';

import { generateTotpSecret, otpauthUri } from '../../src/lib/totp.js';

function usage() {
  console.error('usage: node scripts/platform/create-admin.js <email> "<display name>"');
  process.exit(1);
}

// Piped input (scripted use): read all of stdin once, hand out lines
// in order. Re-reading a paused pipe per prompt loses buffered lines.
let pipedLines = null;
async function nextPipedLine() {
  if (pipedLines === null) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) buf += chunk;
    pipedLines = buf.split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

function promptHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  if (!stdin.isTTY) {
    return nextPipedLine().then((line) => {
      stdout.write('\n');
      return line;
    });
  }
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function sqlLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

const [emailArg, nameArg] = process.argv.slice(2);
if (!emailArg || !nameArg) usage();
const email = emailArg.trim().toLowerCase();
const displayName = nameArg.trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName) usage();

const password = await promptHidden('Password (min 12 chars): ');
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
const confirm = await promptHidden('Confirm password: ');
if (confirm !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
const secret = generateTotpSecret();

console.log(`
-- 1. Run this in the Supabase SQL editor (as postgres):

INSERT INTO platform_admins (email, display_name, password_hash, totp_secret)
VALUES (${sqlLiteral(email)}, ${sqlLiteral(displayName)}, ${sqlLiteral(hash)}, ${sqlLiteral(secret)})
ON CONFLICT (email) DO UPDATE
   SET display_name   = EXCLUDED.display_name,
       password_hash  = EXCLUDED.password_hash,
       totp_secret    = EXCLUDED.totp_secret,
       totp_last_step = NULL,
       active         = true;

-- 2. Add this setup key to your authenticator app (time-based, 6 digits):

--    ${secret.match(/.{1,4}/g).join(' ')}

--    or open: ${otpauthUri({ secret, account: email })}

-- 3. Sign in at https://admin.<APP_HOSTNAME> (dev: http://admin.localhost:5173).
--    Don't save this output anywhere — the setup key is a credential.
`);
