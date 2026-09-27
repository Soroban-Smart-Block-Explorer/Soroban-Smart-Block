import pg from "pg";
import { runMigrations } from "./migrate.js";
import { validateAndSanitizeDecodedEvent } from "./decoderValidator.js";
import { withSpan } from "./tracing.js";
import { getIndexerNetwork } from "./networkConfig.js";
import { decodeCursor, hashFilters, formatPageResponse } from "./cursor.js";
import config from "./config.js";
import { encryptSecret } from "./secrets/index.js";

// Migration 031 made `daemon_state` and `ledger_hashes` network-scoped:
// their primary keys are now (network, key) and (network, ledger). Every
// upsert below must therefore target the composite key, and every read is
// scoped to this indexer instance's network (NETWORK env var, default
// "testnet").

// BIGINT/BIGSERIAL (OID 20) columns — seq, ledger — are returned as JS
// strings by default to avoid silent precision loss above 2^53. Ledger and
// event sequence numbers stay well within that range, and the OpenAPI schema
// documents these fields as `integer`, so parse them as numbers.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const replicaPools = String(process.env.READ_REPLICA_DATABASE_URLS || process.env.DATABASE_READ_REPLICA_URLS || "")
  .split(",").map((url) => url.trim()).filter(Boolean).map((connectionString) => new pg.Pool({ connectionString }));
const replicaState = replicaPools.map((pool, index) => ({ pool, index, healthy: true, lagMs: 0, lastCheck: 0, replayLsn: null }));
let lastWriteLsn = null;

