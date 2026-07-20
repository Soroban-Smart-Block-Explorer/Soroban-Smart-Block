import { db } from "./db.js";
import { decode } from "./decoder.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 5_000;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseBatchSize(value) {
  const batchSize = Number(value ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("REDECODE_BATCH_SIZE must be an integer between 1 and 1000");
  }
  return batchSize;
}

function rawEventFromRow(row) {
  const topics = parseJson(row.raw_topics, []);
  const value = parseJson(row.raw_data, null);
  if (!Array.isArray(topics)) throw new Error(`event ${row.seq} has invalid raw topics`);
  return {
    contractId: row.contract_id,
    topic: topics,
    value,
    ledger: Number(row.ledger),
    txHash: row.tx_hash,
  };
}

export async function runReDecodeBatch({ dbModule = db, decodeFn = decode, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const rows = await dbModule.getEventsNeedingRedecode(parseBatchSize(batchSize));
  let processed = 0;

  for (const row of rows) {
    try {
      const meta = await dbModule.getContractMeta(row.contract_id);
      if (!meta || Number(meta.abi_version) <= Number(row.abi_version ?? 0)) continue;

      const decoded = await decodeFn(rawEventFromRow(row), { currentAbi: true });
      decoded.abi_version = Number(meta.abi_version);
      await dbModule.updateRedecodedEvent(row.seq, decoded, Number(meta.abi_version));
      processed++;
    } catch (error) {
      console.error(`[redecode] event ${row.seq} failed: ${error.message}`);
    }
  }
  return processed;
}

export function startReDecodeWorker({
  dbModule = db,
  decodeFn = decode,
  batchSize = process.env.REDECODE_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
  intervalMs = Number(process.env.REDECODE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new Error("REDECODE_INTERVAL_MS must be an integer of at least 100ms");
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runReDecodeBatch({ dbModule, decodeFn, batchSize });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => tick().catch((error) => console.error("[redecode] worker failed:", error.message)), intervalMs);
  timer.unref?.();
  tick().catch((error) => console.error("[redecode] initial run failed:", error.message));
  return () => clearInterval(timer);
}
