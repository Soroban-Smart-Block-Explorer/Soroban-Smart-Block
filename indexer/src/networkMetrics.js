// Per-ledger network metrics (#921): Soroban tx count, TPS, close time,
// inclusion-fee percentiles, resource utilization vs. per-ledger limits and a
// surge flag. Limits come from each ledger's config settings, never constants.

export const RANGES = { "1h": 3600, "24h": 86400, "7d": 604800 };

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function ratio(used, limit) {
  return limit > 0 ? Math.min(1, used / limit) : null;
}

// ledger: { sequence, closed_at, prev_closed_at, txs: [{ inclusion_fee, instructions,
// read_bytes, write_bytes }], limits: { tx_count, instructions, read_bytes, write_bytes } }
export function computeLedgerMetrics(ledger) {
  const txs = ledger.txs || [];
  const limits = ledger.limits || {};
  const fees = txs.map((t) => Number(t.inclusion_fee) || 0).sort((a, b) => a - b);
  const sum = (k) => txs.reduce((acc, t) => acc + (Number(t[k]) || 0), 0);
  const closeTime = ledger.prev_closed_at
    ? (new Date(ledger.closed_at) - new Date(ledger.prev_closed_at)) / 1000
    : null;
  const utilization = {
    tx_count: ratio(txs.length, limits.tx_count),
    instructions: ratio(sum("instructions"), limits.instructions),
    read_bytes: ratio(sum("read_bytes"), limits.read_bytes),
    write_bytes: ratio(sum("write_bytes"), limits.write_bytes),
  };
  const maxUtil = Math.max(0, ...Object.values(utilization).filter((v) => v !== null));
  return {
    ledger: ledger.sequence,
    closed_at: ledger.closed_at,
    tx_count: txs.length,
    close_time: closeTime,
    tps: closeTime > 0 ? txs.length / closeTime : null,
    fees: { p10: percentile(fees, 10), p50: percentile(fees, 50), p90: percentile(fees, 90), p99: percentile(fees, 99) },
    utilization,
    surge: maxUtil >= 0.9,
  };
}

// Recommended inclusion fee: p90 of recent ledgers' p50 values (p90 during surge).
export function recommendFee(metrics) {
  if (!metrics.length) return null;
  const surge = metrics.some((m) => m.surge);
  const key = surge ? "p90" : "p50";
  const vals = metrics.map((m) => m.fees[key]).filter((v) => v !== null).sort((a, b) => a - b);
  return { fee: percentile(vals, 90), surge };
}

// Staleness: seconds between now and the newest indexed ledger close.
export function staleness(metrics, now = Date.now()) {
  if (!metrics.length) return null;
  return Math.max(0, (now - new Date(metrics[metrics.length - 1].closed_at)) / 1000);
}

export async function getNetworkMetrics(pool, range = "1h") {
  const secs = RANGES[range] ?? RANGES["1h"];
  const { rows } = await pool.query(
    `SELECT t.ledger AS sequence, MAX(t.created_at) AS closed_at,
            json_agg(json_build_object('inclusion_fee', t.inclusion_fee,
              'read_bytes', t.footprint_read_bytes, 'write_bytes', t.footprint_write_bytes)) AS txs,
            (SELECT c.limits FROM ledger_config_settings c WHERE c.ledger <= t.ledger
              ORDER BY c.ledger DESC LIMIT 1) AS limits
       FROM transactions t
      WHERE t.created_at >= NOW() - ($1 || ' seconds')::interval
      GROUP BY t.ledger ORDER BY t.ledger ASC`,
    [String(secs)],
  );
  const metrics = rows.map((r, i) => computeLedgerMetrics({ ...r, prev_closed_at: rows[i - 1]?.closed_at }));
  return { range, metrics, recommended: recommendFee(metrics.slice(-50)), staleness_seconds: staleness(metrics) };
}

// ── Ledger browsing (#912) ────────────────────────────────────────────────────

// Indexing status for a ledger sequence: "future" (beyond the indexed tip →
// 404), "not_indexed" (older than retention), "gap" (inside an open gap
// record) or "indexed".
export function ledgerStatus(seq, { minLedger, maxLedger, gap }) {
  if (maxLedger === null || seq > maxLedger) return "future";
  if (seq < minLedger) return "not_indexed";
  if (gap) return "gap";
  return "indexed";
}

