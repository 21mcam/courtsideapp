// RFC 6238 TOTP (the 6-digit authenticator-app code), used as the
// second factor on the platform console login. Hand-rolled on
// node:crypto rather than a dependency: it's ~40 lines, the RFC test
// vectors pin it (tests/totp.test.js), and the platform login is the
// one place a supply-chain compromise would hurt most.
//
// Parameters are the authenticator-app defaults (SHA-1, 6 digits,
// 30-second step) — anything else and Google Authenticator / 1Password
// silently generate the wrong codes.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret, the RFC 4226 recommended length.
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

// Returns the matched time-step (so the caller can enforce single
// use) or null. Accepts one step either side of now for clock drift.
export function verifyTotp(secretBase32, code, { nowMs = Date.now(), window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = currentStep(nowMs);
  for (let d = -window; d <= window; d += 1) {
    const expected = hotp(secretBase32, step + d);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return step + d;
    }
  }
  return null;
}

export function otpauthUri({ secret, account, issuer = 'Courtside Platform' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
