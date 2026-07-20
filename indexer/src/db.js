import pg from "pg";
import { runMigrations } from "./migrate.js";
import { validateAndSanitizeDecodedEvent } from "./decoderValidator.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Exported for pool metric collection — do not use for queries outside db.js. */
export { pool };

export const db = {
  /** Run all pending SQL migrations from indexer/migrations/. */
  async init() {
    await runMigrations(pool);
  },

  async getMaxLedger() {
    const { rows } = await pool.query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events");
    return Number(rows[0].max_ledger);
  },

  // ── daemon cursor persistence ──────────────────────────────────
  async saveCursor(ledger) {
    await pool.query(
      `INSERT INTO daemon_state (key, value) VALUES ('cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(ledger)],
    );
  },

  async loadCursor() {
    const { rows } = await pool.query("SELECT value FROM daemon_state WHERE key = 'cursor'");
    return rows[0] ? Number(rows[0].value) : null;
  },

  // ── ledger reorganization state ───────────────────────────────
  async recordLedgerHash(ledger, hash) {
    await pool.query(
      `INSERT INTO ledger_hashes (ledger, hash)
       VALUES ($1, $2)
       ON CONFLICT (ledger) DO NOTHING`,
      [ledger, hash],
    );
  },

  async getRecentLedgerHashes(limit) {
    const { rows } = await pool.query(
      "SELECT ledger, hash FROM ledger_hashes ORDER BY ledger DESC LIMIT $1",
      [limit],
    );
    return rows;
  },

  /** Atomically purge orphaned data and persist the daemon rewind cursor. */
  async rollbackFromLedger(forkLedger) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM events WHERE ledger >= $1", [forkLedger]);
      await client.query("DELETE FROM ledger_hashes WHERE ledger >= $1", [forkLedger]);
      await client.query(
        `INSERT INTO daemon_state (key, value) VALUES ('cursor', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(forkLedger)],
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
   *           after_seq?: number, limit?: number }} opts
   *   after_seq — the `seq` of the last event on the previous page (opaque cursor).
   *               Omit (or pass 0) for the first page.
   * @returns {{ data: object[], next_cursor: number|null }}
   */
  async getEventsCursor({ contract, fn, type, after_seq = 0, limit = 25 } = {}) {
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

    // Keyset: fetch rows with seq < after_seq (descending) or all rows for first page
    if (after_seq > 0) {
      params.push(after_seq);
      conditions.push(`seq < $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit + 1); // fetch one extra to detect next page

    const { rows } = await pool.query(
      `SELECT * FROM events ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const next_cursor = hasMore ? data[data.length - 1].seq : null;

    return { data, next_cursor };
  },

  async upsertEvent(ev) {
    await pool.query(
      `INSERT INTO events
         (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data,
          cpu_instructions, mem_bytes, fee_charged, is_high_bloat_risk, upgrade_info, storage_tiers, is_clawback,
          footprint_contention, ttl_extension, fee_bump, archival_info, zk_host_calls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT DO NOTHING`,
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
      ],
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
    await this.upsertEvent(validated);
  },

  async getEvents({ contract, fn, page = 1, limit = 25, type } = {}) {
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
    // filter by transaction type
    // "soroban"  → contract_id is non-empty (Soroban invocations/deployments)
    // "classic"  → contract_id is empty string or NULL
    if (type === "soroban") {
      conditions.push(`contract_id IS NOT NULL AND contract_id <> ''`);
    }
    if (type === "classic") {
      conditions.push(`(contract_id IS NULL OR contract_id = '')`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  },

  async getEvent(seq) {
    const sql = "SELECT * FROM events WHERE seq = $1";
    const { rows } = await pool.query(sql, [seq]);
    return rows[0] ?? null;
  },

  async getWalletEvents(address) {
    // Use the GIN full-text index via plainto_tsquery so the query uses the
    // idx_events_search_fts index instead of a full-table raw_topics::text scan.
    const { rows } = await pool.query(
      `SELECT * FROM events
       WHERE to_tsvector('simple',
         coalesce(description, '') || ' ' ||
         coalesce(raw_topics::text, '') || ' ' ||
         coalesce(raw_data, '')
       ) @@ plainto_tsquery('simple', $1)
       ORDER BY ledger DESC
       LIMIT 100`,
      [address],
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
       GROUP BY c.id
       ORDER BY event_count DESC, c.name ASC
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
      `SELECT * FROM events
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

    const params = terms.map((term) => pushParam(params, `%${escapeLike(term)}%`));
    params.push(clampLimit(limit, 10, 50));

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
         WHERE a.address ILIKE ANY($${params.length})
         UNION
         SELECT NULL::BIGINT AS seq, NULL::BIGINT AS ledger, contract_id, address
         FROM privileged_roles
         WHERE address ILIKE ANY($${params.length}) AND revoked = FALSE
         UNION
         SELECT NULL::BIGINT AS seq, NULL::BIGINT AS ledger, contract_id, address
         FROM token_holders
         WHERE address ILIKE ANY($${params.length})
       )
       SELECT address,
              COUNT(seq) AS event_count,
              MIN(ledger) AS first_seen_ledger,
              MAX(ledger) AS last_seen_ledger,
              ARRAY_AGG(DISTINCT contract_id) FILTER (WHERE contract_id IS NOT NULL AND contract_id <> '') AS contracts
       FROM address_hits
       GROUP BY address
       ORDER BY event_count DESC, last_seen_ledger DESC NULLS LAST, address ASC
       LIMIT $${params.length}`,
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

  async listContracts({ page = 1, limit = 25 } = {}) {
    const offset = (page - 1) * limit;
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused, is_rwa, rwa_type, created_at
         FROM contracts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      pool.query("SELECT COUNT(*)::INT AS total FROM contracts"),
    ]);
    const total = countRows[0].total;
    return {
      contracts: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    };
  },

  async getContractMeta(id) {
    const sql = "SELECT * FROM contracts WHERE id = $1";
    const { rows } = await pool.query(sql, [id]);
    return rows[0] ?? null;
  },

  /**
   * paginated contract transaction history with optional filters.
   * @param {string} contractId
   * @param {{ function_name?: string, start_ledger?: number, end_ledger?: number, page?: number, limit?: number }} opts
   */
  async getContractTransactions(contractId, { function_name, start_ledger, end_ledger, page = 1, limit = 25 } = {}) {
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

    const where = conditions.join(" AND ");
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT * FROM events WHERE ${where} ORDER BY ledger DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*)::INT AS total FROM events WHERE ${where}`, params),
    ]);

    const total = countRows[0].total;
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page * limit < total,
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
    await pool.query(
      `INSERT INTO contracts (id, name, description, functions, registered_by, source_files, has_circuit_breaker, is_rwa, rwa_type, version, abi_version, min_ledger)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, functions=$4, source_files=$6, has_circuit_breaker=$7, is_rwa=$8, rwa_type=$9, version=$10, abi_version=$11, min_ledger=$12`,
      [
        meta.id,
        meta.name,
        meta.description,
        JSON.stringify(meta.functions),
        meta.registered_by,
        meta.source_files ? JSON.stringify(meta.source_files) : null,
        meta.has_circuit_breaker ?? false,
        meta.is_rwa ?? false,
        meta.rwa_type ?? null,
        meta.version ?? 1,
        meta.abi_version ?? 0,
        meta.min_ledger ?? 0,
      ],
    );

    // Also store in version history if abi_version is provided
    if (meta.abi_version != null) {
      await pool.query(
        `INSERT INTO contract_versions (contract_id, abi_version, min_ledger, name, description, functions, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          meta.id,
          meta.abi_version,
          meta.min_ledger ?? 0,
          meta.name,
          meta.description,
          JSON.stringify(meta.functions),
          meta.registered_by,
        ],
      );
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
  async updateCircuitBreakerStatus(contractId, isPaused, ledger) {
    await pool.query(`UPDATE contracts SET is_paused = $1, pause_status_ledger = $2 WHERE id = $3`, [
      isPaused,
      ledger,
      contractId,
    ]);
  },

  async getCircuitBreakerStatus(contractId) {
    const { rows } = await pool.query(
      `SELECT has_circuit_breaker, is_paused, pause_status_ledger FROM contracts WHERE id = $1`,
      [contractId],
    );
    return (
      rows[0] ?? {
        has_circuit_breaker: false,
        is_paused: false,
        pause_status_ledger: null,
      }
    );
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

  // ── WASM build metadata ────────────────────────────────────────────────────

  async upsertWasmBuildMetadata({
    wasm_hash,
    contract_id,
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
         (wasm_hash, contract_id, sdk_version, compiler, optimizer, repository, commit, producers, ledger, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (wasm_hash) DO UPDATE SET
         contract_id = COALESCE(EXCLUDED.contract_id, wasm_build_metadata.contract_id),
         sdk_version = COALESCE(EXCLUDED.sdk_version, wasm_build_metadata.sdk_version),
         compiler    = COALESCE(EXCLUDED.compiler,    wasm_build_metadata.compiler),
         optimizer   = COALESCE(EXCLUDED.optimizer,   wasm_build_metadata.optimizer),
         repository  = COALESCE(EXCLUDED.repository,  wasm_build_metadata.repository),
         commit      = COALESCE(EXCLUDED.commit,      wasm_build_metadata.commit),
         producers   = COALESCE(EXCLUDED.producers,   wasm_build_metadata.producers)`,
      [
        wasm_hash,
        contract_id ?? null,
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

  // data export — events (CSV/JSON)
  async getEventsForExport({ contract, fn, type, limit = 10000 } = {}) {
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
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(limit, 10000));
    const { rows } = await pool.query(
      `SELECT seq, contract_id, function, ledger, tx_hash, description,
              cpu_instructions, mem_bytes, fee_charged, is_clawback, is_high_bloat_risk
       FROM events ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  // data export — registered contracts (CSV/JSON)
  async getContractsForExport() {
    const { rows } = await pool.query(
      `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused, is_rwa, rwa_type, created_at
       FROM contracts ORDER BY created_at DESC`,
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
