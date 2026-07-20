import { jest } from "@jest/globals";

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const decodeEvent = jest.fn(async (rawEvent) => {
  if (rawEvent.forceFailure) throw new Error("synthetic decode failure");

  return {
    contract_id: rawEvent.contractId,
    function: rawEvent.functionName,
    ledger: rawEvent.ledger,
    tx_hash: rawEvent.txHash ?? rawEvent.id,
    description: `Synthetic ${rawEvent.functionName} event`,
    raw_topics: [],
    raw_data: JSON.stringify(rawEvent.payload ?? null),
  };
});

// The raw RPC event is JSONB-backed in the DLQ. Mocking only the XDR decoder
// keeps this integration test deterministic while exercising the real handler,
// validation, database upsert, and retry bookkeeping against PostgreSQL.
jest.unstable_mockModule("../../src/decoder.js", () => ({ decode: decodeEvent }));

// Several transitive production modules schedule maintenance intervals at
// import time. Capture those timers without faking Date (the DLQ backoff clock),
// discard them, then restore real timers before any PostgreSQL work begins.
jest.useFakeTimers({ doNotFake: ["Date", "nextTick", "queueMicrotask"] });
let importedModules;
try {
  importedModules = await Promise.all([
    import("../../src/db.js"),
    import("../../src/deadLetterQueue.js"),
    import("../../src/index.js"),
  ]);
} finally {
  jest.clearAllTimers();
  jest.useRealTimers();
}

const [
  { db },
  { computeNextRetryDelay, enqueue, initDeadLetterQueue, processRetries },
  { loadTransactionContext, processSingleEvent },
] = importedModules;

describe("transaction context loading", () => {
  it("loads fee-bump and restore metadata and publishes transaction status", async () => {
    const envelopeXdr = { synthetic: "envelope" };
    const feeBump = { isFeeBump: true, innerTxHash: "inner-hash" };
    const restore = { isRestoreOp: true, restoredKeys: ["key-1"] };
    const txResult = {
      envelopeXdr,
      resultMetaXdr: "result-meta",
      status: "SUCCESS",
      ledger: 900000,
    };
    const fetchTransaction = jest.fn(async () => txResult);
    const parseFeeBumpEnvelope = jest.fn(() => feeBump);
    const parseRestoreEnvelope = jest.fn(() => restore);
    const publishStatus = jest.fn();
    const extractFailure = jest.fn(async () => null);

    const context = await loadTransactionContext("tx-context", {
      fetchTransaction,
      parseFeeBumpEnvelope,
      parseRestoreEnvelope,
      publishStatus,
      extractFailure,
    });

    expect(context).toEqual({ feeBump, archivalInfo: restore });
    expect(fetchTransaction).toHaveBeenCalledWith("tx-context");
    expect(parseFeeBumpEnvelope).toHaveBeenCalledWith(envelopeXdr);
    expect(parseRestoreEnvelope).toHaveBeenCalledWith(envelopeXdr, "result-meta");
    expect(publishStatus).toHaveBeenCalledWith({
      tx_hash: "tx-context",
      status: "success",
      ledger: 900000,
      error: null,
    });
  });

  it("keeps transaction lookup failures non-critical", async () => {
    const publishStatus = jest.fn();
    const context = await loadTransactionContext("tx-unavailable", {
      fetchTransaction: jest.fn(async () => {
        throw new Error("RPC unavailable");
      }),
      publishStatus,
    });

    expect(context).toEqual({ feeBump: null, archivalInfo: null });
    expect(publishStatus).not.toHaveBeenCalled();
  });
});

describe("DLQ retries through the real indexing handler", () => {
  beforeAll(async () => {
    await db.init();
    await initDeadLetterQueue();
  });

  beforeEach(async () => {
    decodeEvent.mockClear();
    await db.query("TRUNCATE events, dead_letter_queue RESTART IDENTITY CASCADE");
  });

  it("re-indexes a due event and marks its DLQ row resolved", async () => {
    const rawEvent = {
      id: "synthetic-success",
      contractId: "CSYNTHETICSUCCESS",
      ledger: 900001,
      functionName: "transfer",
      payload: { amount: "42" },
    };
    const entryId = await enqueue(rawEvent, new Error("network timeout"));
    await db.query("UPDATE dead_letter_queue SET next_retry_at = NOW() WHERE id = $1", [entryId]);

    const summary = await processRetries(processSingleEvent);

    expect(summary).toEqual({ retried: 1, resolved: 1, failed: 0 });
    expect(decodeEvent).toHaveBeenCalledWith(expect.objectContaining({ id: rawEvent.id }));

    const { rows: events } = await db.query(
      "SELECT contract_id, function, ledger, tx_hash FROM events WHERE tx_hash = $1",
      [rawEvent.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      contract_id: rawEvent.contractId,
      function: rawEvent.functionName,
      tx_hash: rawEvent.id,
    });
    expect(Number(events[0].ledger)).toBe(rawEvent.ledger);

    const { rows: dlqRows } = await db.query(
      "SELECT resolved, retry_count FROM dead_letter_queue WHERE id = $1",
      [entryId],
    );
    expect(dlqRows[0].resolved).toBe(true);
    expect(dlqRows[0].retry_count).toBe(0);
  });

  it("increments retry_count and schedules backoff when the handler throws", async () => {
    const rawEvent = {
      id: "synthetic-failure",
      contractId: "CSYNTHETICFAILURE",
      ledger: 900002,
      functionName: "transfer",
      forceFailure: true,
    };
    const entryId = await enqueue(rawEvent, new Error("network timeout"));
    await db.query("UPDATE dead_letter_queue SET next_retry_at = NOW() WHERE id = $1", [entryId]);

    const retryStartedAt = Date.now();
    const summary = await processRetries(processSingleEvent);

    expect(summary).toEqual({ retried: 1, resolved: 0, failed: 1 });
    const { rows } = await db.query(
      `SELECT resolved, retry_count, next_retry_at, error_message
       FROM dead_letter_queue
       WHERE id = $1`,
      [entryId],
    );
    expect(rows[0].resolved).toBe(false);
    expect(rows[0].retry_count).toBe(1);
    expect(rows[0].next_retry_at).not.toBeNull();
    expect(new Date(rows[0].next_retry_at).getTime()).toBeGreaterThanOrEqual(
      retryStartedAt + computeNextRetryDelay(1),
    );
    expect(rows[0].error_message).toBe("synthetic decode failure");

    const { rows: events } = await db.query("SELECT seq FROM events WHERE tx_hash = $1", [rawEvent.id]);
    expect(events).toHaveLength(0);
  });
});
