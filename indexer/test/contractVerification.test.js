import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import {
  BADGE,
  computeBadge,
  sanitizeBuildLog,
  validateVerificationRequest,
  processNextVerification,
} from "../src/contractVerifier.js";

// Issue #796 — reproducible-build source verification.
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const completed = { status: "completed", built_hash: H1, onchain_hash: H1, reproducible: true };

describe("computeBadge", () => {
  it("shows Verified (reproducible) when the reproducible build hash equals the on-chain hash", () => {
    assert.equal(computeBadge(completed, H1).state, BADGE.VERIFIED_REPRODUCIBLE);
  });

  it("shows hash-match when the build was not reproducible", () => {
    assert.equal(computeBadge({ ...completed, reproducible: false }, H1).state, BADGE.VERIFIED_HASH_MATCH);
  });

  it("shows Mismatch with both hashes when one byte of the on-chain code differs", () => {
    const flipped = "a".repeat(63) + "b";
    const badge = computeBadge(completed, flipped);
    assert.equal(badge.state, BADGE.MISMATCH);
    assert.equal(badge.expected, H1);
    assert.equal(badge.actual, flipped);
  });

  it("flips a verified contract to Mismatch after an on-chain upgrade", () => {
    const badge = computeBadge(completed, H2);
    assert.equal(badge.state, BADGE.MISMATCH);
    assert.equal(badge.upgraded, true);
  });

  it("owner-supplied metadata alone can never produce a Verified badge", () => {
    // A request row that never went through the verifier has no built hash.
    const spoof = { status: "pending", source_repo: "https://github.com/x/y", built_hash: null };
    assert.equal(computeBadge(spoof, H1).state, BADGE.PENDING);
    // Even a completed row with a non-hash "matching-looking" string is rejected.
    assert.equal(computeBadge({ ...completed, built_hash: "verified", onchain_hash: "verified" }, null).state, BADGE.UNVERIFIED);
    // And no request fields are accepted besides source coordinates.
    assert.equal(computeBadge(null, H1).state, BADGE.UNVERIFIED);
  });

  it("surfaces failure reasons", () => {
    const badge = computeBadge({ status: "failed", reason: "source no longer retrievable" }, H1);
    assert.equal(badge.state, BADGE.FAILED);
    assert.equal(badge.reason, "source no longer retrievable");
  });
});

describe("sanitizeBuildLog", () => {
  it("scrubs secrets and machine paths", () => {
    const log = [
      "cloning https://user:hunter2@github.com/org/repo",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "error at /home/alice/src/lib.rs:3",
      "key AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const out = sanitizeBuildLog(log);
    for (const leaked of ["hunter2", "ghp_abcdefghijklmnopqrstuvwxyz0123", "alice", "AKIAABCDEFGHIJKLMNOP"]) {
      assert.ok(!out.includes(leaked), `leaked ${leaked}`);
    }
    assert.ok(out.includes("/home/[user]/src/lib.rs"));
  });
});

describe("validateVerificationRequest", () => {
  const ok = { source_repo: "https://github.com/org/repo", commit: "c".repeat(40) };
  it("accepts source coordinates", () => assert.equal(validateVerificationRequest(ok), null));
  it("rejects non-https / non-forge URLs", () =>
    assert.ok(validateVerificationRequest({ ...ok, source_repo: "file:///etc" })));
  it("rejects short commits", () => assert.ok(validateVerificationRequest({ ...ok, commit: "abc" })));
  it("rejects unknown toolchain keys", () =>
    assert.ok(validateVerificationRequest({ ...ok, toolchain: { built_hash: H1 } })));
});

describe("processNextVerification", () => {
  const originalQuery = db.query;
  afterEach(() => {
    db.query = originalQuery;
  });

  function stubDb(job) {
    const updates = [];
    db.query = async (sql, params) => {
      if (/SET status = 'building'/.test(sql)) return { rows: job ? [job] : [] };
      updates.push({ sql, params });
      return { rows: [], rowCount: 1 };
    };
    return updates;
  }
  const job = { id: 1, contract_id: "C1", source_repo: "https://github.com/o/r", source_commit: "c".repeat(40) };

  it("records a reproducible verified build using only verifier-computed hashes", async () => {
    const updates = stubDb(job);
    await processNextVerification({ build: async () => ({ hash: H1, log: "ok" }), fetchHash: async () => H1 });
    const done = updates.find((u) => /completed_at = NOW\(\)/.test(u.sql));
    assert.ok(done.params.includes("completed"));
    assert.ok(done.params.includes(true)); // reproducible
    assert.equal(done.params.filter((p) => p === H1).length, 2); // onchain + built
  });

  it("re-queues as stale when the contract is upgraded mid-build", async () => {
    const updates = stubDb(job);
    const hashes = [H1, H2];
    await processNextVerification({ build: async () => ({ hash: H1, log: "" }), fetchHash: async () => hashes.shift() });
    assert.ok(updates.some((u) => /status = 'pending'/.test(u.sql) && /stale/.test(u.sql)));
  });

  it("stores a sanitized log when the build fails", async () => {
    const updates = stubDb(job);
    const err = Object.assign(new Error("build failed"), { stderr: "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 at /home/bob/x" });
    await processNextVerification({ build: async () => { throw err; }, fetchHash: async () => H1 });
    const done = updates.find((u) => /completed_at = NOW\(\)/.test(u.sql));
    const log = done.params.find((p) => typeof p === "string" && p.includes("[REDACTED]"));
    assert.ok(log && !log.includes("bob"));
  });
});