// Wrap every query in an OTel span (issue #755) so a request's trace shows
// DB timing alongside its RPC and cache hops. Only instruments the
// promise-based call signature (pool.query(text, params)), which is the
// only style used in this codebase.
const _rawQuery = pool.query.bind(pool);
const RLS_TABLES = /\b(?:contracts|contract_versions|contract_abi_versions|api_key_usage|api_key_usage_daily|api_audit_log)\b/i;
pool.query = (text, params) =>
  withSpan("db.query", async () => {
    const context = requestContext.getStore();
    if (typeof text !== "string" || !RLS_TABLES.test(text) || (!context?.apiKeyId && !context?.rlsBypass)) {
      return _rawQuery(text, params);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.api_key_id', $1, true), set_config('app.rls_bypass', $2, true)", [
        context.apiKeyId || "",
        context.rlsBypass ? "true" : "false",
      ]);
      const result = await client.query(text, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, {
    "db.system": "postgresql",
    "db.statement": typeof text === "string" ? text.slice(0, 200) : undefined,
  });

/** Exported for pool metric collection — do not use for queries outside db.js. */
export { pool };

export function getReplicaState() { return replicaState.map(({ pool: _pool, ...state }) => ({ ...state })); }

export async function getReadPool(requiredLsn = null) {
  for (const replica of replicaState) {
    try {
      const { rows } = await replica.pool.query("SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms, pg_last_wal_replay_lsn() AS replay_lsn");
      replica.lagMs = Number(rows[0]?.lag_ms) || 0;
      replica.replayLsn = rows[0]?.replay_lsn ?? null;
      replica.lastCheck = Date.now();
      replica.healthy = replica.lagMs <= Number(process.env.REPLICA_MAX_LAG_MS || 5000) && (!requiredLsn || !replica.replayLsn || String(replica.replayLsn) >= String(requiredLsn));
    } catch { replica.healthy = false; }
    if (replica.healthy) return replica.pool;
  }
  return pool;
}

export async function queryRead(text, params, options = {}) { return (await getReadPool(options.requiredLsn)).query(text, params); }
export function noteWriteLsn(lsn) { lastWriteLsn = lsn; return lastWriteLsn; }
export function getLastWriteLsn() { return lastWriteLsn; }

export const db = {
  query: (text, params) => pool.query(text, params),
  queryRead,
  getReplicaState,
  getLastWriteLsn,
  async getReplayRows(from, to) {
    const { rows } = await queryRead("SELECT * FROM events WHERE ledger BETWEEN $1 AND $2 ORDER BY ledger, seq", [from, to]);
    return rows;
  },
  async upsertTransaction(record) {
    const { rows } = await pool.query(`INSERT INTO transactions (hash, ledger, source, status, result_code, operation_count, footprint_read_bytes, footprint_write_bytes, fee_payer, inner_source, inclusion_fee, resource_fee, refundable_fee_charged, refund_amount, rent_fee, charged_fee, failure_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (hash) DO UPDATE SET ledger=EXCLUDED.ledger,status=EXCLUDED.status,result_code=EXCLUDED.result_code,charged_fee=EXCLUDED.charged_fee,failure_reason=EXCLUDED.failure_reason RETURNING *`, [record.hash, record.ledger, record.source, record.status, record.result_code, record.operation_count, record.footprint_read_bytes, record.footprint_write_bytes, record.fee_payer, record.inner_source, record.inclusion_fee, record.resource_fee, record.refundable_fee_charged, record.refund_amount, record.rent_fee, record.charged_fee, record.failure_reason]);
    try { const lsn = await pool.query("SELECT pg_current_wal_lsn() AS lsn"); noteWriteLsn(lsn.rows[0]?.lsn); } catch { /* non-Postgres test doubles */ }
    return rows[0];
  },
  async getTransaction(hash) { const { rows } = await queryRead("SELECT * FROM transactions WHERE hash = $1", [hash], { requiredLsn: lastWriteLsn }); return rows[0] ?? null; },
  async getAccountTransactions(account, limit = 50) { const { rows } = await queryRead("SELECT * FROM transactions WHERE source = $1 OR fee_payer = $1 ORDER BY ledger DESC LIMIT $2", [account, Math.min(Number(limit) || 50, 100)], { requiredLsn: lastWriteLsn }); return rows; },
  /** Run all pending SQL migrations from indexer/migrations/. */
  async init() {
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO daemon_state (network, key, value)
       VALUES ($1, 'cursor', '0'), ($1, 'last_indexed_ledger', '0')
       ON CONFLICT (network, key) DO NOTHING`,
      [getIndexerNetwork()],
    );
  },

  async getMaxLedger() {
    const { rows } = await pool.query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events");
    return Number(rows[0].max_ledger);
  },

  // ── daemon cursor persistence ──────────────────────────────────
  async saveDaemonState(key, value) {
    await pool.query(
      `INSERT INTO daemon_state (network, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (network, key) DO UPDATE SET value = $3`,
      [getIndexerNetwork(), key, String(value)],
    );
  },

  async saveCursor(ledger) {
    await this.saveDaemonState("cursor", ledger);
  },

  async loadCursor() {
    const { rows } = await pool.query("SELECT value FROM daemon_state WHERE network = $1 AND key = 'cursor'", [
      getIndexerNetwork(),
    ]);
    return rows[0] ? Number(rows[0].value) : null;
  },

  async saveLastIndexedLedger(ledger) {
    await this.saveDaemonState("last_indexed_ledger", ledger);
  },

  async getLastIndexedLedger() {
    const { rows } = await pool.query(
      "SELECT value FROM daemon_state WHERE network = $1 AND key = 'last_indexed_ledger'",
      [getIndexerNetwork()],
    );
    return rows[0] ? Number(rows[0].value) : 0;
  },

  // ── ledger reorganization state ───────────────────────────────
  async recordLedgerHash(ledger, hash) {
    await pool.query(
      `INSERT INTO ledger_hashes (network, ledger, hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (network, ledger) DO NOTHING`,
      [getIndexerNetwork(), ledger, hash],
    );
  },

  async getRecentLedgerHashes(limit) {
    const { rows } = await pool.query(
      "SELECT ledger, hash FROM ledger_hashes WHERE network = $1 ORDER BY ledger DESC LIMIT $2",
      [getIndexerNetwork(), limit],
    );
    return rows;
  },

  /** Atomically purge orphaned data and persist the daemon rewind cursor. */
  // ── Query jobs (#906) ─────────────────────────────────────────────────────

  async createQueryJob(job) {
    const { rows } = await pool.query(
      `INSERT INTO query_jobs (id, api_key_id, tier, type, params, format, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [job.id, job.apiKeyId, job.tier, job.type, job.params, job.format, job.idempotencyKey ?? null],
    );
    return rows[0] ?? null;
  },

  async getQueryJob(id) {
    const { rows } = await pool.query("SELECT * FROM query_jobs WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async getQueryJobByIdempotencyKey(apiKeyId, key) {
    const { rows } = await pool.query(
      "SELECT * FROM query_jobs WHERE api_key_id = $1 AND idempotency_key = $2",
      [apiKeyId, key],
    );
    return rows[0] ?? null;
  },

  async countActiveQueryJobs(apiKeyId) {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::INT AS n FROM query_jobs WHERE api_key_id = $1 AND status IN ('queued', 'running')",
      [apiKeyId],
    );
    return rows[0].n;
  },

  async updateQueryJob(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await pool.query(
      `UPDATE query_jobs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
      [id, ...keys.map((k) => fields[k])],
    );
  },

  async listQueryJobsByStatus(status) {
    const { rows } = await pool.query("SELECT id FROM query_jobs WHERE status = $1 ORDER BY created_at", [status]);
    return rows;
  },

  async listExpiredQueryJobs() {
    const { rows } = await pool.query(
      "SELECT id, result_path FROM query_jobs WHERE expires_at IS NOT NULL AND expires_at < now() AND status <> 'expired'",
    );
    return rows;
  },

  async isApiKeyActive(apiKeyId) {
    const { rows } = await pool.query(
      "SELECT 1 FROM api_keys WHERE id = $1 AND revoked = FALSE AND (expires_at IS NULL OR expires_at > now())",
      [apiKeyId],
    );
    return rows.length > 0;
  },

  /**
   * Stream events matching `filter` in `batchSize` pages from a single
   * REPEATABLE READ transaction, so the whole export is one consistent
   * snapshot even while the indexer keeps writing.
   */
  async *iterateEventsSnapshot({ contract, fromLedger, toLedger }, batchSize = 5_000) {
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let lastSeq = 0;
      while (true) {
        const { rows } = await client.query(
          `SELECT e.seq, e.ledger, e.contract_id, c.name AS contract_name, e.function,
                  e.description, e.tx_hash, e.created_at
           FROM events e LEFT JOIN contracts c ON c.id = e.contract_id
           WHERE e.seq > $1
             AND ($2::TEXT IS NULL OR e.contract_id = $2)
             AND ($3::BIGINT IS NULL OR e.ledger >= $3)
             AND ($4::BIGINT IS NULL OR e.ledger <= $4)
           ORDER BY e.seq
           LIMIT $5`,
          [lastSeq, contract ?? null, fromLedger ?? null, toLedger ?? null, batchSize],
        );
        if (!rows.length) break;
        yield rows;
        lastSeq = rows[rows.length - 1].seq;
        if (rows.length < batchSize) break;
      }
      await client.query("COMMIT");
      committed = true;
    } finally {
      // Also runs when the consumer stops early (cancel / quota): never hand a
      // client with an open transaction back to the pool.
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  },

  /** Events at or after `forkLedger` (seq + contract), for CDN purging on reorg. */
  async getEventsFromLedger(forkLedger, limit = 10_000) {
    const { rows } = await pool.query(
      "SELECT seq, contract_id FROM events WHERE ledger >= $1 ORDER BY seq LIMIT $2",
      [forkLedger, limit],
    );
    return rows;
  },

  async rollbackFromLedger(forkLedger) {
    const network = getIndexerNetwork();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM events WHERE ledger >= $1", [forkLedger]);
      await client.query("DELETE FROM ledger_hashes WHERE network = $1 AND ledger >= $2", [network, forkLedger]);
      await client.query(
        `INSERT INTO daemon_state (network, key, value) VALUES ($1, 'cursor', $2)
         ON CONFLICT (network, key) DO UPDATE SET value = $2`,
        [network, String(forkLedger)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  // ── cursor-based pagination ────────────────────────────────────
  /**
   * Return a page of events using keyset (cursor-based) pagination.
   * Avoids OFFSET degradation on large tables.
   *
  * @param {{ contract?: string, fn?: string, type?: string,
  *           after_seq?: number, limit?: number, from?: string, to?: string }} opts
   *   after_seq — the `seq` of the last event on the previous page (opaque cursor).
   *               Omit (or pass 0) for the first page.
   * @returns {{ data: object[], next_cursor: number|null }}
   */
  async getEventsCursor({ contract, fn, type, cursor, after, before, after_seq = 0, limit = 25, count } = {}) {
    const filterHash = hashFilters({ contract, fn, type });
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 200);

    let isBackward = false;
    let anchorSeq = null;
    let hasAnchor = false;

    if (before) {
      const decoded = decodeCursor(before, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorSeq = Number(decoded.tuple[0]);
      isBackward = true;
      hasAnchor = true;
    } else if (after || cursor) {
      const token = after || cursor;
      if (typeof token === "number" || (/^\d+$/.test(String(token)) && String(token).length < 20)) {
        anchorSeq = Number(token);
        isBackward = false;
        hasAnchor = anchorSeq > 0;
      } else {
        const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
        anchorSeq = Number(decoded.tuple[0]);
        isBackward = decoded.direction === "backward";
        hasAnchor = true;
      }
    } else if (after_seq > 0) {
      anchorSeq = Number(after_seq);
      isBackward = false;
      hasAnchor = true;
    }

    const filterConditions = [];
    const filterParams = [];

    if (contract) {
      filterParams.push(contract);
      filterConditions.push(`contract_id = $${filterParams.length}`);
    }
    if (fn) {
      const fns = String(fn)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (fns.length === 1) {
        filterParams.push(fns[0]);
        filterConditions.push(`function = $${filterParams.length}`);
      } else if (fns.length > 1) {
        filterParams.push(fns);
        filterConditions.push(`function = ANY($${filterParams.length})`);
      }
    }
    if (type === "soroban") {
      filterConditions.push(`contract_id IS NOT NULL AND contract_id <> ''`);
    }
    if (type === "classic") {
      filterConditions.push(`(contract_id IS NULL OR contract_id = '')`);
    }

    const queryConditions = [...filterConditions];
    const queryParams = [...filterParams];

    if (anchorSeq !== null && anchorSeq > 0) {
      queryParams.push(anchorSeq);
      queryConditions.push(isBackward ? `seq > $${queryParams.length}` : `seq < $${queryParams.length}`);
    }

    const where = queryConditions.length ? `WHERE ${queryConditions.join(" AND ")}` : "";
    queryParams.push(safeLimit + 1);

    const orderDirection = isBackward ? "ASC" : "DESC";
    const { rows } = await pool.query(
      `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
       FROM events ${where} ORDER BY seq ${orderDirection} LIMIT $${queryParams.length}`,
      queryParams,
    );

    // Calculate total count (exact opt-in via count=exact, or approximate reltuples)
    let total;
    let countIsEstimate = true;
    const filterWhere = filterConditions.length ? `WHERE ${filterConditions.join(" AND ")}` : "";

    if (count === "exact") {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::BIGINT AS total FROM events ${filterWhere}`,
        filterParams,
      );
      total = Number(countRows[0]?.total ?? 0);
      countIsEstimate = false;
    } else {
      if (!filterConditions.length) {
        const { rows: relRows } = await pool.query(
          `SELECT reltuples::BIGINT AS estimate FROM pg_class WHERE relname = 'events'`,
        );
        const est = Number(relRows[0]?.estimate ?? -1);
        if (est >= 0) {
          total = est;
        } else {
          const { rows: countRows } = await pool.query(`SELECT COUNT(*)::BIGINT AS total FROM events`);
          total = Number(countRows[0]?.total ?? 0);
        }
      } else {
        try {
          const { rows: expRows } = await pool.query(`EXPLAIN SELECT 1 FROM events ${filterWhere}`, filterParams);
          const match = expRows[0]?.["QUERY PLAN"]?.match(/rows=(\d+)/);
          total = match ? Number(match[1]) : 0;
        } catch {
          const { rows: countRows } = await pool.query(
            `SELECT COUNT(*)::BIGINT AS total FROM events ${filterWhere}`,
            filterParams,
          );
          total = Number(countRows[0]?.total ?? 0);
        }
      }
    }

    const hasExtraRow = rows.length > safeLimit;
    return formatPageResponse({
      data: rows,
      limit: safeLimit,
      hasExtraRow,
      isBackward,
      hasAnchor,
      extractTuple: (r) => [Number(r.seq)],
      filterHash,
      secret: config.CURSOR_SIGNING_SECRET,
      total,
      countIsEstimate,
    });
  },

  async getEventsSince({ after_seq = 0, limit = 500, network = getIndexerNetwork() } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE network = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [network, after_seq, limit + 1],
    );
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, next_cursor: data.length ? Number(data.at(-1).seq) : after_seq, has_more: hasMore };
  },

  async listContractsCursor({ type, q, after, limit = 25 } = {}) {
    const params = [];
    const conditions = [];
    if (type === "verified") {
      conditions.push(`id IN (SELECT DISTINCT contract_id FROM source_verifications)`);
    } else if (type) {
      params.push(type);
      conditions.push(`protocol_type = $${params.length}`);
    }
    if (q) {
      params.push(`%${String(q).replace(/([%_\\])/g, "\\$1")}%`);
      conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }
    if (after) {
      let cursor;
      try {
        if (typeof after !== "string" || after.length > 512) throw new Error();
        cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid contracts cursor");
      }
      if (!cursor.created_at || !Number.isFinite(Date.parse(cursor.created_at)) || !cursor.id) {
        throw new Error("Invalid contracts cursor");
      }
      params.push(cursor.created_at, cursor.id);
      conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused,
              is_rwa, rwa_type, protocol_type, is_verified, verified_ledger, created_at
       FROM contracts ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data.at(-1);
    const next_cursor = hasMore && last
      ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url")
      : null;
    return { data, next_cursor };
  },

  async getWalletEventsCursor(address, { fn, from, to, after_seq = 0, limit = 25 } = {}) {
    const params = [address];
    const categories = fn
      ? String(fn).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
      : [];
    const categoryParts = [];
    for (const category of this.WALLET_EVENT_CATEGORIES.filter((value) => categories.includes(value))) {
      params.push(`${category}%`);
      categoryParts.push(`function ILIKE $${params.length}`);
    }
    if (categories.includes("other")) {
      const otherParts = this.WALLET_EVENT_CATEGORIES.map((category) => {
        params.push(`${category}%`);
        return `function NOT ILIKE $${params.length}`;
      });
      categoryParts.push(`(${otherParts.join(" AND ")})`);
    }
    const conditions = [
      `to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(raw_topics::text, '') || ' ' || coalesce(raw_data, '')) @@ plainto_tsquery('simple', $1)`,
    ];
    if (categoryParts.length) conditions.push(`(${categoryParts.join(" OR ")})`);
    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`created_at < ($${params.length}::date + interval '1 day')`);
    }
    if (after_seq > 0) {
      params.push(after_seq);
      conditions.push(`seq < $${params.length}`);
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, next_cursor: hasMore ? Number(data.at(-1).seq) : null };
  },

  async getSubInvocationsCursor({ contract, tx_hash, after_id = 0, limit = 25 } = {}) {
    const params = [];
    const conditions = [];
    if (contract) {
      params.push(contract);
      conditions.push(`contract_id = $${params.length}`);
    }
    if (tx_hash) {
      params.push(tx_hash);
      conditions.push(`parent_tx_hash = $${params.length}`);
    }
    if (after_id > 0) {
      params.push(after_id);
      conditions.push(`id < $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT id, parent_tx_hash, depth, contract_id, function, args, ledger
       FROM sub_invocations ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, next_cursor: hasMore ? Number(data.at(-1).id) : null };
  },

  async upsertEvent(ev) {
    const { rows } = await pool.query(
      `INSERT INTO events
         (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data,
          cpu_instructions, mem_bytes, fee_charged, is_high_bloat_risk, upgrade_info, storage_tiers, is_clawback,
          footprint_contention, ttl_extension, fee_bump, archival_info, zk_host_calls, abi_version, slippage_bps,
          topic0, topic1, topic2, topic3, topic_count, lineage_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (contract_id, ledger, tx_hash) DO NOTHING`,
      [
        ev.contract_id,
        ev.function,
        ev.ledger,
        ev.tx_hash,
        ev.description,
        JSON.stringify(ev.raw_topics),
        ev.raw_data,
        ev.cpu_instructions ?? null,
        ev.mem_bytes ?? null,
        ev.fee_charged ?? null,
        ev.is_high_bloat_risk ?? false,
        ev.upgrade ? JSON.stringify(ev.upgrade) : null,
        ev.storage_tiers ? JSON.stringify(ev.storage_tiers) : null,
        ev.is_clawback ?? false,
        ev.footprint_contention ?? false,
        ev.ttl_extension ? JSON.stringify(ev.ttl_extension) : null,
        ev.fee_bump ? JSON.stringify(ev.fee_bump) : null,
        ev.archival_info ? JSON.stringify(ev.archival_info) : null,
        ev.zk_host_calls ? JSON.stringify(ev.zk_host_calls) : null,
        ev.abi_version ?? 0,
        ev.slippage_bps ?? null,
        // Hashed topic columns (#903): canonical-XDR sha256 per topic.
        ...[0, 1, 2, 3].map((i) => (ev.topic_hashes?.[i] ? Buffer.from(ev.topic_hashes[i], "hex") : null)),
        ev.topic_count ?? null,
        ev.lineage_batch_id ?? null,
      ],
    );
    return rows[0]?.seq ?? null;
  },

  async appendMmrNode({ level, nodeIndex, hash, leafCount }) {
    await pool.query(
      `INSERT INTO event_mmr_nodes (level, node_index, hash, leaf_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (level, node_index) DO UPDATE SET hash = EXCLUDED.hash, leaf_count = EXCLUDED.leaf_count`,
      [level, nodeIndex, hash, leafCount],
    );
  },

  async markStaleAbiEvents() {
    const { rowCount } = await pool.query(
      `UPDATE events AS e
       SET needs_redecode = TRUE
       FROM contracts AS c
       WHERE e.contract_id = c.id
         AND e.abi_version < c.abi_version
         AND e.needs_redecode = FALSE`,
    );
    return rowCount ?? 0;
  },

  async markNeedsRedecode(contractId, newAbiVersion) {
    if (!contractId || !Number.isInteger(Number(newAbiVersion)) || Number(newAbiVersion) < 0) {
      throw new Error("contractId and a non-negative ABI version are required");
    }
    const { rowCount } = await pool.query(
      `UPDATE events
       SET needs_redecode = TRUE
       WHERE contract_id = $1 AND abi_version < $2 AND needs_redecode = FALSE`,
      [contractId, Number(newAbiVersion)],
    );
    return rowCount ?? 0;
  },

  async getEventsNeedingRedecode(limit = 100) {
    const safeLimit = Number(limit);
    if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 1000) {
      throw new Error("redecode batch size must be between 1 and 1000");
    }
    const { rows } = await pool.query(
      `SELECT seq, contract_id, function, ledger, tx_hash, raw_topics, raw_data, abi_version
       FROM events
       WHERE needs_redecode = TRUE
       ORDER BY seq ASC
       LIMIT $1`,
      [safeLimit],
    );
    return rows;
  },

  async updateRedecodedEvent(seq, decoded, abiVersion) {
    await pool.query(
      `UPDATE events
       SET function = $2,
           description = $3,
           raw_topics = $4,
           raw_data = $5,
           abi_version = $6,
           decode_status = $7,
           decode_warnings = $8,
           needs_redecode = FALSE
       WHERE seq = $1 AND needs_redecode = TRUE`,
      [seq, decoded.function, decoded.description, JSON.stringify(decoded.raw_topics), decoded.raw_data, abiVersion],
    );
  },

  /**
   * Validate and sanitize a decoded event, then insert into the database.
   * On validation failure:
   * - Sets decoded=false to mark as unverified
   * - Sanitizes description to prevent corruption (strips HTML, control chars, limits length)
   * - Logs structured error with failing field paths
   * - Increments decoder_schema_violations_total metric
   * - Still inserts the record with sanitized data (corruption guard)
   *
   * @param {object} ev - The decoded event object from decoder
   * @param {object} logger - Optional logger instance (defaults to console)
   */
  async upsertEventValidated(ev, logger) {
    const validated = validateAndSanitizeDecodedEvent(ev, logger);
    return this.upsertEvent(validated);
  },

  async upsertEventsValidatedBatch(events, logger = console) {
    if (!Array.isArray(events) || events.length === 0) return 0;

    const validated = events.map((ev) => validateAndSanitizeDecodedEvent(ev, logger));
    const columns = [
      "contract_id",
      "function",
      "ledger",
      "tx_hash",
      "description",
      "raw_topics",
      "raw_data",
      "cpu_instructions",
      "mem_bytes",
      "fee_charged",
      "is_high_bloat_risk",
      "upgrade_info",
      "storage_tiers",
      "is_clawback",
      "footprint_contention",
      "ttl_extension",
      "fee_bump",
      "archival_info",
      "zk_host_calls",
      "abi_version",
      "slippage_bps",
    ];

    const placeholders = [];
    const params = [];

    for (const ev of validated) {
      const row = [
        ev.contract_id,
        ev.function,
        ev.ledger,
        ev.tx_hash,
        ev.description,
        JSON.stringify(ev.raw_topics ?? []),
        ev.raw_data,
        ev.cpu_instructions ?? null,
        ev.mem_bytes ?? null,
        ev.fee_charged ?? null,
        ev.is_high_bloat_risk ?? false,
        ev.upgrade ? JSON.stringify(ev.upgrade) : null,
        ev.storage_tiers ? JSON.stringify(ev.storage_tiers) : null,
        ev.is_clawback ?? false,
        ev.footprint_contention ?? false,
        ev.ttl_extension ? JSON.stringify(ev.ttl_extension) : null,
        ev.fee_bump ? JSON.stringify(ev.fee_bump) : null,
        ev.archival_info ? JSON.stringify(ev.archival_info) : null,
        ev.zk_host_calls ? JSON.stringify(ev.zk_host_calls) : null,
        ev.abi_version ?? 0,
        ev.slippage_bps ?? null,
      ];

      const start = params.length + 1;
      const rowPlaceholders = row.map((_, idx) => `$${start + idx}`).join(", ");
      placeholders.push(`(${rowPlaceholders})`);
      params.push(...row);
    }

    const sql = `INSERT INTO events (${columns.join(", ")}) VALUES ${placeholders.join(", ")} ON CONFLICT (contract_id, ledger, tx_hash) DO NOTHING`;
    const result = await pool.query(sql, params);
    return result.rowCount ?? 0;
  },

  /**
   * @deprecated OFFSET pagination degrades to a full-table scan at depth on
   * large tables — use getEventsCursor() instead (#490). Kept only for the
   * page-based GET /api/contracts/:id/events endpoint.
   */
  async getEvents({ contract, fn, page = 1, limit = 25, type } = {}) {
    if (page > 1) throw new Error("Page-based event pagination is no longer supported; use getEventsCursor");
    const result = await this.getEventsCursor({ contract, fn, type, limit });
    return result.data;
  },

  /** Look up an event by its canonical ID on a network (#892). */
  async getEventByEventId(eventId, network = getIndexerNetwork()) {
    const { rows } = await pool.query(
      `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
       FROM events WHERE network = $1 AND event_id = $2`,
      [network, eventId],
    );
    return rows[0] ?? null;
  },

  async getEvent(seq) {
    const sql = `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
                 FROM events WHERE seq = $1`;
    const { rows } = await pool.query(sql, [seq]);
    return rows[0] ?? null;
  },

  async getEventProof(seq) {
    const { rows } = await pool.query("SELECT * FROM events WHERE seq = $1", [seq]);
    if (!rows[0]) return null;
    const event = rows[0];
    const leaf = hashLeaf(JSON.stringify([event.seq, event.contract_id, event.function, event.ledger, event.description, event.raw_data]));
    const { rows: peaks } = await pool.query(
      "SELECT level, hash FROM event_mmr_nodes ORDER BY level ASC",
    ).catch(() => ({ rows: [] }));
    return {
      event,
      proof: { leaf, siblings: [], left: [], root: peaks[0]?.hash ?? leaf, leafCount: Number(event.seq) + 1 },
    };
  },

  // Function-name categories recognised by the wallet event-type filter (issue #532).
  // Each category matches by prefix (e.g. "swap" also matches "swap_exact", "swap_tokens").
  WALLET_EVENT_CATEGORIES: ["transfer", "swap", "mint", "burn", "stake"],

  async getWalletEvents(address, { fn, from, to } = {}) {
    const params = [address];
    let categoryClause = "";

    const categories = fn
      ? String(fn)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];

    if (categories.length) {
      const known = this.WALLET_EVENT_CATEGORIES.filter((c) => categories.includes(c));
      const wantsOther = categories.includes("other");
      const orParts = [];

      for (const cat of known) {
        params.push(`${cat}%`);
        orParts.push(`function ILIKE $${params.length}`);
      }
      if (wantsOther) {
        const notLikeParts = this.WALLET_EVENT_CATEGORIES.map((cat) => {
          params.push(`${cat}%`);
          return `function NOT ILIKE $${params.length}`;
        });
        orParts.push(`(${notLikeParts.join(" AND ")})`);
      }
      if (orParts.length) {
        categoryClause = `AND (${orParts.join(" OR ")})`;
      }
    }

    // Date range filter (#527): filter on events.created_at using YYYY-MM-DD strings.
    let dateClause = "";
    if (from) {
      params.push(from);
      dateClause += ` AND created_at >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      dateClause += ` AND created_at < ($${params.length}::date + interval '1 day')`;
    }

    // Use the GIN full-text index via plainto_tsquery so the query uses the
    // idx_events_search_fts index instead of a full-table raw_topics::text scan.
    const { rows } = await pool.query(
      `SELECT * FROM events
       WHERE to_tsvector('simple',
         coalesce(description, '') || ' ' ||
         coalesce(raw_topics::text, '') || ' ' ||
         coalesce(raw_data, '')
       ) @@ plainto_tsquery('simple', $1)
       ${categoryClause}
       ${dateClause}
       ORDER BY ledger DESC
       LIMIT 500`,
      params,
    );
    return rows;
  },

  async searchContracts(q, { limit = 10 } = {}) {
    const terms = normalizeSearchTerms(q);
    if (!terms.length) return [];

    const params = [];
    const ftsQuery = pushParam(params, q.trim());
    const fts = `to_tsvector('simple', coalesce(c.name, '') || ' ' || coalesce(c.description, '') || ' ' || coalesce(c.id, '') || ' ' || coalesce(c.functions::text, '')) @@ plainto_tsquery('simple', ${ftsQuery})`;
    const likeTerms = terms
      .map((term) => {
        const name = pushParam(params, `%${escapeLike(term)}%`);
        const description = pushParam(params, `%${escapeLike(term)}%`);
        const id = pushParam(params, `%${escapeLike(term)}%`);
        const functions = pushParam(params, `%${escapeLike(term)}%`);
        return `(c.name ILIKE ${name} OR c.description ILIKE ${description} OR c.id ILIKE ${id} OR c.functions::text ILIKE ${functions})`;
      })
      .join(" OR ");

    params.push(clampLimit(limit, 10, 50));

    const { rows } = await pool.query(
      `SELECT c.*, COUNT(e.seq) AS event_count
       FROM contracts c
       LEFT JOIN events e ON e.contract_id = c.id
       WHERE (${fts} OR (${likeTerms}))
         AND c.moderation_status IN ('published', 'pending')
       GROUP BY c.id
       ORDER BY (c.moderation_status = 'pending') ASC, event_count DESC, c.name ASC
       LIMIT $${params.length}`,
      params,
    );

    return rows.map((row) => ({
      ...row,
      event_count: Number(row.event_count || 0),
      functions: parseJsonField(row.functions, []),
    }));
  },

  async searchEvents(q, { limit = 10 } = {}) {
    const terms = normalizeSearchTerms(q);
    if (!terms.length) return [];

    const params = [];
    const ftsQuery = pushParam(params, q.trim());
    const fts = `to_tsvector('simple', coalesce(e.description, '') || ' ' || coalesce(e.function, '') || ' ' || coalesce(e.contract_id, '') || ' ' || coalesce(e.tx_hash, '') || ' ' || coalesce(e.raw_topics::text, '') || ' ' || coalesce(e.raw_data, '')) @@ plainto_tsquery('simple', ${ftsQuery})`;
    const likeTerms = terms
      .map((term) => {
        const functionParam = pushParam(params, `%${escapeLike(term)}%`);
        const description = pushParam(params, `%${escapeLike(term)}%`);
        const contract = pushParam(params, `%${escapeLike(term)}%`);
        const txHash = pushParam(params, `%${escapeLike(term)}%`);
        const topics = pushParam(params, `%${escapeLike(term)}%`);
        const data = pushParam(params, `%${escapeLike(term)}%`);
        return `(e.function ILIKE ${functionParam} OR e.description ILIKE ${description} OR e.contract_id ILIKE ${contract} OR e.tx_hash ILIKE ${txHash} OR e.raw_topics::text ILIKE ${topics} OR e.raw_data ILIKE ${data})`;
      })
      .join(" OR ");

    params.push(clampLimit(limit, 10, 50));

    const { rows } = await pool.query(
      `SELECT * FROM events e
       WHERE (${fts} OR (${likeTerms}))
       ORDER BY ledger DESC, seq DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async searchWallets(q, { limit = 10 } = {}) {
    const terms = normalizeSearchTerms(q);
    if (!terms.length) return [];

    // A single array-typed param bound once via ANY($n), not one param per
    // term — `params.length` computed inside the query template (as this
    // used to do) reflects the *final* array length at template-evaluation
    // time, not each placeholder's actual position, and referencing
    // `params` from within its own initializer threw a TDZ ReferenceError.
    const params = [];
    const likePatterns = pushParam(
      params,
      terms.map((term) => `%${escapeLike(term)}%`),
    );
    const limitPlaceholder = pushParam(params, clampLimit(limit, 10, 50));

    const { rows } = await pool.query(
      `WITH address_hits AS (
         SELECT e.seq, e.ledger, e.contract_id, a.address
         FROM events e
         CROSS JOIN LATERAL (
           SELECT DISTINCT m[1] AS address
           FROM regexp_matches(
             coalesce(e.description, '') || ' ' || coalesce(e.raw_topics::text, '') || ' ' || coalesce(e.raw_data, ''),
             '\\m[GCM][A-Z2-7]{55}\\M',
             'g'
           ) AS m
         ) a
         WHERE a.address ILIKE ANY(${likePatterns})
         UNION
         SELECT NULL::BIGINT AS seq, NULL::BIGINT AS ledger, contract_id, address
         FROM privileged_roles
         WHERE address ILIKE ANY(${likePatterns}) AND revoked = FALSE
         UNION
         SELECT NULL::BIGINT AS seq, NULL::BIGINT AS ledger, contract_id, address
         FROM token_holders
         WHERE address ILIKE ANY(${likePatterns})
       )
       SELECT address,
              COUNT(seq) AS event_count,
              MIN(ledger) AS first_seen_ledger,
              MAX(ledger) AS last_seen_ledger,
              ARRAY_AGG(DISTINCT contract_id) FILTER (WHERE contract_id IS NOT NULL AND contract_id <> '') AS contracts
       FROM address_hits
       GROUP BY address
       ORDER BY event_count DESC, last_seen_ledger DESC NULLS LAST, address ASC
       LIMIT ${limitPlaceholder}`,
      params,
    );

    return rows.map((row) => ({
      ...row,
      event_count: Number(row.event_count || 0),
      first_seen_ledger: row.first_seen_ledger != null ? Number(row.first_seen_ledger) : null,
      last_seen_ledger: row.last_seen_ledger != null ? Number(row.last_seen_ledger) : null,
      contracts: row.contracts ?? [],
    }));
  },

  async searchSuggestions(q, { limit = 10 } = {}) {
    const terms = normalizeSearchTerms(q);
    if (!terms.length) return [];

    const limitN = clampLimit(limit, 10, 50);
    const term = `%${escapeLike(terms[0])}%`;

    const [contracts, functions, wallets] = await Promise.all([
      pool.query(
        `SELECT id, name, description FROM contracts
         WHERE name ILIKE $1 OR description ILIKE $1 OR id ILIKE $1
         ORDER BY name ASC
         LIMIT $2`,
        [term, limitN],
      ),
      pool.query(
        `SELECT function, COUNT(*) AS event_count
         FROM events
         WHERE function ILIKE $1
         GROUP BY function
         ORDER BY event_count DESC, function ASC
         LIMIT $2`,
        [term, limitN],
      ),
      pool.query(
        `WITH address_hits AS (
           SELECT a.address
           FROM events e
           CROSS JOIN LATERAL (
             SELECT DISTINCT m[1] AS address
             FROM regexp_matches(
               coalesce(e.description, '') || ' ' || coalesce(e.raw_topics::text, '') || ' ' || coalesce(e.raw_data, ''),
               '\\m[GCM][A-Z2-7]{55}\\M',
               'g'
             ) AS m
           ) a
           WHERE a.address ILIKE $1
           GROUP BY a.address
           ORDER BY a.address ASC
           LIMIT $2
         ) SELECT * FROM address_hits`,
        [term, limitN],
      ),
    ]);

    return [
      ...contracts.rows.slice(0, limitN).map((row) => ({
        kind: "contract",
        label: row.name || row.id,
        route: `/contract/${row.id}`,
        meta: { id: row.id, description: row.description || "" },
      })),
      ...functions.rows.slice(0, limitN).map((row) => ({
        kind: "event",
        label: row.function,
        route: `/?fn=${encodeURIComponent(row.function)}`,
        meta: { event_count: Number(row.event_count || 0) },
      })),
      ...wallets.rows.slice(0, limitN).map((row) => ({
        kind: "wallet",
        label: row.address,
        route: `/wallet/${row.address}`,
        meta: { address: row.address },
      })),
    ].slice(0, limitN);
  },

  async listContracts({ page, limit = 25, type, q, cursor, after, before, count } = {}) {
    const filterHash = hashFilters({ type, q });
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100);

    let isBackward = false;
    let anchorCreatedAt = null;
    let anchorId = null;
    let hasAnchor = false;

    if (before) {
      const decoded = decodeCursor(before, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorCreatedAt = decoded.tuple[0];
      anchorId = decoded.tuple[1];
      isBackward = true;
      hasAnchor = true;
    } else if (after || cursor) {
      const token = after || cursor;
      const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorCreatedAt = decoded.tuple[0];
      anchorId = decoded.tuple[1];
      isBackward = decoded.direction === "backward";
      hasAnchor = true;
    }

    // Held/hidden/rejected registrations are curated out of listings (#934).
    const filterConditions = ["moderation_status IN ('published', 'pending')"];
    const filterParams = [];

    if (q) {
      filterParams.push(`%${q}%`);
      const idx = filterParams.length;
      filterConditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
    }

    if (type && type !== "all") {
      if (type === "verified") {
        filterConditions.push(`id IN (SELECT DISTINCT contract_id FROM source_verifications)`);
      } else {
        filterParams.push(type);
        filterConditions.push(
          `(protocol_type = $${filterParams.length} OR LOWER(COALESCE(protocol_type, '')) = $${filterParams.length})`,
        );
      }
    }

    // Support legacy offset pagination if requested without cursor
    if (!hasAnchor && page !== undefined && Number(page) > 1) {
      const safePage = Math.max(1, Number(page) || 1);
      const offset = (safePage - 1) * safeLimit;
      const where = filterConditions.length ? `WHERE ${filterConditions.join(" AND ")}` : "";
      const queryParams = [...filterParams, safeLimit, offset];
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused,
                  is_rwa, rwa_type, protocol_type, is_verified, verified_ledger, created_at, moderation_status
           FROM contracts ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
          queryParams,
        ),
        pool.query(`SELECT COUNT(*)::INT AS total FROM contracts ${where}`, filterParams),
      ]);
      const total = countRows[0]?.total ?? 0;
      return {
        contracts: rows,
        data: rows,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          total_pages: Math.ceil(total / safeLimit),
        },
      };
    }

    const queryConditions = [...filterConditions];
    const queryParams = [...filterParams];

    if (anchorCreatedAt !== null && anchorId !== null) {
      queryParams.push(anchorCreatedAt, anchorId);
      const p1 = queryParams.length - 1;
      const p2 = queryParams.length;
      if (isBackward) {
        queryConditions.push(`(created_at, id) > ($${p1}::timestamptz, $${p2})`);
      } else {
        queryConditions.push(`(created_at, id) < ($${p1}::timestamptz, $${p2})`);
      }
    }

    const where = queryConditions.length ? `WHERE ${queryConditions.join(" AND ")}` : "";
    queryParams.push(safeLimit + 1);

    const orderDirection = isBackward ? "ASC" : "DESC";
    const { rows } = await pool.query(
      `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused,
              is_rwa, rwa_type, protocol_type, is_verified, verified_ledger, created_at, moderation_status
       FROM contracts ${where}
       ORDER BY created_at ${orderDirection}, id ${orderDirection}
       LIMIT $${queryParams.length}`,
      queryParams,
    );

    let total;
    let countIsEstimate = true;
    const filterWhere = filterConditions.length ? `WHERE ${filterConditions.join(" AND ")}` : "";

    if (count === "exact") {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::INT AS total FROM contracts ${filterWhere}`,
        filterParams,
      );
      total = countRows[0]?.total ?? 0;
      countIsEstimate = false;
    } else {
      if (!filterConditions.length) {
        const { rows: relRows } = await pool.query(
          `SELECT reltuples::BIGINT AS estimate FROM pg_class WHERE relname = 'contracts'`,
        );
        const est = Number(relRows[0]?.estimate ?? -1);
        if (est >= 0) {
          total = est;
        } else {
          const { rows: countRows } = await pool.query(`SELECT COUNT(*)::INT AS total FROM contracts`);
          total = countRows[0]?.total ?? 0;
        }
      } else {
        try {
          const { rows: expRows } = await pool.query(`EXPLAIN SELECT 1 FROM contracts ${filterWhere}`, filterParams);
          const match = expRows[0]?.["QUERY PLAN"]?.match(/rows=(\d+)/);
          total = match ? Number(match[1]) : 0;
        } catch {
          const { rows: countRows } = await pool.query(
            `SELECT COUNT(*)::INT AS total FROM contracts ${filterWhere}`,
            filterParams,
          );
          total = countRows[0]?.total ?? 0;
        }
      }
    }

    const hasExtraRow = rows.length > safeLimit;
    const formatted = formatPageResponse({
      data: rows,
      limit: safeLimit,
      hasExtraRow,
      isBackward,
      hasAnchor,
      extractTuple: (r) => [r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, r.id],
      filterHash,
      secret: config.CURSOR_SIGNING_SECRET,
      total,
      countIsEstimate,
    });

    return {
      contracts: formatted.data,
      data: formatted.data,
      page_info: formatted.page_info,
      next_cursor: formatted.next_cursor,
      total,
      count_is_estimate: countIsEstimate,
      pagination: {
        page: Number(page) || 1,
        limit: safeLimit,
        total,
        total_pages: Math.ceil(total / safeLimit),
      },
    };
  },

  // ── Developer accounts & passkeys (#933) ──────────────────────────────────
  async findOrCreateAccountByEmail(email) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING *, (xmax = 0) AS created`,
      [email],
    );
    return rows[0];
  },

  async getAccount(id) {
    const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async getAccountByEmail(email) {
    const { rows } = await pool.query("SELECT * FROM accounts WHERE email = $1", [email]);
    return rows[0] ?? null;
  },

  async getAccountByStellarAddress(address) {
    const { rows } = await pool.query("SELECT * FROM accounts WHERE stellar_address = $1", [address]);
    return rows[0] ?? null;
  },

  async linkStellarAddress(accountId, address) {
    await pool.query("UPDATE accounts SET stellar_address = $2 WHERE id = $1", [accountId, address]);
  },

  async listPasskeys(accountId) {
    const { rows } = await pool.query(
      `SELECT id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at
       FROM webauthn_credentials WHERE account_id = $1 ORDER BY created_at`,
      [accountId],
    );
    return rows;
  },

  async getPasskey(id) {
    const { rows } = await pool.query("SELECT * FROM webauthn_credentials WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  async insertPasskey({ id, accountId, publicKey, counter, transports, deviceType, backedUp, name }) {
    await pool.query(
      `INSERT INTO webauthn_credentials (id, account_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, accountId, Buffer.from(publicKey), counter, transports ?? [], deviceType ?? null, Boolean(backedUp), name ?? null],
    );
  },

  async updatePasskeyCounter(id, counter) {
    await pool.query("UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1", [id, counter]);
  },

  async deletePasskey(accountId, id) {
    const { rowCount } = await pool.query("DELETE FROM webauthn_credentials WHERE account_id = $1 AND id = $2", [accountId, id]);
    return rowCount > 0;
  },

  async insertAuthSession({ idHash, accountId, authMethod, expiresAt, elevatedUntil = null }) {
    await pool.query(
      `INSERT INTO auth_sessions (id_hash, account_id, auth_method, expires_at, elevated_until)
       VALUES ($1, $2, $3, $4, $5)`,
      [idHash, accountId, authMethod, expiresAt, elevatedUntil],
    );
  },

  async getAuthSession(idHash) {
    const { rows } = await pool.query("SELECT * FROM auth_sessions WHERE id_hash = $1", [idHash]);
    return rows[0] ?? null;
  },

  async touchAuthSession(idHash) {
    await pool.query("UPDATE auth_sessions SET last_seen_at = now() WHERE id_hash = $1", [idHash]);
  },

  async revokeAuthSession(idHash) {
    await pool.query("UPDATE auth_sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL", [idHash]);
  },

  async revokeAccountSessions(accountId, exceptIdHash = null) {
    await pool.query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL AND id_hash IS DISTINCT FROM $2",
      [accountId, exceptIdHash],
    );
  },

  async insertAuthChallenge({ idHash, purpose, challenge, accountId = null, expiresAt }) {
    await pool.query(
      "INSERT INTO auth_challenges (id_hash, purpose, challenge, account_id, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [idHash, purpose, challenge, accountId, expiresAt],
    );
  },

  // Single use: the challenge row is deleted as it is read.
  async consumeAuthChallenge(idHash, purpose) {
    const { rows } = await pool.query(
      "DELETE FROM auth_challenges WHERE id_hash = $1 AND purpose = $2 RETURNING *",
      [idHash, purpose],
    );
    const row = rows[0];
    return row && new Date(row.expires_at) > new Date() ? row : null;
  },

  async insertEmailToken({ tokenHash, email, purpose, expiresAt }) {
    await pool.query(
      "INSERT INTO auth_email_tokens (token_hash, email, purpose, expires_at) VALUES ($1, $2, $3, $4)",
      [tokenHash, email, purpose, expiresAt],
    );
  },

  async consumeEmailToken(tokenHash, purpose) {
    const { rows } = await pool.query(
      `UPDATE auth_email_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING email`,
      [tokenHash, purpose],
    );
    return rows[0]?.email ?? null;
  },

  async replaceRecoveryCodes(accountId, codeHashes) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM recovery_codes WHERE account_id = $1", [accountId]);
      for (const hash of codeHashes) {
        await client.query("INSERT INTO recovery_codes (account_id, code_hash) VALUES ($1, $2)", [accountId, hash]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },

  async consumeRecoveryCode(accountId, codeHash) {
    const { rowCount } = await pool.query(
      "UPDATE recovery_codes SET used_at = now() WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL",
      [accountId, codeHash],
    );
    return rowCount > 0;
  },

  async countRecoveryCodes(accountId) {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::INT AS n FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL",
      [accountId],
    );
    return rows[0].n;
  },

  // Migration path: verified key holders claim keys registered to their email.
  async claimApiKeysByEmail(accountId, email) {
    const { rowCount } = await pool.query(
      "UPDATE api_keys SET account_id = $1 WHERE email = $2 AND verified = TRUE AND account_id IS NULL",
      [accountId, email],
    );
    return rowCount;
  },

  async listAccountApiKeys(accountId) {
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, tier, scopes, created_at, expires_at
       FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId],
    );
    return rows;
  },

  async assignApiKeyAccount(keyId, accountId) {
    await pool.query("UPDATE api_keys SET account_id = $2 WHERE id = $1", [keyId, accountId]);
  },

  // ── Registry moderation (#934) ────────────────────────────────────────────
  async getModerationContext(submitter) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::INT FROM contracts WHERE (registered_by_key_id::TEXT = $1 OR registered_by = $1)
            AND moderation_status IN ('rejected','hidden')) AS prior_rejections,
         (SELECT COUNT(*)::INT FROM contracts WHERE (registered_by_key_id::TEXT = $1 OR registered_by = $1)
            AND moderation_status = 'published') AS prior_approved,
         (SELECT COUNT(*)::INT FROM contracts WHERE (registered_by_key_id::TEXT = $1 OR registered_by = $1)
            AND created_at > now() - interval '1 hour') AS recent_submissions,
         EXISTS (SELECT 1 FROM moderation_banned_submitters WHERE submitter = $1) AS banned`,
      [String(submitter ?? "")],
    );
    const r = rows[0] ?? {};
    return {
      priorRejections: r.prior_rejections ?? 0,
      priorApproved: r.prior_approved ?? 0,
      recentSubmissions: r.recent_submissions ?? 0,
      banned: Boolean(r.banned),
    };
  },

  async setContractModeration(id, { status, score, signals }) {
    const sets = ["moderation_status = $2"];
    const params = [id, status];
    if (score !== undefined) {
      params.push(score);
      sets.push(`risk_score = $${params.length}`);
    }
    if (signals !== undefined) {
      params.push(JSON.stringify(signals));
      sets.push(`risk_signals = $${params.length}::jsonb`);
    }
    const { rows } = await pool.query(
      `UPDATE contracts SET ${sets.join(", ")} WHERE id = $1
       RETURNING id, moderation_status, registered_by, registered_by_key_id`,
      params,
    );
    return rows[0] ?? null;
  },

  async insertModerationAction({ contractId, action, actor, fromStatus = null, toStatus = null, notice = null, evidence = {}, onchainStatus = null }) {
    const { rows } = await pool.query(
      `INSERT INTO moderation_actions (contract_id, action, actor, from_status, to_status, notice, evidence, onchain_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
      [contractId, action, String(actor), fromStatus, toStatus, notice, JSON.stringify(evidence), onchainStatus],
    );
    return rows[0];
  },

  async listModerationQueue({ status = "held", limit = 50 } = {}) {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.description, c.registered_by, c.moderation_status, c.risk_score, c.risk_signals, c.created_at,
              COALESCE(r.open_reports, 0)::INT AS open_reports, COALESCE(r.report_weight, 0) AS report_weight,
              COALESCE(a.open_appeals, 0)::INT AS open_appeals
       FROM contracts c
       LEFT JOIN (SELECT contract_id, COUNT(*) AS open_reports, SUM(weight) AS report_weight
                  FROM moderation_reports WHERE NOT resolved GROUP BY contract_id) r ON r.contract_id = c.id
       LEFT JOIN (SELECT contract_id, COUNT(*) AS open_appeals
                  FROM moderation_appeals WHERE status = 'open' GROUP BY contract_id) a ON a.contract_id = c.id
       WHERE c.moderation_status = $1 OR ($1 = 'reported' AND r.open_reports > 0) OR ($1 = 'appealed' AND a.open_appeals > 0)
       ORDER BY c.risk_score DESC, c.created_at ASC
       LIMIT $2`,
      [status, Math.min(Math.max(1, Number(limit) || 50), 200)],
    );
    return rows;
  },

  async getModerationDetail(id) {
    const [contract, reports, actions, appeals] = await Promise.all([
      pool.query(
        `SELECT id, name, description, functions, registered_by, registered_by_key_id, moderation_status,
                risk_score, risk_signals, ownership_verified, created_at FROM contracts WHERE id = $1`,
        [id],
      ),
      pool.query("SELECT * FROM moderation_reports WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 200", [id]),
      pool.query("SELECT * FROM moderation_actions WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 200", [id]),
      pool.query("SELECT * FROM moderation_appeals WHERE contract_id = $1 ORDER BY created_at DESC", [id]),
    ]);
    if (!contract.rows[0]) return null;
    return { contract: contract.rows[0], reports: reports.rows, actions: actions.rows, appeals: appeals.rows };
  },

  async getReporterStats(reporter) {
    const { rows } = await pool.query(
      `SELECT COALESCE(r.upheld, 0) AS upheld, COALESCE(r.dismissed, 0) AS dismissed,
              (SELECT COUNT(*)::INT FROM moderation_reports WHERE reporter = $1 AND created_at > now() - interval '1 hour') AS recent
       FROM (SELECT 1) x LEFT JOIN moderation_reporters r ON r.reporter = $1`,
      [reporter],
    );
    return rows[0];
  },

  async hasOpenReport(contractId, reporter) {
    const { rows } = await pool.query(
      "SELECT 1 FROM moderation_reports WHERE contract_id = $1 AND reporter = $2 AND NOT resolved LIMIT 1",
      [contractId, reporter],
    );
    return rows.length > 0;
  },

  async insertModerationReport({ contractId, reporter, reason, details, weight }) {
    await pool.query(
      "INSERT INTO moderation_reports (contract_id, reporter, reason, details, weight) VALUES ($1, $2, $3, $4, $5)",
      [contractId, reporter, reason, details ?? null, weight],
    );
    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(weight), 0)::REAL AS total FROM moderation_reports WHERE contract_id = $1 AND NOT resolved",
      [contractId],
    );
    return Number(rows[0].total);
  },

  // Close open reports; upheld reports raise reporter reputation, dismissed lower it.
  async resolveModerationReports(contractId, upheld) {
    const column = upheld ? "upheld" : "dismissed";
    await pool.query(
      `WITH closed AS (
         UPDATE moderation_reports SET resolved = TRUE WHERE contract_id = $1 AND NOT resolved RETURNING reporter
       )
       INSERT INTO moderation_reporters (reporter, ${column})
       SELECT reporter, COUNT(*) FROM closed GROUP BY reporter
       ON CONFLICT (reporter) DO UPDATE SET ${column} = moderation_reporters.${column} + EXCLUDED.${column}`,
      [contractId],
    );
  },

  async insertModerationAppeal({ contractId, submitter, message }) {
    const { rows } = await pool.query(
      "INSERT INTO moderation_appeals (contract_id, submitter, message) VALUES ($1, $2, $3) RETURNING *",
      [contractId, submitter, message],
    );
    return rows[0];
  },

  async decideModerationAppeal(appealId, { granted, decidedBy }) {
    const { rows } = await pool.query(
      `UPDATE moderation_appeals SET status = $2, decided_by = $3, decided_at = now()
       WHERE id = $1 AND status = 'open' RETURNING *`,
      [appealId, granted ? "granted" : "denied", decidedBy],
    );
    return rows[0] ?? null;
  },

  async banSubmitter(submitter, { reason, bannedBy }) {
    await pool.query(
      `INSERT INTO moderation_banned_submitters (submitter, reason, banned_by) VALUES ($1, $2, $3)
       ON CONFLICT (submitter) DO NOTHING`,
      [submitter, reason ?? null, bannedBy],
    );
  },

  async getContractMeta(id) {
    const sql = "SELECT * FROM contracts WHERE id = $1";
    const { rows } = await pool.query(sql, [id]);
    return rows[0] ?? null;
  },

  async listSandboxes({ cursor, after, before, page, limit = 25, offset, count } = {}) {
    const filterHash = hashFilters({});
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100);

    let isBackward = false;
    let anchorUpdatedAt = null;
    let anchorId = null;
    let hasAnchor = false;

    if (before) {
      const decoded = decodeCursor(before, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorUpdatedAt = decoded.tuple[0];
      anchorId = decoded.tuple[1];
      isBackward = true;
      hasAnchor = true;
    } else if (after || cursor) {
      const token = after || cursor;
      const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorUpdatedAt = decoded.tuple[0];
      anchorId = decoded.tuple[1];
      isBackward = decoded.direction === "backward";
      hasAnchor = true;
    }

    // If legacy offset request without cursor
    if (!hasAnchor && (offset !== undefined || (page !== undefined && Number(page) > 1))) {
      const safeOffset =
        offset !== undefined ? Math.max(0, Number(offset) || 0) : (Math.max(1, Number(page) || 1) - 1) * safeLimit;
      const { rows } = await pool.query(
        `SELECT sandbox_id, template_id, updated_at, created_at
         FROM sandboxes ORDER BY updated_at DESC, sandbox_id DESC LIMIT $1 OFFSET $2`,
        [safeLimit, safeOffset],
      );
      const { rows: countRows } = await pool.query("SELECT COUNT(*)::INT AS total FROM sandboxes");
      const total = countRows[0]?.total ?? 0;
      return {
        sandboxes: rows,
        data: rows,
        total,
        pagination: {
          page: Math.floor(safeOffset / safeLimit) + 1,
          limit: safeLimit,
          total,
          total_pages: Math.ceil(total / safeLimit),
        },
      };
    }

    const queryConditions = [];
    const queryParams = [];

    if (anchorUpdatedAt !== null && anchorId !== null) {
      queryParams.push(anchorUpdatedAt, anchorId);
      const p1 = queryParams.length - 1;
      const p2 = queryParams.length;
      if (isBackward) {
        queryConditions.push(`(updated_at, sandbox_id) > ($${p1}::timestamptz, $${p2})`);
      } else {
        queryConditions.push(`(updated_at, sandbox_id) < ($${p1}::timestamptz, $${p2})`);
      }
    }

    const where = queryConditions.length ? `WHERE ${queryConditions.join(" AND ")}` : "";
    queryParams.push(safeLimit + 1);

    const orderDirection = isBackward ? "ASC" : "DESC";
    const { rows } = await pool.query(
      `SELECT sandbox_id, template_id, updated_at, created_at
       FROM sandboxes ${where}
       ORDER BY updated_at ${orderDirection}, sandbox_id ${orderDirection}
       LIMIT $${queryParams.length}`,
      queryParams,
    );

    let total;
    let countIsEstimate = true;
    if (count === "exact") {
      const { rows: countRows } = await pool.query(`SELECT COUNT(*)::INT AS total FROM sandboxes`);
      total = countRows[0]?.total ?? 0;
      countIsEstimate = false;
    } else {
      const { rows: relRows } = await pool.query(
        `SELECT reltuples::BIGINT AS estimate FROM pg_class WHERE relname = 'sandboxes'`,
      );
      const est = Number(relRows[0]?.estimate ?? -1);
      if (est >= 0) {
        total = est;
      } else {
        const { rows: countRows } = await pool.query(`SELECT COUNT(*)::INT AS total FROM sandboxes`);
        total = countRows[0]?.total ?? 0;
      }
    }

    const hasExtraRow = rows.length > safeLimit;
    const formatted = formatPageResponse({
      data: rows,
      limit: safeLimit,
      hasExtraRow,
      isBackward,
      hasAnchor,
      extractTuple: (r) => [r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at, r.sandbox_id],
      filterHash,
      secret: config.CURSOR_SIGNING_SECRET,
      total,
      countIsEstimate,
    });

    return {
      sandboxes: formatted.data,
      data: formatted.data,
      page_info: formatted.page_info,
      next_cursor: formatted.next_cursor,
      total,
      count_is_estimate: countIsEstimate,
    };
  },

  /**
   * paginated contract transaction history with optional filters.
   * @param {string} contractId
   * @param {{ function_name?: string, start_ledger?: number, end_ledger?: number, page?: number, limit?: number, cursor?: string, after?: string, before?: string }} opts
   */
  async getContractTransactions(
    contractId,
    { function_name, start_ledger, end_ledger, page = 1, limit = 25, cursor, after, before } = {},
  ) {
    const filterHash = hashFilters({ contractId, function_name, start_ledger, end_ledger });
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100);

    let isBackward = false;
    let anchorSeq = null;
    let hasAnchor = false;

    if (before) {
      const decoded = decodeCursor(before, filterHash, config.CURSOR_SIGNING_SECRET);
      anchorSeq = Number(decoded.tuple[0]);
      isBackward = true;
      hasAnchor = true;
    } else if (after || cursor) {
      const token = after || cursor;
      if (typeof token === "number" || (/^\d+$/.test(String(token)) && String(token).length < 20)) {
        anchorSeq = Number(token);
        isBackward = false;
        hasAnchor = anchorSeq > 0;
      } else {
        const decoded = decodeCursor(token, filterHash, config.CURSOR_SIGNING_SECRET);
        anchorSeq = Number(decoded.tuple[0]);
        isBackward = decoded.direction === "backward";
        hasAnchor = true;
      }
    }

    const params = [contractId];
    const conditions = ["contract_id = $1"];

    if (function_name) {
      params.push(function_name);
      conditions.push(`function = $${params.length}`);
    }
    if (start_ledger) {
      params.push(start_ledger);
      conditions.push(`ledger >= $${params.length}`);
    }
    if (end_ledger) {
      params.push(end_ledger);
      conditions.push(`ledger <= $${params.length}`);
    }
    if (after_seq > 0) {
      params.push(after_seq);
      conditions.push(`seq < $${params.length}`);
    }

    if (!hasAnchor && page && Number(page) > 1) {
      const offset = (Number(page) - 1) * safeLimit;
      const where = conditions.join(" AND ");
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT * FROM events WHERE ${where} ORDER BY ledger DESC, seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, safeLimit, offset],
        ),
        pool.query(`SELECT COUNT(*)::INT AS total FROM events WHERE ${where}`, params),
      ]);
      const total = countRows[0]?.total ?? 0;
      return {
        data: rows,
        pagination: {
          page: Number(page),
          limit: safeLimit,
          total,
          total_pages: Math.ceil(total / safeLimit),
          has_next: Number(page) * safeLimit < total,
        },
      };
    }

    const queryConditions = [...conditions];
    const queryParams = [...params];

    if (anchorSeq !== null && anchorSeq > 0) {
      queryParams.push(anchorSeq);
      queryConditions.push(isBackward ? `seq > $${queryParams.length}` : `seq < $${queryParams.length}`);
    }

    const where = queryConditions.join(" AND ");
    queryParams.push(safeLimit + 1);

    const orderDirection = isBackward ? "ASC" : "DESC";
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT * FROM events WHERE ${where} ORDER BY seq ${orderDirection} LIMIT $${queryParams.length}`,
        queryParams,
      ),
      pool.query(`SELECT COUNT(*)::INT AS total FROM events WHERE ${conditions.join(" AND ")}`, params),
    ]);

    const total = countRows[0]?.total ?? 0;
    const hasExtraRow = rows.length > safeLimit;
    const formatted = formatPageResponse({
      data: rows,
      limit: safeLimit,
      hasExtraRow,
      isBackward,
      hasAnchor,
      extractTuple: (r) => [Number(r.seq)],
      filterHash,
      secret: config.CURSOR_SIGNING_SECRET,
      total,
      countIsEstimate: false,
    });

    return {
      data: formatted.data,
      page_info: formatted.page_info,
      next_cursor: formatted.next_cursor,
      pagination: {
        page: Number(page) || 1,
        limit: safeLimit,
        total,
        total_pages: Math.ceil(total / safeLimit),
        has_next: formatted.page_info.has_next,
      },
    };
  },

  /**
   * Aggregate transfer volume for a contract over the last 24 hours.
   * Amounts are stored as raw strings in raw_data; we cast via NUMERIC to
   * avoid floating-point errors and return a BigInt-safe string.
   * @param {string} contractId
   * @param {number} decimals  token decimal places (default 7)
   * @returns {Promise<{ volume_raw: string, volume_scaled: string, decimals: number }>}
   */
  async get24hVolume(contractId, decimals = 7) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM((raw_data::jsonb->>'amount')::NUMERIC), 0)::TEXT AS volume_raw
       FROM events
       WHERE contract_id = $1
         AND function    = 'transfer'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [contractId],
    );
    const raw = rows[0].volume_raw ?? "0";
    // Scale using integer arithmetic via BigInt to avoid float rounding
    const rawBig = BigInt(raw.split(".")[0]); // NUMERIC may have no decimals
    const divisor = 10n ** BigInt(decimals);
    const whole = rawBig / divisor;
    const fraction = rawBig % divisor;
    const volume_scaled = `${whole}.${fraction.toString().padStart(decimals, "0")}`;
    return { volume_raw: raw, volume_scaled, decimals };
  },

  /** Return all upgrade events for a contract in ledger order. */
  async getUpgradeHistory(contractId) {
    const { rows } = await pool.query(
      `SELECT seq, ledger, tx_hash, upgrade_info, created_at
       FROM events
       WHERE contract_id = $1 AND upgrade_info IS NOT NULL
       ORDER BY ledger ASC`,
      [contractId],
    );
    return rows;
  },

  async upsertContractMeta(meta) {
    const { rows: existingRows } = await pool.query(
      "SELECT abi_version, functions FROM contracts WHERE id = $1",
      [meta.id],
    );
    const existing = existingRows[0] ?? null;
    const previousAbiVersion = Number(existing?.abi_version ?? 0);
    const functionsChanged =
      existing != null &&
      JSON.stringify(existing.functions ?? []) !== JSON.stringify(meta.functions ?? []);
    const incomingAbiVersion = Number(meta.abi_version ?? previousAbiVersion);
    const abiVersion = Math.max(incomingAbiVersion, previousAbiVersion + (functionsChanged ? 1 : 0));
    const versionedMeta = { ...meta, abi_version: abiVersion };

    // Auto-tag protocol_type from function names if not explicitly provided
    const functionNames = (meta.functions ?? []).map((f) => (typeof f === "string" ? f : (f?.name ?? "")));
    const protocol_type = meta.protocol_type ?? this.inferProtocolType(functionNames);

    await pool.query(
      `INSERT INTO contracts (id, name, description, functions, registered_by, source_files, has_circuit_breaker, is_rwa, rwa_type, version, abi_version, min_ledger, protocol_type, is_private, registered_by_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, functions=$4, source_files=$6, has_circuit_breaker=$7, is_rwa=$8, rwa_type=$9, version=$10, abi_version=$11, min_ledger=$12, protocol_type=$13`,
      [
        versionedMeta.id,
        versionedMeta.name,
        versionedMeta.description,
        JSON.stringify(versionedMeta.functions),
        versionedMeta.registered_by,
        versionedMeta.source_files ? JSON.stringify(versionedMeta.source_files) : null,
        versionedMeta.has_circuit_breaker ?? false,
        versionedMeta.is_rwa ?? false,
        versionedMeta.rwa_type ?? null,
        versionedMeta.version ?? 1,
        versionedMeta.abi_version,
        versionedMeta.min_ledger ?? 0,
        protocol_type,
        meta.is_private ?? false,
        meta.registered_by_key_id ?? null,
      ],
    );

    // Also store in contract_abi_versions history if abi_version is provided
    if (versionedMeta.abi_version != null) {
      await pool.query(
        `INSERT INTO contract_abi_versions (contract_id, abi_version, min_ledger, functions, registered_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (contract_id, abi_version) DO NOTHING`,
        [
          meta.id,
          meta.abi_version,
          meta.min_ledger ?? 0,
          JSON.stringify(meta.functions ?? []),
          meta.registered_by ?? "",
        ],
      );
    }

    // Also store in contract_versions (legacy) if abi_version is provided
    if (versionedMeta.abi_version != null) {
      await pool.query(
        `INSERT INTO contract_versions (contract_id, abi_version, min_ledger, name, description, functions, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          versionedMeta.id,
          versionedMeta.abi_version,
          versionedMeta.min_ledger ?? 0,
          versionedMeta.name,
          versionedMeta.description,
          JSON.stringify(versionedMeta.functions),
          versionedMeta.registered_by,
        ],
      );
    }

    if (existing && abiVersion > previousAbiVersion) {
      await this.markNeedsRedecode(versionedMeta.id, abiVersion);
    }
  },

  /**
   * Fetch contract metadata that was active at a given ledger.
   * Returns the version whose min_ledger <= target_ledger, ordered by
   * abi_version descending (latest applicable version wins).
   */
  async getContractMetaByLedger(contractId, targetLedger) {
    const { rows } = await pool.query(
      `SELECT * FROM contract_versions
       WHERE contract_id = $1 AND min_ledger <= $2
       ORDER BY abi_version DESC
       LIMIT 1`,
      [contractId, targetLedger],
    );
    return rows[0] ?? null;
  },

  // Circuit breaker status tracking
  async updateCircuitBreakerStatus(contractId, isPaused, ledger, txHash = null) {
    await pool.query(
      `UPDATE contracts
       SET is_paused = $1,
           pause_status_ledger = $2,
           pause_trigger_tx_hash = CASE WHEN $1 THEN $3 ELSE NULL END,
           pause_trigger_event_seq = CASE WHEN $1 THEN (
             SELECT seq FROM events WHERE tx_hash = $3 AND contract_id = $4 ORDER BY seq DESC LIMIT 1
           ) ELSE NULL END
       WHERE id = $4`,
      [isPaused, ledger, txHash, contractId],
    );
  },

  async getCircuitBreakerStatus(contractId) {
    const { rows } = await pool.query(
      `SELECT has_circuit_breaker, is_paused, pause_status_ledger, pause_trigger_tx_hash, pause_trigger_event_seq
       FROM contracts WHERE id = $1`,
      [contractId],
    );
    const row = rows[0] ?? {
      has_circuit_breaker: false,
      is_paused: false,
      pause_status_ledger: null,
      pause_trigger_tx_hash: null,
      pause_trigger_event_seq: null,
    };
    return {
      ...row,
      // Derived from the pause/unpause events the indexer has observed.
      // "HALF-OPEN" is reserved for a future timer-based auto-reset — the
      // detector only flips between these two states today.
      status: row.is_paused ? "OPEN" : "CLOSED",
      // The detector trips as soon as a single pause event is observed
      // (no failure-count threshold is tracked yet).
      trigger_threshold: row.has_circuit_breaker ? 1 : null,
      // No automatic reset timer exists — recovery requires an explicit
      // unpause/resume call, so this is always null today.
      auto_reset_at: null,
    };
  },

  async getMigrationStatus(contractId) {
    const { rows } = await pool.query(
      `SELECT
         MAX(CASE WHEN upgrade_info IS NOT NULL THEN ledger END) AS last_upgrade_ledger,
         MAX(CASE WHEN function = 'migrate' THEN ledger END)     AS last_migrate_ledger
       FROM events WHERE contract_id = $1`,
      [contractId],
    );
    const { last_upgrade_ledger, last_migrate_ledger } = rows[0];
    const pending =
      last_upgrade_ledger != null &&
      (last_migrate_ledger == null || Number(last_upgrade_ledger) > Number(last_migrate_ledger));
    return {
      pending,
      upgradedAtLedger: last_upgrade_ledger ? Number(last_upgrade_ledger) : null,
      migratedAtLedger: last_migrate_ledger ? Number(last_migrate_ledger) : null,
    };
  },

  // ── Vault indexer methods ──────────────────────────────────────────────────────

  async registerVault(vault) {
    await pool.query(
      `INSERT INTO vaults (contract_id, name, underlying_asset, decimals)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (contract_id) DO UPDATE
         SET name=$2, underlying_asset=$3, decimals=$4, updated_at=NOW()`,
      [vault.contract_id, vault.name ?? null, vault.underlying_asset ?? null, vault.decimals ?? 7],
    );
  },

  async unregisterVault(contractId) {
    await pool.query("DELETE FROM vaults WHERE contract_id = $1", [contractId]);
  },

  async getVaults() {
    const { rows } = await pool.query(
      `SELECT v.*,
        (SELECT ratio FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ratio,
        (SELECT ledger FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ledger
       FROM vaults v WHERE v.active = TRUE ORDER BY v.created_at DESC`,
    );
    return rows;
  },

  async getVault(contractId) {
    // Conflict-resolution note (resolved 2026-06-18):
    // feature/vault-pagination added `limit` param; feature/vault-status added `active` filter.
    // Resolution: include both — active filter + optional limit, defaulting to single-record fetch.
    const { rows } = await pool.query(
      `SELECT v.*,
        (SELECT ratio  FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ratio,
        (SELECT ledger FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ledger
       FROM vaults v
       WHERE v.contract_id = $1`,
      [contractId],
    );
    return rows[0] ?? null;
  },

  async getActiveVaultIds() {
    const { rows } = await pool.query("SELECT contract_id FROM vaults WHERE active = TRUE");
    return rows.map((r) => r.contract_id);
  },

  async upsertVaultSnapshot(snapshot) {
    await pool.query(
      `INSERT INTO vault_snapshots (contract_id, ledger, total_assets, total_supply, ratio)
       VALUES ($1,$2,$3,$4,$5)`,
      [snapshot.contract_id, snapshot.ledger, snapshot.total_assets, snapshot.total_supply, snapshot.ratio],
    );
  },

  async getVaultHistory(contractId, { limit = 100 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM vault_snapshots
       WHERE contract_id = $1
       ORDER BY ledger DESC LIMIT $2`,
      [contractId, limit],
    );
    return rows;
  },

  // ── Privileged roles ───────────────────────────────────────────────────────

  /** Upsert a role assignment (or revocation) for a contract. */
  async upsertRole({ contract_id, role, address, revoked = false, ledger = null }) {
    await pool.query(
      `INSERT INTO privileged_roles (contract_id, role, address, revoked, ledger, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (contract_id, role, address)
       DO UPDATE SET revoked = $4, ledger = $5, updated_at = NOW()`,
      [contract_id, role, address, revoked, ledger],
    );
  },

  /** Return all active (non-revoked) role holders for a contract. */
  async getRoles(contractId) {
    const { rows } = await pool.query(
      `SELECT role, address, ledger, updated_at
       FROM privileged_roles
       WHERE contract_id = $1 AND revoked = FALSE
       ORDER BY role, updated_at DESC`,
      [contractId],
    );
    return rows;
  },

  /** Raw query passthrough — used by bulkLoader and pruner. */
  async query(sql, params) {
    return pool.query(sql, params);
  },

  // ── multi-signature source verification ────────────────────────

  /** Submit a verification signature for a contract's WASM hash. */
  async addSourceVerification({ contract_id, wasm_hash, signer, signature, compiler_hash }) {
    await pool.query(
      `INSERT INTO source_verifications (contract_id, wasm_hash, signer, signature, compiler_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contract_id, wasm_hash, signer) DO UPDATE
         SET signature = $4, compiler_hash = $5, submitted_at = NOW()`,
      [contract_id, wasm_hash, signer, signature, compiler_hash],
    );
  },

  /** Return all verification signatures for a contract + wasm_hash pair. */
  async getSourceVerifications(contract_id, wasm_hash) {
    const params = [contract_id];
    const extra = wasm_hash ? ` AND wasm_hash = $2` : "";
    if (wasm_hash) params.push(wasm_hash);
    const { rows } = await pool.query(
      `SELECT signer, signature, compiler_hash, wasm_hash, submitted_at
       FROM source_verifications
       WHERE contract_id = $1${extra}
       ORDER BY submitted_at ASC`,
      params,
    );
    return rows;
  },

  // ── storage state-diff timeline ────────────────────────────────

  /** Persist a batch of storage state diffs for a transaction. */
  async insertStateDiffs(diffs) {
    if (!diffs.length) return;
    const values = diffs
      .map((_, i) => {
        const b = i * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
      })
      .join(",");
    const params = diffs.flatMap((d) => [
      d.contract_id,
      d.ledger,
      d.tx_hash,
      d.key,
      d.tier,
      d.old_value ?? null,
      d.new_value ?? null,
      d.change_type,
    ]);
    await pool.query(
      `INSERT INTO storage_state_diffs
         (contract_id, ledger, tx_hash, key, tier, old_value, new_value, change_type)
       VALUES ${values}
       ON CONFLICT DO NOTHING`,
      params,
    );
  },

  /** Return chronological state diffs for a contract, optionally filtered by key. */
  async getStateDiffs(contract_id, { key, limit = 200 } = {}) {
    const params = [contract_id];
    const extra = key ? ` AND key = $2` : "";
    if (key) params.push(key);
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ledger, tx_hash, key, tier, old_value, new_value, change_type, created_at
       FROM storage_state_diffs
       WHERE contract_id = $1${extra}
       ORDER BY ledger ASC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  // ── Contract stats (#541) ────────────────────────────────────────────────────

  /**
   * Aggregate event/caller counts for a contract, backing GET /api/contracts/:id/stats.
   * Relies on idx_events_contract_caller (migration 010) to stay fast at scale.
   * @param {string} contractId
   * @returns {Promise<{ total_events: number, unique_callers: number, first_seen_ledger: number|null, last_seen_ledger: number|null }>}
   */
  async getContractStats(contractId) {
    const [{ rows: totals }, { rows: callerRows }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::INT AS total_events, MIN(ledger) AS first_seen_ledger, MAX(ledger) AS last_seen_ledger
         FROM events WHERE contract_id = $1`,
        [contractId],
      ),
      // Unique caller addresses via regexp_matches on description + raw_topics + raw_data
      pool.query(
        `SELECT COUNT(DISTINCT a.address)::INT AS unique_callers
         FROM events e
         CROSS JOIN LATERAL (
           SELECT DISTINCT m[1] AS address
           FROM regexp_matches(
             coalesce(e.description, '') || ' ' || coalesce(e.raw_topics::text, '') || ' ' || coalesce(e.raw_data, ''),
             '\\m[GCM][A-Z2-7]{55}\\M',
             'g'
           ) AS m
         ) a
         WHERE e.contract_id = $1`,
        [contractId],
      ),
    ]);
    const row = totals[0];
    return {
      total_events: Number(row.total_events),
      unique_callers: Number(callerRows[0].unique_callers),
      first_seen_ledger: row.first_seen_ledger != null ? Number(row.first_seen_ledger) : null,
      last_seen_ledger: row.last_seen_ledger != null ? Number(row.last_seen_ledger) : null,
    };
  },

  /**
   * Daily event counts for a contract over the trailing `days` days (including
   * today), oldest first. Days with no events are zero-filled so callers get a
   * fixed-length series to render a sparkline/bar chart from.
   * @param {string} contractId
   * @param {number} [days=30]
   * @returns {Promise<{ date: string, count: number }[]>}
   */
  async getContractEventsByDay(contractId, days = 30) {
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 365);
    const { rows } = await pool.query(
      `SELECT d::date AS date, COUNT(e.seq)::INT AS count
       FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, interval '1 day') AS d
       LEFT JOIN events e
         ON e.contract_id = $1
         AND e.created_at >= d
         AND e.created_at < d + interval '1 day'
       GROUP BY d
       ORDER BY d ASC`,
      [contractId, safeDays],
    );
    return rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      count: Number(r.count),
    }));
  },

  // ── Storage tier breakdown (#543) ────────────────────────────────────────────

  /**
   * Aggregate storage-tier write counts for a contract from the per-event
   * storage_tiers JSONB column (populated by storageTierClassifier.js).
   * Backs GET /api/contracts/:id/storage-tiers.
   * @param {string} contractId
   * @returns {Promise<{ temporary: number, persistent: number, instance: number }>}
   */
  async getContractStorageTiers(contractId) {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(jsonb_array_length(COALESCE(storage_tiers->'temporary',  '[]'::jsonb))), 0) AS temporary,
         COALESCE(SUM(jsonb_array_length(COALESCE(storage_tiers->'persistent', '[]'::jsonb))), 0) AS persistent,
         COALESCE(SUM(jsonb_array_length(COALESCE(storage_tiers->'instance',   '[]'::jsonb))), 0) AS instance
       FROM events
       WHERE contract_id = $1 AND storage_tiers IS NOT NULL`,
      [contractId],
    );
    const row = rows[0];
    return {
      temporary: Number(row.temporary),
      persistent: Number(row.persistent),
      instance: Number(row.instance),
    };
  },

  // ── WASM build metadata ────────────────────────────────────────────────────

  async upsertWasmBuildMetadata({
    wasm_hash,
    contract_id,
    size_bytes,
    sdk_version,
    compiler,
    optimizer,
    repository,
    commit,
    producers,
    ledger,
    tx_hash,
  }) {
    await pool.query(
      `INSERT INTO wasm_build_metadata
         (wasm_hash, contract_id, size_bytes, sdk_version, compiler, optimizer, repository, commit, producers, ledger, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (wasm_hash) DO UPDATE SET
         contract_id = COALESCE(EXCLUDED.contract_id, wasm_build_metadata.contract_id),
         size_bytes  = COALESCE(EXCLUDED.size_bytes,  wasm_build_metadata.size_bytes),
         sdk_version = COALESCE(EXCLUDED.sdk_version, wasm_build_metadata.sdk_version),
         compiler    = COALESCE(EXCLUDED.compiler,    wasm_build_metadata.compiler),
         optimizer   = COALESCE(EXCLUDED.optimizer,   wasm_build_metadata.optimizer),
         repository  = COALESCE(EXCLUDED.repository,  wasm_build_metadata.repository),
         commit      = COALESCE(EXCLUDED.commit,      wasm_build_metadata.commit),
         producers   = COALESCE(EXCLUDED.producers,   wasm_build_metadata.producers)`,
      [
        wasm_hash,
        contract_id ?? null,
        size_bytes ?? null,
        sdk_version ?? null,
        compiler ?? null,
        optimizer ?? null,
        repository ?? null,
        commit ?? null,
        producers ? JSON.stringify(producers) : null,
        ledger ?? null,
        tx_hash ?? null,
      ],
    );
  },

  async getWasmBuildMetadata(contract_id) {
    const { rows } = await pool.query(
      `SELECT * FROM wasm_build_metadata WHERE contract_id = $1 ORDER BY ledger DESC LIMIT 1`,
      [contract_id],
    );
    return rows[0] ?? null;
  },

  /** persist sub-invocation records. */
  async upsertSubInvocations(records) {
    if (!records.length) return;
    const values = records
      .map((r, i) => {
        const base = i * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(", ");
    const params = records.flatMap((r) => [
      r.parent_tx_hash,
      r.depth,
      r.contract_id,
      r.function,
      r.args ? JSON.stringify(r.args) : null,
      r.ledger,
    ]);
    await pool.query(
      `INSERT INTO sub_invocations (parent_tx_hash, depth, contract_id, function, args, ledger)
       VALUES ${values} ON CONFLICT DO NOTHING`,
      params,
    );
  },

  async getSubInvocationsByTransaction(txHash, limit = 200) {
    const { rows } = await pool.query(
      `SELECT id, parent_tx_hash, depth, contract_id, function, args, ledger
       FROM sub_invocations
       WHERE parent_tx_hash = $1
       ORDER BY depth ASC, id ASC
       LIMIT $2`,
      [txHash, limit],
    );
    return rows;
  },

  /** aggregate caller→callee edges for the global dependency graph. */
  async getSubInvocationEdges(limit = 500) {
    const { rows } = await pool.query(
      `SELECT e.contract_id AS caller, s.contract_id AS callee, COUNT(*) AS call_count
       FROM sub_invocations s
       JOIN events e ON e.tx_hash = s.parent_tx_hash
       WHERE e.contract_id <> s.contract_id
       GROUP BY e.contract_id, s.contract_id
       ORDER BY call_count DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      caller: r.caller,
      callee: r.callee,
      call_count: Number(r.call_count),
    }));
  },

  /** top callee contracts invoked by a single contract, most-called first. */
  async getContractCallGraph(contractId, limit = 10) {
    const { rows } = await pool.query(
      `SELECT s.contract_id AS callee, COUNT(*) AS call_count
       FROM sub_invocations s
       JOIN events e ON e.tx_hash = s.parent_tx_hash
       WHERE e.contract_id = $1 AND s.contract_id <> $1
       GROUP BY s.contract_id
       ORDER BY call_count DESC
       LIMIT $2`,
      [contractId, limit],
    );
    return rows.map((r) => ({
      callee: r.callee,
      call_count: Number(r.call_count),
    }));
  },

  // ── Token holders ──────────────────────────────────────────────────────────

  async getTokenHolders(contractId) {
    const { rows } = await pool.query(
      `SELECT address, balance_raw FROM token_holders
       WHERE contract_id = $1
       ORDER BY balance_raw::NUMERIC DESC`,
      [contractId],
    );
    return rows;
  },

  async applyTransfer(contractId, from, to, amount) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO token_holders (contract_id, address, balance_raw)
         VALUES ($1, $2, $3)
         ON CONFLICT (contract_id, address)
         DO UPDATE SET balance_raw = (COALESCE(NULLIF(token_holders.balance_raw, ''), '0')::NUMERIC - $3::NUMERIC)::TEXT`,
        [contractId, from, amount],
      );
      await client.query(
        `INSERT INTO token_holders (contract_id, address, balance_raw)
         VALUES ($1, $2, $3)
         ON CONFLICT (contract_id, address)
         DO UPDATE SET balance_raw = (COALESCE(NULLIF(token_holders.balance_raw, ''), '0')::NUMERIC + $3::NUMERIC)::TEXT`,
        [contractId, to, amount],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async applyMint(contractId, to, amount) {
    await pool.query(
      `INSERT INTO token_holders (contract_id, address, balance_raw)
       VALUES ($1, $2, $3)
       ON CONFLICT (contract_id, address)
       DO UPDATE SET balance_raw = (COALESCE(NULLIF(token_holders.balance_raw, ''), '0')::NUMERIC + $3::NUMERIC)::TEXT`,
      [contractId, to, amount],
    );
  },

  async applyBurn(contractId, from, amount) {
    await pool.query(
      `INSERT INTO token_holders (contract_id, address, balance_raw)
       VALUES ($1, $2, $3)
       ON CONFLICT (contract_id, address)
       DO UPDATE SET balance_raw = (COALESCE(NULLIF(token_holders.balance_raw, ''), '0')::NUMERIC - $3::NUMERIC)::TEXT`,
      [contractId, from, amount],
    );
  },

  // ── NFT token queries ──────────────────────────────────────────────────────

  /**
   * Return all minted NFT tokens for a collection contract, with page-based
   * pagination and optional owner-address filter.
   *
   * Each row in token_holders where token_id IS NOT NULL represents one
   * minted NFT. The current owner is the `address` column.
   *
   * @param {string} contractId
   * @param {{ owner?: string, page?: number, limit?: number }} opts
   * @returns {Promise<{ tokens: object[], total: number }>}
   */
  async getNftTokens(contractId, { owner, page = 1, limit = 50 } = {}) {
    const pageN = Math.max(1, Number(page) || 1);
    const limitN = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = (pageN - 1) * limitN;

    const params = [contractId];
    let ownerFilter = "";
    if (owner) {
      params.push(owner);
      ownerFilter = `AND address = $${params.length}`;
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total
       FROM token_holders
       WHERE contract_id = $1 AND token_id IS NOT NULL ${ownerFilter}`,
      params,
    );
    const total = Number(countRows[0].total);

    params.push(limitN, offset);
    const { rows } = await pool.query(
      `SELECT token_id, address AS owner, metadata_json, last_transfer_ledger
       FROM token_holders
       WHERE contract_id = $1 AND token_id IS NOT NULL ${ownerFilter}
       ORDER BY token_id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      tokens: rows.map((r) => ({
        token_id: r.token_id,
        owner: r.owner,
        metadata: r.metadata_json ?? null,
        last_transfer_ledger: r.last_transfer_ledger != null ? Number(r.last_transfer_ledger) : null,
      })),
      total,
    };
  },

  /**
   * Return all minted NFT tokens for a collection contract, with cursor-based
   * (keyset) pagination via the `after` parameter and optional owner filter.
   *
   * Each row in token_holders where token_id IS NOT NULL represents one
   * minted NFT. Mint metadata (minted_ledger, minted_by) is derived from the
   * earliest event referencing the token holder.
   *
   * @param {string} contractId
   * @param {{ owner?: string, after?: string, limit?: number }} opts
   *   after — the last `token_id` from the previous page (opaque cursor).
   *           Omit for the first page. Sorted by token_id ASC.
   * @returns {Promise<{ tokens: object[], next_cursor: string|null }>}
   */
  async getNftTokensCursor(contractId, { owner, after, limit = 50 } = {}) {
    const limitN = Math.min(200, Math.max(1, Number(limit) || 50));

    const params = [contractId];
    let ownerFilter = "";
    if (owner) {
      params.push(owner);
      ownerFilter = `AND th.address = $${params.length}`;
    }

    let afterFilter = "";
    if (after) {
      params.push(after);
      afterFilter = `AND th.token_id::NUMERIC > $${params.length}`;
    }

    // Fetch limit+1 to detect whether a next page exists
    params.push(limitN + 1);
    const { rows } = await pool.query(
      `SELECT th.token_id,
              th.address AS owner_address,
              th.metadata_json,
              th.last_transfer_ledger,
              th.minted_ledger,
              th.minted_by
       FROM token_holders th
       WHERE th.contract_id = $1
         AND th.token_id IS NOT NULL
         ${ownerFilter}
         ${afterFilter}
       ORDER BY th.token_id::NUMERIC ASC
       LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limitN;
    const data = hasMore ? rows.slice(0, limitN) : rows;
    const next_cursor = hasMore ? String(data[data.length - 1].token_id) : null;

    return {
      tokens: data.map((r) => ({
        token_id: r.token_id,
        owner_address: r.owner_address,
        minted_ledger: r.minted_ledger != null ? Number(r.minted_ledger) : null,
        minted_by: r.minted_by,
        last_transfer_ledger: r.last_transfer_ledger != null ? Number(r.last_transfer_ledger) : null,
      })),
      next_cursor,
    };
  },

  /**
   * Return the full transfer + mint history for a single NFT token,
   * sourced from the events table.
   *
   * @param {string} contractId
   * @param {string} tokenId
   * @returns {Promise<object[]>}
   */
  async getNftTokenHistory(contractId, tokenId) {
    const { rows } = await pool.query(
      `SELECT seq, function, ledger, tx_hash, description, raw_topics, created_at
       FROM events
       WHERE contract_id = $1
         AND (raw_topics::text ILIKE $2 OR description ILIKE $2)
       ORDER BY ledger ASC, seq ASC
       LIMIT 500`,
      [contractId, `%${tokenId}%`],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      function: r.function,
      ledger: Number(r.ledger),
      tx_hash: r.tx_hash,
      description: r.description,
      raw_topics: r.raw_topics,
      created_at: r.created_at,
    }));
  },

  /**
   * Collection-level NFT analytics (issue #810): mint volume over time and a
   * unique-holder-count trend, derived from already-indexed NFT mint/transfer
   * events in the events table.
   *
   * Mint events are `mint_nft` / `create` (the decoder's NFT mint functions,
   * #562). Transfers are `transfer` events on the collection contract. The
   * holder curve counts distinct recipient addresses from mint + transfer
   * events, cumulatively, over the rolling window.
   *
   * Recipient extraction prefers the structured `raw_topics` layout
   * (topics[0]=fn, so topics[1] is the recipient for mint, topics[2] for
   * transfer) and falls back to the decoded description text.
   *
   * @param {string} contractId
   * @param {number} [days=30]  Rolling window length, clamped to 7..365.
   * @returns {Promise<{
   *   contract_id: string,
   *   days: number,
   *   totals: { minted: number, transfers: number, unique_holders: number },
   *   mint_volume: { date: string, count: number }[],
   *   holder_count: { date: string, count: number }[]
   * }>}
   */
  async getNftCollectionAnalytics(contractId, days = 30) {
    const daysN = Math.min(365, Math.max(7, Number(days) || 30));

    const recipientExpr = (table) =>
      `CASE
         WHEN ${table}.function = 'transfer'
           THEN COALESCE(NULLIF(${table}.raw_topics->>2, ''),
                        (regexp_match(COALESCE(${table}.description, ''), ' to ([GCM][A-Z2-7]{55})'))[1])
         ELSE COALESCE(NULLIF(${table}.raw_topics->>1, ''),
                       (regexp_match(COALESCE(${table}.description, ''), '\\m[GCM][A-Z2-7]{55}\\M'))[1])
       END`;

    const [totalsRes, mintRes, holderDailyRes, holderTotalRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE function IN ('mint_nft', 'create'))::INT AS minted,
           COUNT(*) FILTER (WHERE function = 'transfer')::INT AS transfers
         FROM events
         WHERE contract_id = $1`,
        [contractId],
      ),
      // Daily mint volume within the rolling window
      pool.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS date, COUNT(*)::INT AS count
         FROM events
         WHERE contract_id = $1
           AND function IN ('mint_nft', 'create')
           AND created_at >= NOW() - make_interval(days => $2)
         GROUP BY date
         ORDER BY date`,
        [contractId, daysN],
      ),
      // Per-day *new* recipients within the rolling window — each address is
      // counted only on the first day it appears, so the cumulative curve in
      // JS reflects the true distinct-holder count up to each day.
      pool.query(
        `WITH recipients AS (
           SELECT to_char(created_at, 'YYYY-MM-DD') AS date,
                  ${recipientExpr("e")} AS recipient
           FROM events e
           WHERE e.contract_id = $1
             AND e.function IN ('mint_nft', 'create', 'transfer')
             AND e.created_at >= NOW() - make_interval(days => $2)
         ),
         first_seen AS (
           SELECT date, recipient,
                  ROW_NUMBER() OVER (PARTITION BY recipient ORDER BY date) AS rn
           FROM recipients
           WHERE recipient ~ '^[GCM][A-Z2-7]{55}$'
         )
         SELECT date, COUNT(*) FILTER (WHERE rn = 1)::INT AS count
         FROM first_seen
         GROUP BY date
         ORDER BY date`,
        [contractId, daysN],
      ),
      // All-time distinct recipients — the collection's unique holder count
      pool.query(
        `WITH recipients AS (
           SELECT ${recipientExpr("e")} AS recipient
           FROM events e
           WHERE e.contract_id = $1
             AND e.function IN ('mint_nft', 'create', 'transfer')
         )
         SELECT COUNT(DISTINCT recipient)::INT AS unique_holders
         FROM recipients
         WHERE recipient ~ '^[GCM][A-Z2-7]{55}$'`,
        [contractId],
      ),
    ]);

    const mintByDate = new Map(mintRes.rows.map((r) => [r.date, r.count]));
    const holdersByDate = new Map(holderDailyRes.rows.map((r) => [r.date, r.count]));

    // Zero-fill the daily series and build the cumulative holder curve, so the
    // frontend charts never see gaps (same convention as getContractStats).
    const mint_volume = [];
    const holder_count = [];
    let cumulative = 0;
    for (let i = daysN - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      mint_volume.push({ date, count: mintByDate.get(date) ?? 0 });
      cumulative += holdersByDate.get(date) ?? 0;
      holder_count.push({ date, count: cumulative });
    }

    return {
      contract_id: contractId,
      days: daysN,
      totals: {
        minted: totalsRes.rows[0].minted,
        transfers: totalsRes.rows[0].transfers,
        unique_holders: holderTotalRes.rows[0].unique_holders,
      },
      mint_volume,
      holder_count,
    };
  },

  // ── Predictive Gap Detection helpers ────────────────────────────────────────

  /**
   * Update the status of a gap_log entry.
   *
   * @param {number} id
   * @param {string} status  "closed" | "failed" | "pending"
   */
  async updateGapLogStatus(id, status) {
    await pool.query(`UPDATE gap_log SET status = $1, closed_at = NOW(), updated_at = NOW() WHERE id = $2`, [
      status,
      id,
    ]);
  },

  /**
   * Get pending gaps (sorted by from_ledger ascending).
   *
   * @returns {Promise<{ id: number, from: number, to: number, size: number }[]>}
   */
  async getPendingGaps() {
    const { rows } = await pool.query(
      `SELECT id, from_ledger AS "from", to_ledger AS "to", size
       FROM gap_log
       WHERE status = 'open'
       ORDER BY from_ledger ASC`,
    );
    return rows;
  },

  /**
   * Count gaps closed in the last 24 hours.
   *
   * @returns {Promise<number>}
   */
  async getClosedGapCount24h() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INT AS total FROM gap_log
       WHERE status = 'closed' AND closed_at >= NOW() - INTERVAL '24 hours'`,
    );
    return rows[0].total;
  },

  // data export — events (CSV/JSON)
  // #528: accepts optional wallet address to filter events by address mention.
  async getEventsForExport({ contract, fn, type, wallet, after_seq = 0, limit = 10000 } = {}) {
    const conditions = [];
    const params = [];
    if (contract) {
      params.push(contract);
      conditions.push(`contract_id = $${params.length}`);
    }
    if (fn) {
      params.push(fn);
      conditions.push(`function = $${params.length}`);
    }
    if (type === "soroban") {
      conditions.push(`contract_id IS NOT NULL AND contract_id <> ''`);
    }
    if (type === "classic") {
      conditions.push(`(contract_id IS NULL OR contract_id = '')`);
    }
    // #528: filter by wallet address — look for the address in description/topics/data
    if (wallet) {
      params.push(wallet);
      conditions.push(
        `to_tsvector('simple',
           coalesce(description, '') || ' ' ||
           coalesce(raw_topics::text, '') || ' ' ||
           coalesce(raw_data, '')
         ) @@ plainto_tsquery('simple', $${params.length})`,
      );
    }
    if (after_seq > 0) {
      params.push(after_seq);
      conditions.push(`e.seq < $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(limit, 10000) + 1);
    const { rows } = await pool.query(
      `SELECT e.seq, e.contract_id, c.name AS contract_name, e.function,
              e.ledger, e.tx_hash, e.description, e.created_at
       FROM events e
       LEFT JOIN contracts c ON c.id = e.contract_id
       ${where} ORDER BY e.seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  // data export — registered contracts (CSV/JSON)
  async getContractsForExport({ after, limit = 1000 } = {}) {
    const params = [];
    let where = "";
    if (after) {
      let cursor;
      try {
        if (typeof after !== "string" || after.length > 512) throw new Error();
        cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid contracts cursor");
      }
      if (!cursor.created_at || !Number.isFinite(Date.parse(cursor.created_at)) || !cursor.id) {
        throw new Error("Invalid contracts cursor");
      }
      params.push(cursor.created_at, cursor.id);
      where = `WHERE (created_at, id) < ($1::timestamptz, $2)`;
    }
    params.push(Math.min(limit, 10000) + 1);
    const { rows } = await pool.query(
      `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused, is_rwa, rwa_type, created_at
       FROM contracts ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async getTopContracts(limit = 10) {
    const { rows } = await pool.query(
      `SELECT contract_id, COUNT(*) AS event_count
       FROM events
       WHERE contract_id IS NOT NULL AND contract_id <> ''
       GROUP BY contract_id
       ORDER BY event_count DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  },

  // ── Gap detection helpers ──────────────────────────────────────────────

  /**
   * Return the N most recent distinct ledger numbers from the events table,
   * ordered ascending. Used by the predictive gap detector to scan for gaps.
   *
   * @param {number} n  Number of recent ledgers to fetch (default 100)
   * @returns {Promise<number[]>}  Sorted ascending array of ledger numbers
   */
  async getRecentLedgers(n = 100) {
    const { rows } = await pool.query(`SELECT DISTINCT ledger FROM events ORDER BY ledger DESC LIMIT $1`, [n]);
    return rows.map((r) => Number(r.ledger)).sort((a, b) => a - b);
  },

  /**
   * Insert a detected gap into the gap_log table.
   * Returns the new row id.
   */
  async insertGapLog(from, to, size) {
    const { rows } = await pool.query(
      `INSERT INTO gap_log (from_ledger, to_ledger, size)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [from, to, size],
    );
    return rows[0].id;
  },

  /**
   * Mark a gap_log entry as closed (successfully re-indexed).
   */
  async closeGapLog(id) {
    await pool.query(`UPDATE gap_log SET status = 'closed', closed_at = NOW() WHERE id = $1`, [id]);
  },

  /**
   * Mark a gap_log entry as sent to the dead-letter queue after exhausting retries.
   */
  async dlqGapLog(id) {
    await pool.query(`UPDATE gap_log SET status = 'dlq', closed_at = NOW() WHERE id = $1`, [id]);
  },

  /**
   * Increment the retry counter on a gap_log entry.
   */
  async incrementGapRetries(id) {
    await pool.query(`UPDATE gap_log SET retries = retries + 1 WHERE id = $1`, [id]);
  },

  /**
   * Mark a contract as verified (or unverified) against the on-chain ABI.
   *
   * @param {string} contractId
   * @param {boolean} isVerified
   * @param {number|null} ledger  — ledger at which verification was confirmed
   */
  async setContractVerified(contractId, isVerified, ledger = null) {
    await pool.query(
      `UPDATE contracts
       SET is_verified = $2,
           verified_at = CASE WHEN $2 THEN NOW() ELSE verified_at END,
           verified_ledger = CASE WHEN $2 THEN $3 ELSE verified_ledger END
       WHERE id = $1`,
      [contractId, isVerified, ledger],
    );
  },

  /**
   * Issue #875 — mirror the explorer contract's `get_ownership` result.
   * @param {string} contractId
   * @param {{ owner: string, method: string, ledger: number } | null} ownership
   */
  async setContractOwnership(contractId, ownership) {
    await pool.query(
      `UPDATE contracts
       SET ownership_verified = $2,
           ownership_owner = $3,
           ownership_method = $4,
           ownership_ledger = $5
       WHERE id = $1`,
      [
        contractId,
        ownership !== null,
        ownership?.owner ?? null,
        ownership?.method ?? null,
        ownership?.ledger ?? null,
      ],
    );
  },

  // ── Issue #517: ABI version history ───────────────────────────────────────

  /**
   * Return the full ABI version history for a contract in ascending version order.
   * Each row represents a snapshot of the functions array at a given abi_version.
   *
   * @param {string} contractId
   * @returns {Promise<{ abi_version: number, functions: object[], registered_by: string, min_ledger: number, created_at: string }[]>}
   */
  async getContractAbiHistory(contractId) {
    const { rows } = await pool.query(
      `SELECT abi_version, functions, registered_by, min_ledger, created_at
       FROM contract_abi_versions
       WHERE contract_id = $1
       ORDER BY abi_version ASC`,
      [contractId],
    );
    return rows.map((r) => ({
      abi_version: r.abi_version,
      functions: parseJsonField(r.functions, []),
      registered_by: r.registered_by,
      min_ledger: r.min_ledger,
      created_at: r.created_at,
    }));
  },

  /**
   * Insert a new ABI version snapshot.
   * Called by the decoder when it detects an update_contract event.
   * No-op if the (contract_id, abi_version) pair already exists.
   *
   * @param {{ contract_id: string, abi_version: number, functions: object[], registered_by: string, min_ledger: number }} entry
   */
  async insertAbiVersionSnapshot(entry) {
    await pool.query(
      `INSERT INTO contract_abi_versions
         (contract_id, abi_version, functions, registered_by, min_ledger)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contract_id, abi_version) DO NOTHING`,
      [
        entry.contract_id,
        entry.abi_version,
        JSON.stringify(entry.functions ?? []),
        entry.registered_by ?? "",
        entry.min_ledger ?? 0,
      ],
    );
  },

  // ── Issue #518: protocol_type ──────────────────────────────────────────────

  /**
   * Derive a protocol_type from the contract's function names using heuristics.
   *
   * Rules (in priority order):
   *   swap | swap_exact          → 'dex'
   *   supply | borrow            → 'lending'
   *   mint + transfer (no swap)  → 'token'
   *   otherwise                  → 'other'
   *
   * @param {string[]} functionNames  Array of function name strings
   * @returns {'dex'|'lending'|'token'|'other'}
   */
  inferProtocolType(functionNames) {
    const names = (functionNames ?? []).map((n) => String(n).toLowerCase());
    if (names.some((n) => n === "swap" || n === "swap_exact")) return "dex";
    if (names.some((n) => n === "supply" || n === "borrow")) return "lending";
    if (names.includes("mint") && names.includes("transfer")) return "token";
    return "other";
  },

  /**
   * Return gap stats for the GET /api/gaps endpoint.
   */
  async getGapLogStats() {
    const [pending, closed24h] = await Promise.all([
      pool.query(
        `SELECT from_ledger, to_ledger, size FROM gap_log
         WHERE status = 'open'
         ORDER BY from_ledger ASC`,
      ),
      pool.query(
        `SELECT COUNT(*)::INT AS total FROM gap_log
         WHERE status = 'closed' AND closed_at >= NOW() - INTERVAL '24 hours'`,
      ),
    ]);
    return {
      pending: pending.rows.map((r) => ({
        from: Number(r.from_ledger),
        to: Number(r.to_ledger),
        size: Number(r.size),
      })),
      closed_last_24h: closed24h.rows[0].total,
    };
  },

  // ── classic asset metadata cache (#546) / token metadata registry (#550) ────
  async getAsset(code, issuer) {
    const { rows } = await pool.query("SELECT * FROM assets WHERE code = $1 AND issuer = $2", [code, issuer]);
    return rows[0] ?? null;
  },

  async upsertAsset({ code, issuer, name, domain, logo_url, decimals }) {
    const { rows } = await pool.query(
      `INSERT INTO assets (code, issuer, name, domain, logo_url, decimals)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code, issuer) DO UPDATE
         SET name = EXCLUDED.name, domain = EXCLUDED.domain, logo_url = EXCLUDED.logo_url,
             decimals = EXCLUDED.decimals, resolved_at = NOW()
       RETURNING *`,
      [code, issuer, name ?? null, domain ?? null, logo_url ?? null, decimals ?? 7],
    );
    return rows[0];
  },

  /**
   * Paginated list of every asset seen in indexed events, newest-resolved first.
   * Keyset (cursor) pagination on the monotonic `id` column (#550).
   * @param {{ after_id?: number, limit?: number }} opts
   * @returns {Promise<{ data: object[], next_cursor: number|null }>}
   */
  async listAssets({ after_id = 0, limit = 25 } = {}) {
    const params = [];
    const conditions = [];

    if (after_id > 0) {
      params.push(after_id);
      conditions.push(`id < $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit + 1); // fetch one extra to detect next page

    const { rows } = await pool.query(
      `SELECT id, code, issuer, name, domain, logo_url, decimals, resolved_at
       FROM assets ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor = hasMore ? Number(data[data.length - 1].id) : null;

    return { data, next_cursor };
  },

  // ── Webhook subscriptions ────────────────────────────────────────────────────

  /** Number of consecutive delivery failures after which a subscription is auto-disabled. */
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: 5,

  async createWebhookSubscription({ api_key_id, url, contract_id, function_filter, wallet_address, secret, filter }) {
    const { rows } = await pool.query(
      `INSERT INTO webhook_subscriptions (api_key_id, url, contract_id, function_filter, wallet_address, secret, filter)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, api_key_id, url, contract_id, function_filter, wallet_address, filter, active, failure_count, created_at, last_triggered_at`,
      [api_key_id, url, contract_id ?? null, function_filter ?? null, wallet_address ?? null, encryptSecret(secret), filter ? JSON.stringify(filter) : null],
    );
    return rows[0];
  },

  /** List subscriptions for one API key, excluding the signing secret. */
  async listWebhookSubscriptions(apiKeyId) {
    const { rows } = await pool.query(
      `SELECT id, api_key_id, url, contract_id, function_filter, wallet_address, active, failure_count, created_at, last_triggered_at
       FROM webhook_subscriptions
       WHERE api_key_id = $1
       ORDER BY created_at DESC`,
      [apiKeyId],
    );
    return rows;
  },

  /** Fetch one subscription including its secret (for signing outbound requests). */
  async getWebhookSubscription(id) {
    const { rows } = await pool.query(`SELECT * FROM webhook_subscriptions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async deactivateWebhookSubscription(id, apiKeyId) {
    const { rows } = await pool.query(
      `UPDATE webhook_subscriptions SET active = FALSE
       WHERE id = $1 AND api_key_id = $2
       RETURNING id, api_key_id, url, contract_id, function_filter, wallet_address, active, failure_count, created_at, last_triggered_at`,
      [id, apiKeyId],
    );
    return rows[0] ?? null;
  },

  /**
   * Active subscriptions that pass the coarse contract/function filter, plus
   * every active wallet-address subscription. The caller
   * (webhookDelivery.deliverWebhooksForEvent) applies the per-wallet match.
   */
  async getMatchingWebhookSubscriptions(contractId, functionName) {
    const { rows } = await pool.query(
      `SELECT * FROM webhook_subscriptions
       WHERE active = TRUE
         AND (contract_id IS NULL OR contract_id = $1)
         AND (function_filter IS NULL OR function_filter = $2)
         AND (wallet_address IS NULL)`,
      [contractId ?? null, functionName ?? null],
    );

    // Also get wallet-address subscriptions (wallet matching is done in webhookDelivery.js)
    const { rows: walletRows } = await pool.query(
      `SELECT * FROM webhook_subscriptions
       WHERE active = TRUE
         AND wallet_address IS NOT NULL`,
    );

    return [...rows, ...walletRows];
  },

  /**
   * Record the outcome of a delivery attempt, and update the subscription's
   * consecutive-failure counter — auto-disabling it once the threshold is hit.
   */
  async recordWebhookDelivery({
    webhook_id,
    event_seq,
    url,
    request_body,
    response_status,
    response_body,
    duration_ms,
    success,
  }) {
    const { rows } = await pool.query(
      `INSERT INTO webhook_deliveries
         (webhook_id, event_seq, url, request_body, response_status, response_body, duration_ms, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        webhook_id,
        event_seq ?? null,
        url,
        request_body,
        response_status ?? null,
        response_body ?? null,
        duration_ms ?? null,
        success ? new Date() : null,
      ],
    );

    if (success) {
      await pool.query(`UPDATE webhook_subscriptions SET failure_count = 0, last_triggered_at = NOW() WHERE id = $1`, [
        webhook_id,
      ]);
    } else {
      await pool.query(
        `UPDATE webhook_subscriptions
         SET failure_count = failure_count + 1,
             active = (failure_count + 1) < $2,
             last_triggered_at = NOW()
         WHERE id = $1`,
        [webhook_id, this.WEBHOOK_MAX_CONSECUTIVE_FAILURES],
      );
    }

    return rows[0];
  },

  async listWebhookDeliveries(webhookId, { page = 1, limit = 25 } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 25), 100);
    const offset = (safePage - 1) * safeLimit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, webhook_id, event_seq, url, response_status, response_body, duration_ms, delivered_at, created_at
         FROM webhook_deliveries
         WHERE webhook_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [webhookId, safeLimit, offset],
      ),
      pool.query(`SELECT COUNT(*)::INT AS total FROM webhook_deliveries WHERE webhook_id = $1`, [webhookId]),
    ]);

    const total = countRows[0].total;
    return {
      data: rows,
      pagination: { page: safePage, limit: safeLimit, total, total_pages: Math.ceil(total / safeLimit) },
    };
  },

  /** Total webhook delivery attempts ever made across all of one API key's subscriptions ("events received"). */
  async countWebhookDeliveriesForApiKey(apiKeyId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INT AS total
       FROM webhook_deliveries d
       JOIN webhook_subscriptions w ON w.id = d.webhook_id
       WHERE w.api_key_id = $1`,
      [apiKeyId],
    );
    return rows[0].total;
  },

  /** Fetch one delivery row together with its parent subscription (for retry/ownership checks). */
  async getWebhookDeliveryWithSubscription(deliveryId) {
    const { rows } = await pool.query(
      `SELECT d.*, w.api_key_id, w.url AS webhook_url, w.secret, w.active AS webhook_active
       FROM webhook_deliveries d
       JOIN webhook_subscriptions w ON w.id = d.webhook_id
       WHERE d.id = $1`,
      [deliveryId],
    );
    return rows[0] ?? null;
  },
};

function normalizeSearchTerms(q) {
  return String(q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

function clampLimit(limit, fallback, max) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function escapeLike(value) {
  return String(value).replace(/([%_\\])/g, "\\$1");
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
