/**
 * Key Manager — Admin Service Layer
 *
 * Business-logic functions for managing api_keys records.
 * These are pure service functions (not Express route handlers).
 *
 * All functions throw on validation failure or unexpected DB errors.
 * Callers (route handlers) are responsible for mapping errors to HTTP responses.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BCRYPT_COST = 12;
const VALID_TIERS = ['unauthenticated', 'free', 'pro', 'enterprise'];
const UPDATABLE_FIELDS = [
  'name',
  'tier',
  'rate_limit',
  'daily_limit',
  'allowed_ips',
  'allowed_endpoints',
  'expires_at',
  'revoked',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random API key as URL-safe base64.
 * 32 bytes → 43 characters (no padding).
 * @returns {string}
 */
function generateRawKey() {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Strip `key_hash` from a database row before returning it to callers.
 * @param {object} row
 * @returns {object}
 */
function stripKeyHash(row) {
  if (!row) return row;
  const { key_hash, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}

// ── listKeys ──────────────────────────────────────────────────────────────────

/**
 * Return a paginated list of API keys (excluding `key_hash`).
 *
 * @param {number} [page=1]
 * @param {number} [limit=50]
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number }>}
 */
async function listKeys(page = 1, limit = 50) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
  const offset = (safePage - 1) * safeLimit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT id, name, key_prefix, tier, rate_limit, daily_limit,
              allowed_ips, allowed_endpoints, expires_at,
              revoked, last_used_at, usage_count, created_at, updated_at
       FROM api_keys
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, offset],
    ),
    pool.query('SELECT COUNT(*)::INT AS total FROM api_keys'),
  ]);

  return {
    data: rows,
    total: countRows[0].total,
    page: safePage,
    limit: safeLimit,
  };
}

// ── createKey ─────────────────────────────────────────────────────────────────

/**
 * Create a new API key.
 *
 * @param {object} data
 * @param {string} data.name            — required, non-empty
 * @param {string} [data.tier='free']
 * @param {number} [data.rate_limit]
 * @param {string[]} [data.allowed_ips]
 * @param {string[]} [data.allowed_endpoints]
 * @param {string} [data.expires_at]   — ISO-8601 timestamp
 * @returns {Promise<{ key: string, record: object }>}
 */
async function createKey(data) {
  const { name, tier = 'free', rate_limit, daily_limit, allowed_ips, allowed_endpoints, expires_at } = data ?? {};

  // Validate required fields.
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('name is required and must be a non-empty string');
  }

  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`tier must be one of: ${VALID_TIERS.join(', ')}`);
  }

  if (rate_limit !== undefined && rate_limit !== null) {
    const rateNum = Number(rate_limit);
    if (!Number.isInteger(rateNum) || rateNum <= 0) {
      throw new Error('rate_limit must be a positive integer');
    }
  }

  if (data?.daily_limit !== undefined && data?.daily_limit !== null) {
    const dailyLimit = Number(data.daily_limit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0) {
      throw new Error('daily_limit must be a non-negative integer');
    }
  }

  // Generate key material.
  const rawKey = generateRawKey();
  const keyPrefix = rawKey.slice(0, 8);
  const keyHash = await bcrypt.hash(rawKey, BCRYPT_COST);

  const { rows } = await pool.query(
    `INSERT INTO api_keys
       (name, key_hash, key_prefix, tier, rate_limit, daily_limit, allowed_ips, allowed_endpoints, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, name, key_prefix, tier, rate_limit, daily_limit,
               allowed_ips, allowed_endpoints, expires_at,
               revoked, last_used_at, usage_count, created_at, updated_at`,
    [
      name.trim(),
      keyHash,
      keyPrefix,
      tier,
      rate_limit ?? null,
      daily_limit ?? null,
      allowed_ips ? JSON.stringify(allowed_ips) : null,
      allowed_endpoints ? JSON.stringify(allowed_endpoints) : null,
      expires_at ?? null,
    ],
  );

  return { key: rawKey, record: rows[0] };
}

// ── updateKey ─────────────────────────────────────────────────────────────────

/**
 * Update allowed metadata fields on an existing key.
 *
 * @param {string} id   — UUID
 * @param {object} updates — subset of updatable fields
 * @returns {Promise<object>} updated record (without key_hash)
 */
async function updateKey(id, updates) {
  if (!id) throw new Error('id is required');
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('updates must be a non-null object');
  }

  // Filter to only allowed fields to prevent injection.
  const filtered = {};
  for (const field of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      filtered[field] = updates[field];
    }
  }

  if (Object.keys(filtered).length === 0) {
    throw new Error(`No updatable fields provided. Allowed fields: ${UPDATABLE_FIELDS.join(', ')}`);
  }

  // Validate tier if provided.
  if (filtered.tier !== undefined && !VALID_TIERS.includes(filtered.tier)) {
    throw new Error(`tier must be one of: ${VALID_TIERS.join(', ')}`);
  }

  // Build SET clause dynamically.
  const setClauses = [];
  const params = [];

  for (const [field, value] of Object.entries(filtered)) {
    params.push(value);
    setClauses.push(`${field} = $${params.length}`);
  }

  // Always bump updated_at.
  setClauses.push(`updated_at = NOW()`);

  params.push(id);
  const idParam = params.length;

  const { rows } = await pool.query(
    `UPDATE api_keys
     SET ${setClauses.join(', ')}
     WHERE id = $${idParam}
     RETURNING id, name, key_prefix, tier, rate_limit, daily_limit,
               allowed_ips, allowed_endpoints, expires_at,
               revoked, last_used_at, usage_count, created_at, updated_at`,
    params,
  );

  if (rows.length === 0) {
    throw new Error(`API key not found: ${id}`);
  }

  return stripKeyHash(rows[0]);
}

