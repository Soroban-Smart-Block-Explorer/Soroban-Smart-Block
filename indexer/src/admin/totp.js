/**
 * RFC 6238 TOTP helpers (HMAC-SHA1, 30s step, 6 digits).
 * Secrets are expected as base32 (authenticator-app compatible).
 */

import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 string (ignores spaces/padding; case-insensitive).
 * @param {string} input
 * @returns {Buffer}
 */
function decodeBase32(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = '';
  for (const ch of cleaned) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) {
      throw new Error('Invalid base32 character');
    }
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate a TOTP code for a given counter (or unix time).
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} [digits=6]
 * @returns {string}
 */
function hotp(key, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, '0');
}

/**
 * Generate the current TOTP code for a base32 secret.
 * @param {string} base32Secret
 * @param {{ step?: number, digits?: number, now?: number }} [opts]
 * @returns {string}
 */
function generateTotp(base32Secret, opts = {}) {
  const step = opts.step ?? 30;
  const digits = opts.digits ?? 6;
  const now = opts.now ?? Date.now();
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(now / 1000 / step);
  return hotp(key, counter, digits);
}

/**
 * Verify a TOTP code against a base32 secret with a ±window step allowance.
 * @param {string} base32Secret
 * @param {string} code
 * @param {{ step?: number, digits?: number, window?: number, now?: number }} [opts]
 * @returns {boolean}
 */
function verifyTotp(base32Secret, code, opts = {}) {
  if (code == null || typeof code !== 'string') {
    return false;
  }
  const trimmed = code.trim();
  const digits = opts.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) {
    return false;
  }

  const step = opts.step ?? 30;
  const window = opts.window ?? 1;
  const now = opts.now ?? Date.now();

  let key;
  try {
    key = decodeBase32(base32Secret);
  } catch {
    return false;
  }

  const counter = Math.floor(now / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(key, counter + w, digits);
    const a = Buffer.from(expected);
    const b = Buffer.from(trimmed);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

export { decodeBase32, generateTotp, verifyTotp };
