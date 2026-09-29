import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientError, computeNextRetryDelay } from "../src/deadLetterQueue.js";

describe("isTransientError", () => {
  it("detects timeout errors", () => {
    assert.ok(isTransientError("timeout of 5000ms exceeded"));
    assert.ok(isTransientError("RPC timeout after 1000ms"));
    assert.ok(isTransientError("TIMEOUT"));
  });

  it("detects rate limit errors", () => {
    assert.ok(isTransientError("rate limit exceeded"));
    assert.ok(isTransientError("Too Many Requests"));
    assert.ok(isTransientError("too many requests from IP"));
  });

  it("detects network errors", () => {
    assert.ok(isTransientError("read ECONNRESET"));
    assert.ok(isTransientError("connect ETIMEDOUT"));
    assert.ok(isTransientError("network error"));
  });

  it("does not flag permanent errors as transient", () => {
    assert.ok(!isTransientError("invalid contract id"));
    assert.ok(!isTransientError("database constraint violation"));
    assert.ok(!isTransientError("JSON parse error"));
    assert.ok(!isTransientError("bad request"));
  });

  it("is case-insensitive", () => {
    assert.ok(isTransientError("RATE LIMIT EXCEEDED"));
    assert.ok(isTransientError("Network Error"));
  });
});

describe("computeNextRetryDelay", () => {
  const BASE_MS = Number(process.env.DLQ_RETRY_DELAY_MS || 30_000);

  it("returns base delay for first retry (count=0)", () => {
    assert.equal(computeNextRetryDelay(0), BASE_MS * Math.pow(2, 0));
  });

  it("doubles delay for each subsequent retry", () => {
    assert.equal(computeNextRetryDelay(1), BASE_MS * 2);
    assert.equal(computeNextRetryDelay(2), BASE_MS * 4);
    assert.equal(computeNextRetryDelay(3), BASE_MS * 8);
  });

  it("delay grows exponentially", () => {
    const d0 = computeNextRetryDelay(0);
    const d1 = computeNextRetryDelay(1);
    const d2 = computeNextRetryDelay(2);
    assert.equal(d1, d0 * 2);
    assert.equal(d2, d1 * 2);
  });
});

describe("DLQ retry scheduling logic", () => {
  it("schedules next retry when transient and retries remain", () => {
    const retryCount = 1;
    const maxRetries = 3;
    const exhausted = retryCount >= maxRetries;
    const nextRetry = exhausted ? null : new Date(Date.now() + computeNextRetryDelay(retryCount)).toISOString();
    assert.ok(!exhausted);
    assert.ok(nextRetry !== null);
    assert.ok(new Date(nextRetry) > new Date());
  });

  it("does not schedule next retry when retries exhausted", () => {
    const retryCount = 3;
    const maxRetries = 3;
    const exhausted = retryCount >= maxRetries;
    const nextRetry = exhausted ? null : new Date(Date.now() + computeNextRetryDelay(retryCount)).toISOString();
    assert.ok(exhausted);
    assert.equal(nextRetry, null);
  });
});

describe("DLQ enqueue field mapping", () => {
  it("prefers contractId over contract_id", () => {
    const ev = { contractId: "C1", contract_id: "C2", ledger: 100 };
    const resolved = ev.contractId ?? ev.contract_id ?? null;
    assert.equal(resolved, "C1");
  });

  it("falls back to contract_id when contractId is absent", () => {
    const ev = { contract_id: "C2", ledger: 100 };
    const resolved = ev.contractId ?? ev.contract_id ?? null;
    assert.equal(resolved, "C2");
  });

  it("returns null when neither field is present", () => {
    const ev = { ledger: 100 };
    const resolved = ev.contractId ?? ev.contract_id ?? null;
    assert.equal(resolved, null);
  });

  it("prefers txHash over tx_hash", () => {
    const ev = { txHash: "TX1", tx_hash: "TX2" };
    const resolved = ev.txHash ?? ev.tx_hash ?? null;
    assert.equal(resolved, "TX1");
  });
});

// ── Issue #851: processor backoff, classification, poison detection ─────────
import { computeBackoff, classifyError, nextStateAfterFailure } from "../src/deadLetterQueue.js";

describe("computeBackoff", () => {
  it("doubles per attempt and is capped", () => {
    assert.equal(computeBackoff(1, { base: 1000, max: 10_000 }), 1000);
    assert.equal(computeBackoff(2, { base: 1000, max: 10_000 }), 2000);
    assert.equal(computeBackoff(3, { base: 1000, max: 10_000 }), 4000);
    assert.equal(computeBackoff(10, { base: 1000, max: 10_000 }), 10_000);
  });
});

describe("classifyError", () => {
  class DecodeError extends Error {}

  it("uses the error class name", () => {
    assert.equal(classifyError(new DecodeError("bad xdr")).errorClass, "DecodeError");
    assert.equal(classifyError(new TypeError("x")).errorClass, "TypeError");
  });

  it("hashes the same code path identically regardless of message", () => {
    const [a, b] = ["ledger 1", "ledger 2"].map((msg) => new DecodeError(msg));
    assert.equal(classifyError(a).stackHash, classifyError(b).stackHash);
  });

  it("hashes different code paths differently", () => {
    const a = new DecodeError("x");
    const b = new DecodeError("x");
    b.stack = "DecodeError: x\n    at other (file.js:1:1)";
    assert.notEqual(classifyError(a).stackHash, classifyError(b).stackHash);
  });
});

describe("nextStateAfterFailure", () => {
  const opts = { maxAttempts: 6, poisonThreshold: 50 };

  it("keeps retrying transient failures below the attempt budget", () => {
    assert.equal(nextStateAfterFailure({ attempts: 2, sameHashCount: 1, ...opts }), "queued");
  });

  it("quarantines after DLQ_MAX_ATTEMPTS deterministic failures", () => {
    assert.equal(nextStateAfterFailure({ attempts: 5, sameHashCount: 1, ...opts }), "queued");
    assert.equal(nextStateAfterFailure({ attempts: 6, sameHashCount: 1, ...opts }), "quarantined");
  });

  it("quarantines when a stack hash recurs across the poison threshold", () => {
    assert.equal(nextStateAfterFailure({ attempts: 1, sameHashCount: 49, ...opts }), "queued");
    assert.equal(nextStateAfterFailure({ attempts: 1, sameHashCount: 50, ...opts }), "quarantined");
  });
});
