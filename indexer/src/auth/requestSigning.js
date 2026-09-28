/**
 * Issue #852 — HMAC request signing + replay protection for mutating routes.
 *
 * Clients send:
 *   X-SSB-Key-Id     id of the API key the signing secret belongs to
 *   X-SSB-Timestamp  unix seconds
 *   X-SSB-Nonce      unique per request (16–128 chars)
 *   X-SSB-Signature  hex HMAC-SHA256(secret, METHOD \n PATH \n SHA256(body) \n timestamp \n nonce)
 *
 * PATH is the request path including the query string, exactly as sent.
 * SHA256(body) is computed over the raw request bytes, so clients must send
 * exactly the bytes they signed (a proxy that re-serializes JSON breaks it).
 *
 * SIGNING_ENFORCED=off (default) → unsigned requests pass but are audited as
 * `signing_missing`; SIGNING_ENFORCED=on → unsigned requests get 401.
 * A request that *does* carry signing headers is always fully verified.
 */

import crypto from "node:crypto";
import { pool } from "../db.js";
import config from "../config.js";
import { logger } from "../logger.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SIGNED_PATH = /^\/api\/(contracts|admin|abi)(\/|$|\?)/;
const SECRET_CACHE_MS = 30_000;
const MAX_ACTIVE_SECRETS = 2;

export const SIGNING_HEADERS = {
  keyId: "x-ssb-key-id",
  timestamp: "x-ssb-timestamp",
  nonce: "x-ssb-nonce",
  signature: "x-ssb-signature",
};

export function sha256Hex(data) {
  return crypto
    .createHash("sha256")
    .update(data ?? "")
    .digest("hex");
}

/** The exact string that is HMAC'd. */
export function canonicalString(method, path, rawBody, timestamp, nonce) {
  return [String(method).toUpperCase(), path, sha256Hex(rawBody), String(timestamp), nonce].join("\n");
}

export function signRequest(secret, { method, path, body, timestamp, nonce }) {
  return crypto.createHmac("sha256", secret).update(canonicalString(method, path, body, timestamp, nonce)).digest("hex");
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing independent of the length mismatch
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Pure verification core. Storage is injected so it can be unit-tested.
 *
 * @param {object} p
 * @param {Record<string,string|undefined>} p.headers  lower-cased header map
 * @param {string} p.method
 * @param {string} p.path
 * @param {Buffer|string} p.rawBody
 * @param {number} p.nowSec
 * @param {number} p.skewSec
 * @param {(keyId: string) => Promise<string[]>} p.getSecrets  active secrets (≤ 2 during rotation)
 * @param {(keyId: string, nonce: string, ttlSec: number) => Promise<boolean>} p.claimNonce  atomic; false if seen
 * @returns {Promise<{ ok: true, keyId: string, nonce: string } | { ok: false, status: number, error: string, server_time?: number }>}
 */
export async function verifySignedRequest({ headers, method, path, rawBody, nowSec, skewSec, getSecrets, claimNonce }) {
  const keyId = headers[SIGNING_HEADERS.keyId];
  const timestamp = headers[SIGNING_HEADERS.timestamp];
  const nonce = headers[SIGNING_HEADERS.nonce];
  const signature = headers[SIGNING_HEADERS.signature];

  if (!keyId || !timestamp || !nonce || !signature) {
    return { ok: false, status: 401, error: "signature_missing" };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return { ok: false, status: 400, error: "invalid_nonce" };
  }
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > skewSec) {
    return { ok: false, status: 401, error: "stale_timestamp", server_time: nowSec };
  }

  const secrets = await getSecrets(keyId);
  const valid = secrets.some((secret) =>
    safeEqualHex(signRequest(secret, { method, path, body: rawBody, timestamp, nonce }), String(signature).toLowerCase()),
  );
  if (!valid) return { ok: false, status: 401, error: "invalid_signature" };

  // Claim the nonce only after the signature checks out, so unauthenticated
  // callers cannot burn other clients' nonces.
  if (!(await claimNonce(keyId, nonce, skewSec * 2))) {
    return { ok: false, status: 409, error: "nonce_reused" };
  }
  return { ok: true, keyId, nonce };
}

// ── Postgres-backed storage ───────────────────────────────────────────────────