// ── deleteKey ─────────────────────────────────────────────────────────────────

/**
 * Soft-delete a key by setting revoked = true.
 *
 * @param {string} id — UUID
 * @returns {Promise<object>} updated record (without key_hash)
 */
async function deleteKey(id) {
  if (!id) throw new Error('id is required');

  const { rows } = await pool.query(
    `UPDATE api_keys
     SET revoked = TRUE, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, key_prefix, tier, rate_limit, daily_limit,
               allowed_ips, allowed_endpoints, expires_at,
               revoked, last_used_at, usage_count, created_at, updated_at`,
    [id],
  );

  if (rows.length === 0) {
    throw new Error(`API key not found: ${id}`);
  }

  return stripKeyHash(rows[0]);
}

// ── rotateKey ─────────────────────────────────────────────────────────────────

/**
 * Generate a new raw key for an existing record, replacing key_hash and key_prefix.
 *
 * @param {string} id — UUID
 * @returns {Promise<{ key: string, record: object }>}
 */
async function rotateKey(id) {
  if (!id) throw new Error('id is required');

  // Grace window length (minutes) — default 60. Parse as integer and
  // coerce to >= 0. If 0, rotation_grace_until will be now (immediate expiry).
  const graceMinutes = Math.max(0, Number.parseInt(process.env.KEY_ROTATION_GRACE_MINUTES ?? '60', 10) || 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load the existing record to copy metadata.
    const { rows: existingRows } = await client.query(
      `SELECT name, tier, rate_limit, daily_limit, allowed_ips, allowed_endpoints, expires_at, verified
       FROM api_keys WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (existingRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`API key not found: ${id}`);
    }

    const existing = existingRows[0];

    // Generate new key material and insert a new row with the same metadata.
    const rawKey = generateRawKey();
    const keyPrefix = rawKey.slice(0, 8);
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_COST);

    const { rows: insertRows } = await client.query(
      `INSERT INTO api_keys
         (name, key_hash, key_prefix, tier, rate_limit, daily_limit, allowed_ips, allowed_endpoints, expires_at, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, name, key_prefix, tier, rate_limit, daily_limit,
                 allowed_ips, allowed_endpoints, expires_at,
                 revoked, last_used_at, usage_count, created_at, updated_at`,
      [
        existing.name,
        keyHash,
        keyPrefix,
        existing.tier,
        existing.rate_limit ?? null,
        existing.daily_limit ?? null,
        existing.allowed_ips ?? null,
        existing.allowed_endpoints ?? null,
        existing.expires_at ?? null,
        existing.verified ?? null,
      ],
    );

    // Compute rotation_grace_until timestamp (ISO string) or null.
    const rotationGraceUntil = new Date(Date.now() + graceMinutes * 60_000).toISOString();

    // Mark the old row as revoked and set rotation timestamps.
    await client.query(
      `UPDATE api_keys
       SET revoked = TRUE,
           rotated_at = NOW(),
           rotation_grace_until = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [rotationGraceUntil, id],
    );

    await client.query('COMMIT');

    return { key: rawKey, record: stripKeyHash(insertRows[0]) };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
}

// ── getKeyUsage ───────────────────────────────────────────────────────────────

/**
 * Return daily usage history for a key.
 *
 * @param {string} id  — UUID
 * @param {number} [days=30]
 * @returns {Promise<object[]>}
 */
async function getKeyUsage(id) {
  if (!id) throw new Error('id is required');

  const { rows: keyRows } = await pool.query(
    `SELECT daily_limit
     FROM api_keys
     WHERE id = $1`,
    [id],
  );

  const dailyLimit = Number(keyRows[0]?.daily_limit ?? 0);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN date = ((NOW() AT TIME ZONE 'UTC')::DATE) THEN request_count ELSE 0 END), 0)::INT AS today,
            COALESCE(SUM(request_count), 0)::INT AS this_month,
            $2::INT AS limit_daily
     FROM api_key_usage
     WHERE api_key_id = $1
       AND date >= date_trunc('month', NOW() AT TIME ZONE 'UTC')::DATE`,
    [id, dailyLimit],
  );

  return rows[0] ?? { today: 0, this_month: 0, limit_daily: 0 };
}

export { listKeys, createKey, updateKey, deleteKey, rotateKey, getKeyUsage };
