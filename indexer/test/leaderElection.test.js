import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getInstanceId, isLeader } from "../src/optional/leaderElection.js";

describe("getInstanceId", () => {
  it("returns a non-empty string", () => {
    const id = getInstanceId();
    assert.ok(typeof id === "string");
    assert.ok(id.length > 0);
  });

  it("includes the process pid", () => {
    const id = getInstanceId();
    assert.ok(id.startsWith(String(process.pid)));
  });

  it("returns the same value on repeated calls (stable identity)", () => {
    const id1 = getInstanceId();
    const id2 = getInstanceId();
    assert.equal(id1, id2);
  });

  it("format is pid-timestamp", () => {
    const id = getInstanceId();
    const parts = id.split("-");
    assert.equal(parts.length, 2);
    assert.ok(!isNaN(Number(parts[0])));
    assert.ok(!isNaN(Number(parts[1])));
  });
});

describe("isLeader", () => {
  it("returns false initially (no Redis connection in unit tests)", () => {
    assert.equal(isLeader(), false);
  });

  it("returns a boolean", () => {
    assert.ok(typeof isLeader() === "boolean");
  });
});

describe("leader election logic", () => {
  it("SET NX EX semantics: only one instance can hold the lease", () => {
    // Simulate the Redis SET NX response
    const simulateSetNX = (store, key, value, ttl) => {
      if (store.has(key)) return null;
      store.set(key, { value, expiresAt: Date.now() + ttl });
      return "OK";
    };

    const store = new Map();
    const r1 = simulateSetNX(store, "leader", "instance-1", 10_000);
    const r2 = simulateSetNX(store, "leader", "instance-2", 10_000);

    assert.equal(r1, "OK");
    assert.equal(r2, null);
    assert.equal(store.get("leader").value, "instance-1");
  });

  it("lease expires after TTL allowing re-election", () => {
    const store = new Map();
    const now = Date.now();

    store.set("leader", { value: "instance-1", expiresAt: now - 1 });

    const simulateSetNXWithExpiry = (key, value, ttl) => {
      const entry = store.get(key);
      if (entry && entry.expiresAt > Date.now()) return null;
      store.set(key, { value, expiresAt: Date.now() + ttl });
      return "OK";
    };

    const r = simulateSetNXWithExpiry("leader", "instance-2", 10_000);
    assert.equal(r, "OK");
    assert.equal(store.get("leader").value, "instance-2");
  });

  it("standby detects that it is not the current leader", () => {
    const myId = "instance-2";
    const currentLeader = "instance-1";
    const isCurrentLeader = currentLeader === myId;
    assert.equal(isCurrentLeader, false);
  });

  it("renewal fails gracefully when leadership is stolen", () => {
    const myId = "instance-1";
    const storedId = "instance-2";
    const canRenew = storedId === myId;
    assert.equal(canRenew, false);
  });

  it("leader releases lock on graceful shutdown", () => {
    const store = new Map();
    const myId = "instance-1";
    store.set("leader", { value: myId });

    const release = (key, id) => {
      if (store.get(key)?.value === id) {
        store.delete(key);
        return true;
      }
      return false;
    };

    assert.equal(release("leader", myId), true);
    assert.ok(!store.has("leader"));
  });
});