const secretCache = new Map(); // keyId → { secrets, at }

async function getActiveSecrets(keyId) {
  const hit = secretCache.get(keyId);
  if (hit && Date.now() - hit.at < SECRET_CACHE_MS) return hit.secrets;
  const { rows } = await pool.query(
    `SELECT secret FROM api_key_signing_secrets
     WHERE key_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT ${MAX_ACTIVE_SECRETS}`,
    [keyId],
  );
  const secrets = rows.map((r) => r.secret);
  secretCache.set(keyId, { secrets, at: Date.now() });
  return secrets;
}

async function claimNonceDb(keyId, nonce, ttlSec) {
  const { rowCount } = await pool.query(
    `INSERT INTO used_nonces (key_id, nonce, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)
     ON CONFLICT (key_id, nonce) DO NOTHING`,
    [keyId, nonce, String(ttlSec)],
  );
  return rowCount === 1;
}

/** Evict expired nonces — keeps the store bounded. */
export async function pruneNonces() {
  await pool.query(`DELETE FROM used_nonces WHERE expires_at < NOW()`);
}

/**
 * Create a new signing secret for an API key. Returned once, never again.
 * Keeps at most two active secrets (rotation overlap) by revoking older ones.
 */
export async function createSigningSecret(keyId) {
  const secret = crypto.randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO api_key_signing_secrets (key_id, secret) VALUES ($1, $2)`, [keyId, secret]);
  await pool.query(
    `UPDATE api_key_signing_secrets SET revoked_at = NOW()
     WHERE key_id = $1 AND revoked_at IS NULL
       AND id NOT IN (
         SELECT id FROM api_key_signing_secrets WHERE key_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT ${MAX_ACTIVE_SECRETS}
       )`,
    [keyId],
  );
  secretCache.delete(keyId);
  return secret;
}

function audit(req, outcome, { keyId = null, nonce = null, reason = null } = {}) {
  pool
    .query(
      `INSERT INTO signed_request_audit (outcome, reason, key_id, nonce, ip, method, path, body_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [outcome, reason, keyId, nonce, req.ip ?? null, req.method, req.originalUrl, sha256Hex(req.rawBody)],
    )
    .catch((err) => logger.error({ err: err.message }, "[signing] audit write failed"));
}

let lastPrune = 0;

/** Express middleware — mount after express.json({ verify }) captures req.rawBody. */
export async function requestSigningMiddleware(req, res, next) {
  if (!MUTATING.has(req.method) || !SIGNED_PATH.test(req.originalUrl)) return next();

  const headers = Object.fromEntries(Object.values(SIGNING_HEADERS).map((h) => [h, req.headers[h]]));
  const unsigned = !headers[SIGNING_HEADERS.signature] && !headers[SIGNING_HEADERS.keyId];
  if (unsigned && config.SIGNING_ENFORCED !== "on") {
    audit(req, "signing_missing");
    return next();
  }

  if (Date.now() - lastPrune > 60_000) {
    lastPrune = Date.now();
    pruneNonces().catch(() => {});
  }

  try {
    const result = await verifySignedRequest({
      headers,
      method: req.method,
      path: req.originalUrl,
      rawBody: req.rawBody ?? "",
      nowSec: Math.floor(Date.now() / 1000),
      skewSec: config.SIGN_SKEW,
      getSecrets: getActiveSecrets,
      claimNonce: claimNonceDb,
    });
    if (result.ok && req.rateContext?.keyId && String(req.rateContext.keyId) !== result.keyId) {
      audit(req, "rejected", { keyId: result.keyId, nonce: result.nonce, reason: "key_mismatch" });
      return res.status(401).json({ error: "key_mismatch" });
    }
    if (!result.ok) {
      audit(req, "rejected", { keyId: headers[SIGNING_HEADERS.keyId] ?? null, reason: result.error });
      const { ok: _ok, status, ...body } = result;
      return res.status(status).json(body);
    }
    audit(req, "signed_ok", { keyId: result.keyId, nonce: result.nonce });
    req.signedKeyId = result.keyId;
    return next();
  } catch (err) {
    logger.error({ err: err.message }, "[signing] verification failed");
    return res.status(503).json({ error: "signature_verification_unavailable" });
  }
}
