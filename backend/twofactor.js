'use strict';

/**
 * Two-factor authentication (TOTP, RFC 6238) and CSRF protection for RZ Dispatch.
 *
 * - TOTP uses a 20-byte base32 secret, 6 digits, 30-second period, SHA-1 — the
 *   defaults every authenticator app (Google Authenticator, Authy, 1Password,
 *   微软, etc.) understands. Drift of +/- 1 step is tolerated.
 * - Backup codes are single-use, hashed at rest (sha256) and only shown once.
 * - CSRF is a stateless double-submit token: an HMAC of the caller's session
 *   identifier (or user id), sent in an `x-csrf-token` header by the SPA. The
 *   server recomputes it and compares in constant time. GET/HEAD/OPTIONS are
 *   exempt because they must not mutate state.
 *
 * Everything here is dependency-free so the backend keeps running with only
 * the packages it already ships.
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD = 30;
const SECRET_BYTES = 20;
const BACKUP_CODE_COUNT = 10;
const CSRF_TTL_MS = 12 * 60 * 60 * 1000;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** DIGITS;
  return String(otp).padStart(DIGITS, '0');
}

/** Current TOTP for a secret, optionally offset by N periods (for tests). */
function generateToken(secret, { timestamp = Date.now(), stepOffset = 0 } = {}) {
  const counter = Math.floor(timestamp / 1000 / PERIOD) + stepOffset;
  return hotp(secret, counter);
}

/**
 * Verify a submitted TOTP. Accepts the current step and +/- 1 step so a mildly
 * skewed device clock still works. Comparison is constant-time.
 */
function verifyToken(secret, token, { window = 1, timestamp = Date.now() } = {}) {
  const submitted = String(token || '').replace(/\D/g, '');
  if (submitted.length !== DIGITS) return false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateToken(secret, { timestamp, stepOffset: offset });
    if (timingSafeEqual(expected, submitted)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** otpauth:// URI that authenticator apps can scan from a QR code. */
function otpauthUrl(secret, email, issuer = 'RZ Dispatch') {
  const label = encodeURIComponent(`${issuer}:${email || 'account'}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** Create a fresh set of one-time backup codes plus their hashes for storage. */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  const hashes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    codes.push(formatted);
    hashes.push(hashBackupCode(formatted));
  }
  return { codes, hashes };
}

/** Consume a backup code: returns the remaining hashes if it matched. */
function consumeBackupCode(submitted, hashes) {
  const normalized = hashBackupCode(String(submitted || '').trim().toUpperCase());
  const remaining = [];
  let matched = false;
  for (const hash of Array.isArray(hashes) ? hashes : []) {
    if (!matched && timingSafeEqual(hash, normalized)) {
      matched = true;
      continue;
    }
    remaining.push(hash);
  }
  return { matched, remaining };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Stateless CSRF tokens: an HMAC binding a session key to a coarse time window.
 * The SPA sends the value back in `x-csrf-token`; the server recomputes it.
 */
function createCsrfToken(secret, sessionKey, { timestamp = Date.now() } = {}) {
  const bucket = Math.floor(timestamp / CSRF_TTL_MS);
  const signature = crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${sessionKey}:${bucket}`)
    .digest('hex');
  return `${bucket}.${signature}`;
}

function verifyCsrfToken(secret, sessionKey, token, { timestamp = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const bucket = Number(parts[0]);
  if (!Number.isFinite(bucket)) return false;
  const current = Math.floor(timestamp / CSRF_TTL_MS);
  // Accept the current bucket and the previous one so a token minted right
  // before a window boundary is not rejected mid-flight.
  for (const candidate of [current, current - 1]) {
    if (bucket !== candidate) continue;
    const expected = crypto
      .createHmac('sha256', String(secret || ''))
      .update(`${sessionKey}:${candidate}`)
      .digest('hex');
    if (timingSafeEqual(expected, parts[1])) return true;
  }
  return false;
}

module.exports = {
  DIGITS,
  PERIOD,
  BASE32_ALPHABET,
  base32Encode,
  base32Decode,
  generateSecret,
  generateToken,
  verifyToken,
  otpauthUrl,
  hashBackupCode,
  generateBackupCodes,
  consumeBackupCode,
  parseJsonArray,
  createCsrfToken,
  verifyCsrfToken
};
