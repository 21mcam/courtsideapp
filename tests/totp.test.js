// TOTP + login throttle unit tests (platform console, migration 032).
// Pure functions — no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  verifyTotp,
} from '../src/lib/totp.js';
import { createLoginThrottle } from '../src/lib/loginThrottle.js';

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890"
// (SHA-1). Our codes are the low 6 digits of the RFC's 8-digit values.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('base32 round-trips arbitrary bytes', () => {
  for (const len of [0, 1, 5, 10, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255));
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI'); // RFC 4648 vector
});

test('TOTP matches RFC 6238 SHA-1 test vectors', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [t, code] of vectors) {
    assert.equal(hotp(RFC_SECRET, Math.floor(t / 30)), code, `t=${t}`);
  }
});

test('verifyTotp returns the matched step, tolerates ±1 step, rejects the rest', () => {
  const nowMs = 1111111109 * 1000;
  const step = Math.floor(1111111109 / 30);
  assert.equal(verifyTotp(RFC_SECRET, '081804', { nowMs }), step);
  // Code from the previous step is accepted (clock drift) and reports
  // ITS step, so single-use enforcement works on the right counter.
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), { nowMs }), step - 1);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), { nowMs }), null);
  assert.equal(verifyTotp(RFC_SECRET, '12345', { nowMs }), null);
  assert.equal(verifyTotp(RFC_SECRET, 'abcdef', { nowMs }), null);
  assert.equal(verifyTotp(RFC_SECRET, undefined, { nowMs }), null);
});

test('generated secrets fit the platform_admins CHECK and build an otpauth URI', () => {
  const s = generateTotpSecret();
  assert.match(s, /^[A-Z2-7]{16,}$/);
  const uri = otpauthUri({ secret: s, account: 'me@example.com' });
  assert.match(uri, /^otpauth:\/\/totp\/Courtside%20Platform%3Ame%40example\.com\?/);
  assert.match(uri, new RegExp(`secret=${s}`));
});

test('login throttle blocks after max failures per key, clears on success, expires', () => {
  const th = createLoginThrottle({ windowMs: 1000, maxFailures: 3 });
  const keys = ['ip:1', 'email:a@x.com'];
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(th.blockedFor(keys, t0), 0);
    th.recordFailure(keys, t0);
  }
  assert.ok(th.blockedFor(keys, t0) > 0);
  // Same email from another IP is still blocked (per-email key).
  assert.ok(th.blockedFor(['ip:2', 'email:a@x.com'], t0) > 0);
  // Window expiry unblocks.
  assert.equal(th.blockedFor(keys, t0 + 1001), 0);
  // Clear resets immediately.
  for (let i = 0; i < 3; i += 1) th.recordFailure(keys, t0);
  th.clear(keys);
  assert.equal(th.blockedFor(keys, t0), 0);
});
