/**
 * CSRF Protection — Double-Submit Cookie Pattern
 *
 * How it works:
 *   1. GET /api/csrf-token
 *      Generates a cryptographically random token, sets it as an HttpOnly
 *      "csrf-token" cookie, and returns it in the response body.
 *      The frontend stores the body value and re-sends it as the
 *      X-CSRF-Token request header on every state-changing request.
 *
 *   2. verifyCsrf middleware
 *      For POST / PATCH / DELETE requests:
 *        - Reads the csrf-token cookie.
 *        - Reads the X-CSRF-Token request header.
 *        - Compares them with a constant-time comparison (timingSafeEqual).
 *        - Returns 403 if they do not match.
 *
 * Exemptions (requests that bypass CSRF verification):
 *   - Requests carrying a valid x-api-key header (server-to-server clients
 *     cannot hold a browser cookie, and they are already authenticated).
 *   - WebSocket upgrade requests (the Upgrade header is present).
 *   - GET / HEAD / OPTIONS requests (safe, idempotent methods — not mutating).
 *
 * Cookie attributes:
 *   HttpOnly  – prevents client-side script access (XSS hardening)
 *   SameSite  – "Strict" in production, "Lax" in development
 *   Secure    – true when NODE_ENV === "production"
 *   Path      – "/"
 *   MaxAge    – 86 400 seconds (1 day)
 *
 * Token format: 32 random bytes encoded as a 64-character hex string.
 */

import crypto from 'crypto';

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'csrf-token';
const HEADER_NAME = 'x-csrf-token';
const TOKEN_BYTES = 32;
const TOKEN_MAX_AGE = 86_400; // seconds — 1 day

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random CSRF token (hex string, 64 chars).
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Parse a raw Cookie header string into a key→value map.
 * Falls back gracefully to an empty object on malformed input.
 *
 * @param {string|undefined} header  e.g. "name=value; other=val2"
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of String(header).split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

/**
 * Read a named cookie from the request.
 * Works whether or not cookie-parser middleware is installed.
 *
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string|undefined}
 */
function getCookie(req, name) {
  // cookie-parser sets req.cookies; fall back to raw header parsing.
  if (req.cookies && typeof req.cookies[name] === 'string') {
    return req.cookies[name];
  }
  return parseCookies(req.headers['cookie'])?.[name];
}

/**
 * Constant-time string comparison to prevent timing-based token leakage.
 * Returns true when a === b.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  // Lengths must be equal for timingSafeEqual; if they differ the tokens are
  // definitely not the same — still avoid short-circuit leaking which arg was
  // shorter by padding to max length before comparing.
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    // Run the comparison anyway on equal-length copies to normalise timing.
    const padded = Buffer.alloc(Math.max(bufA.length, bufB.length));
    bufA.copy(padded, 0, 0, bufA.length);
    crypto.timingSafeEqual(padded, padded); // constant-time no-op
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build the Set-Cookie options for the CSRF token cookie.
 * @returns {object}  Express res.cookie options
 */
function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: isProd ? 'Strict' : 'Lax',
    secure: isProd,
    path: '/',
    maxAge: TOKEN_MAX_AGE * 1000, // Express expects milliseconds
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * GET /api/csrf-token
 *
 * Issues a fresh CSRF token.  The token is stored as an HttpOnly cookie
 * AND returned in the JSON body so the frontend can attach it as a header.
 *
 * @type {import('express').RequestHandler}
 */
function csrfTokenHandler(req, res) {
  // Re-use an existing valid cookie when present so that multiple in-flight
  // requests that all hit this endpoint do not invalidate each other's tokens.
  const existing = getCookie(req, COOKIE_NAME);
  const token = typeof existing === 'string' && existing.length === TOKEN_BYTES * 2
    ? existing
    : generateToken();

  res.cookie(COOKIE_NAME, token, cookieOptions());
  return res.json({ csrfToken: token });
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Verify CSRF token for POST / PATCH / DELETE requests using the
 * double-submit cookie pattern.
 *
 * Exemptions:
 *   - x-api-key header present (machine-to-machine, already authenticated)
 *   - Upgrade: websocket header present (WebSocket handshake)
 *   - GET / HEAD / OPTIONS (safe methods)
 *
 * @type {import('express').RequestHandler}
 */
function verifyCsrf(req, res, next) {
  const method = req.method.toUpperCase();

  // Safe / non-mutating methods — skip.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  // API-key-authenticated requests — skip (machine-to-machine).
  if (req.headers['x-api-key']) {
    return next();
  }

  // WebSocket upgrade requests — skip.
  const upgrade = req.headers['upgrade'];
  if (upgrade && upgrade.toLowerCase() === 'websocket') {
    return next();
  }

  // Retrieve cookie and header values.
  const cookieToken = getCookie(req, COOKIE_NAME);
  const headerToken = req.headers[HEADER_NAME];

  if (!cookieToken || !headerToken) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  if (!safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }

  return next();
}

export { csrfTokenHandler, verifyCsrf, generateToken, COOKIE_NAME, HEADER_NAME };
