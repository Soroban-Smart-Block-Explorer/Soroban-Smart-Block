import pg from "pg";
import { runMigrations } from "./migrate.js";
import { validateAndSanitizeDecodedEvent } from "./decoderValidator.js";

// BIGINT/BIGSERIAL (OID 20) columns — seq, ledger — are returned as JS
// strings by default to avoid silent precision loss above 2^53. Ledger and
// event sequence numbers stay well within that range, and the OpenAPI schema
// documents these fields as `integer`, so parse them as numbers.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Exported for pool metric collection — do not use for queries outside db.js. */
export { pool };

export const db = {
  /** Run all pending SQL migrations from indexer/migrations/. */
  async init() {
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO daemon_state (key, value)
       VALUES ('cursor', '0'), ('last_indexed_ledger', '0')
       ON CONFLICT (key) DO NOTHING`,
    );
  },

  async getMaxLedger() {
    const { rows } = await pool.query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events");
    return Number(rows[0].max_ledger);
  },

  // ── daemon cursor persistence ──────────────────────────────────
  async saveDaemonState(key, value) {
    await pool.query(
      `INSERT INTO daemon_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value)],
    );
  },

  async saveCursor(ledger) {
    await this.saveDaemonState('cursor', ledger);
  },

  async loadCursor() {
    const { rows } = await pool.query("SELECT value FROM daemon_state WHERE key = 'cursor'");
    return rows[0] ? Number(rows[0].value) : null;
  },

  async saveLastIndexedLedger(ledger) {
    await this.saveDaemonState('last_indexed_ledger', ledger);
  },

  async getLastIndexedLedger() {
    const { rows } = await pool.query("SELECT value FROM daemon_state WHERE key = 'last_indexed_ledger'");
    return rows[0] ? Number(rows[0].value) : 0;
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
      // Comma-separated list of exact function names (e.g. "swap,swap_exact_tokens_for_tokens"
      // for the DEX function-filter chips, issue #555). A single value keeps the
      // plain equality comparison for backward compatibility.
      const fns = String(fn).split(",").map((s) => s.trim()).filter(Boolean);
      if (fns.length === 1) {
        params.push(fns[0]);
        conditions.push(`function = $${params.length}`);
      } else if (fns.length > 1) {
        params.push(fns);
        conditions.push(`function = ANY($${params.length})`);
      }
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
      `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
       FROM events ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    // seq is BIGINT so pg returns it as a string — coerce for a numeric cursor
    const next_cursor = hasMore ? Number(data[data.length - 1].seq) : null;

    return { data, next_cursor };
  },

  async upsertEvent(ev) {
    await pool.query(
      `INSERT INTO events
         (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data,
          cpu_instructions, mem_bytes, fee_charged, is_high_bloat_risk, upgrade_info, storage_tiers, is_clawback,
          footprint_contention, ttl_extension, fee_bump, archival_info, zk_host_calls, abi_version, slippage_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
        ev.abi_version ?? 0,
        ev.slippage_bps ?? null,
      ],
    );
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
           needs_redecode = FALSE
       WHERE seq = $1 AND needs_redecode = TRUE`,
      [
        seq,
        decoded.function,
        decoded.description,
        JSON.stringify(decoded.raw_topics),
        decoded.raw_data,
        abiVersion,
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

  /**
   * @deprecated OFFSET pagination degrades to a full-table scan at depth on
   * large tables — use getEventsCursor() instead (#490). Kept only for the
   * page-based GET /api/contracts/:id/events endpoint.
   */
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
    const sql = `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
                 FROM events WHERE seq = $1`;
    const { rows } = await pool.query(sql, [seq]);
    return rows[0] ?? null;
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

  async listContracts({ page = 1, limit = 25, type } = {}) {
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (type) {
      params.push(type);
      conditions.push(`protocol_type = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused,
                is_rwa, rwa_type, protocol_type, is_verified, verified_ledger, created_at
         FROM contracts ${where} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      pool.query(`SELECT COUNT(*)::INT AS total FROM contracts ${where}`, type ? [type] : []),
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

  /**
   * Aggregate stats for a contract's event history (#536): total events,
   * unique caller addresses, first/last seen ledger, and a 30-day daily
   * event-count trend (zero-filled so the frontend sparkline never sees gaps).
   * @param {string} contractId
   */
  async getContractStats(contractId) {
    const [{ rows: totals }, { rows: callerRows }, { rows: dailyRows }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::INT AS total_events, MIN(ledger) AS first_seen_ledger, MAX(ledger) AS last_seen_ledger
         FROM events WHERE contract_id = $1`,
        [contractId],
      ),
      // Unique caller addresses referenced anywhere in the event payload —
      // same address-extraction approach as searchWallets().
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
      pool.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS date, COUNT(*)::INT AS count
         FROM events
         WHERE contract_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY date`,
        [contractId],
      ),
    ]);

    const countsByDate = new Map(dailyRows.map((r) => [r.date, r.count]));
    const events_per_day = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      events_per_day.push({ date, count: countsByDate.get(date) ?? 0 });
    }

    return {
      total_events: totals[0].total_events,
      unique_callers: callerRows[0].unique_callers,
      first_seen_ledger: totals[0].first_seen_ledger != null ? Number(totals[0].first_seen_ledger) : null,
      last_seen_ledger: totals[0].last_seen_ledger != null ? Number(totals[0].last_seen_ledger) : null,
      events_per_day,
    };
  },

  async upsertContractMeta(meta) {
    // Auto-tag protocol_type from function names if not explicitly provided
    const functionNames = (meta.functions ?? []).map((f) => (typeof f === 'string' ? f : f?.name ?? ''));
    const protocol_type = meta.protocol_type ?? this.inferProtocolType(functionNames);

    await pool.query(
      `INSERT INTO contracts (id, name, description, functions, registered_by, source_files, has_circuit_breaker, is_rwa, rwa_type, version, abi_version, min_ledger, protocol_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, functions=$4, source_files=$6, has_circuit_breaker=$7, is_rwa=$8, rwa_type=$9, version=$10, abi_version=$11, min_ledger=$12, protocol_type=$13`,
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
        protocol_type,
      ],
    );

    // Also store in contract_abi_versions history if abi_version is provided
    if (meta.abi_version != null) {
      await pool.query(
        `INSERT INTO contract_abi_versions (contract_id, abi_version, min_ledger, functions, registered_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (contract_id, abi_version) DO NOTHING`,
        [
          meta.id,
          meta.abi_version,
          meta.min_ledger ?? 0,
          JSON.stringify(meta.functions ?? []),
          meta.registered_by ?? '',
        ],
      );
    }

    // Also store in contract_versions (legacy) if abi_version is provided
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
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total_events,
              COUNT(DISTINCT caller_address) AS unique_callers,
              MIN(ledger) AS first_seen_ledger,
              MAX(ledger) AS last_seen_ledger
       FROM events WHERE contract_id = $1`,
      [contractId],
    );
    const row = rows[0];
    return {
      total_events: Number(row.total_events),
      unique_callers: Number(row.unique_callers),
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
   * Return all minted NFT tokens for a collection contract, with pagination
   * and optional owner-address filter.
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

  // ── Predictive Gap Detection helpers ────────────────────────────────────────

  /**
   * Return the most recently indexed ledger numbers, newest first.
   * Used by the predictive gap detector to find missing ranges.
   *
   * @param {number} n  Maximum number of ledgers to return
   * @returns {Promise<number[]>}  Descending array of ledger numbers
   */
  async getRecentLedgers(n = 100) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ledger FROM events ORDER BY ledger DESC LIMIT $1`,
      [n],
    );
    return rows.map((r) => Number(r.ledger));
  },

  /**
   * Insert a gap record into the gap_log table.
   *
   * @param {{ from: number, to: number, size: number, status?: string }} gap
   * @returns {Promise<number>}  The new gap_log id
   */
  async insertGapLog(gap) {
    const { rows } = await pool.query(
      `INSERT INTO gap_log (from_ledger, to_ledger, size, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [gap.from, gap.to, gap.size, gap.status ?? "open"],
    );
    return rows[0].id;
  },

  /**
   * Update the status of a gap_log entry.
   *
   * @param {number} id
   * @param {string} status  "closed" | "failed" | "pending"
   */
  async updateGapLogStatus(id, status) {
    await pool.query(
      `UPDATE gap_log SET status = $1, closed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [status, id],
    );
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
  async getEventsForExport({ contract, fn, type, wallet, limit = 10000 } = {}) {
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
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(limit, 10000));
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

  // ── Gap detection helpers ──────────────────────────────────────────────

  /**
   * Return the N most recent distinct ledger numbers from the events table,
   * ordered ascending. Used by the predictive gap detector to scan for gaps.
   *
   * @param {number} n  Number of recent ledgers to fetch (default 100)
   * @returns {Promise<number[]>}  Sorted ascending array of ledger numbers
   */
  async getRecentLedgers(n = 100) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ledger FROM events ORDER BY ledger DESC LIMIT $1`,
      [n],
    );
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
    await pool.query(
      `UPDATE gap_log SET status = 'closed', closed_at = NOW() WHERE id = $1`,
      [id],
    );
  },

  /**
   * Mark a gap_log entry as sent to the dead-letter queue after exhausting retries.
   */
  async dlqGapLog(id) {
    await pool.query(
      `UPDATE gap_log SET status = 'dlq', closed_at = NOW() WHERE id = $1`,
      [id],
    );
  },

  /**
   * Increment the retry counter on a gap_log entry.
   */
  async incrementGapRetries(id) {
    await pool.query(
      `UPDATE gap_log SET retries = retries + 1 WHERE id = $1`,
      [id],
    );
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
        entry.registered_by ?? '',
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
    if (names.some((n) => n === 'swap' || n === 'swap_exact')) return 'dex';
    if (names.some((n) => n === 'supply' || n === 'borrow')) return 'lending';
    if (names.includes('mint') && names.includes('transfer')) return 'token';
    return 'other';
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