export async function getLedgerDetail(pool, seq) {
  const [{ rows: bounds }, { rows: gaps }] = await Promise.all([
    pool.query(`SELECT MIN(ledger)::BIGINT AS min, MAX(ledger)::BIGINT AS max FROM ledger_hashes`),
    pool.query(
      `SELECT id, from_ledger, to_ledger, status FROM gap_log
        WHERE $1 BETWEEN from_ledger AND to_ledger AND status <> 'closed'
        ORDER BY created_at DESC LIMIT 1`,
      [seq],
    ),
  ]);
  const minLedger = bounds[0].min === null ? null : Number(bounds[0].min);
  const maxLedger = bounds[0].max === null ? null : Number(bounds[0].max);
  const gap = gaps[0] ?? null;
  const status = ledgerStatus(seq, { minLedger, maxLedger, gap });
  const nav = {
    prev: minLedger !== null && seq > minLedger ? seq - 1 : null,
    next: maxLedger !== null && seq < maxLedger ? seq + 1 : null,
  };
  if (status === "future" || status === "not_indexed") return { ledger: seq, status, gap: null, ...nav };

  const [{ rows: hashRows }, { rows: txRows }, { rows: eventRows }, { rows: limitRows }] = await Promise.all([
    pool.query(`SELECT hash, indexed_at FROM ledger_hashes WHERE ledger = $1`, [seq]),
    pool.query(
      `SELECT hash, source, status, operation_count, footprint_read_bytes, footprint_write_bytes,
              inclusion_fee, resource_fee, charged_fee, created_at
         FROM transactions WHERE ledger = $1 ORDER BY hash`,
      [seq],
    ),
    pool.query(
      `SELECT tx_hash, contract_id, function, description, protocol_version, cpu_instructions
         FROM events WHERE ledger = $1 ORDER BY seq`,
      [seq],
    ),
    pool.query(`SELECT limits FROM ledger_config_settings WHERE ledger <= $1 ORDER BY ledger DESC LIMIT 1`, [seq]),
  ]);

  // Group event narratives under their transaction; include txs that only
  // appear via events (transactions rows are best-effort).
  const txs = new Map(txRows.map((t) => [t.hash, { ...t, instructions: 0, narratives: [] }]));
  for (const ev of eventRows) {
    if (!ev.tx_hash) continue;
    if (!txs.has(ev.tx_hash)) txs.set(ev.tx_hash, { hash: ev.tx_hash, instructions: 0, narratives: [] });
    const tx = txs.get(ev.tx_hash);
    tx.instructions += Number(ev.cpu_instructions) || 0;
    tx.narratives.push({ contract_id: ev.contract_id, function: ev.function, description: ev.description });
  }
  const transactions = [...txs.values()];
  const metrics = computeLedgerMetrics({
    sequence: seq,
    closed_at: txRows.reduce((m, t) => (!m || t.created_at > m ? t.created_at : m), null),
    limits: limitRows[0]?.limits ?? null,
    txs: transactions.map((t) => ({
      inclusion_fee: t.inclusion_fee,
      instructions: t.instructions,
      read_bytes: t.footprint_read_bytes,
      write_bytes: t.footprint_write_bytes,
    })),
  });

  return {
    ledger: seq,
    status,
    hash: hashRows[0]?.hash ?? null,
    indexed_at: hashRows[0]?.indexed_at ?? null,
    closed_at: metrics.closed_at,
    protocol_version: eventRows.find((e) => e.protocol_version !== null)?.protocol_version ?? null,
    soroban_tx_count: transactions.length,
    event_count: eventRows.length,
    fees: metrics.fees,
    utilization: metrics.utilization,
    limits: limitRows[0]?.limits ?? null,
    transactions,
    gap,
    ...nav,
  };
}

export async function listLedgers(pool, { cursor = null, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT h.ledger, h.hash, h.indexed_at,
            (SELECT COUNT(DISTINCT e.tx_hash) FROM events e WHERE e.ledger = h.ledger)::INT AS soroban_tx_count,
            (SELECT COUNT(*) FROM events e WHERE e.ledger = h.ledger)::INT AS event_count
       FROM ledger_hashes h
      WHERE ($1::BIGINT IS NULL OR h.ledger < $1::BIGINT)
      ORDER BY h.ledger DESC LIMIT $2`,
    [cursor, limit + 1],
  );
  const data = rows.slice(0, limit).map((r) => ({ ...r, ledger: Number(r.ledger) }));
  return { data, next_cursor: rows.length > limit ? String(data[data.length - 1].ledger) : null };
}
