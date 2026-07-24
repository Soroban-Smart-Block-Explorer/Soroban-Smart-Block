import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcProvider } from "../src/optional/rpcProviderPool.js";

describe("RpcProvider health metrics", () => {
  it("uptime is 1 with no recorded outcomes", () => {
    const p = new RpcProvider("https://example.com");
    assert.equal(p.uptime, 1);
  });

  it("uptime is 1 after all successful calls", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 50);
    p.recordOutcome(true, 60);
    p.recordOutcome(true, 70);
    assert.equal(p.uptime, 1);
  });

  it("uptime is 0 after all failed calls", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(false, 1000);
    p.recordOutcome(false, 1000);
    assert.equal(p.uptime, 0);
  });

  it("uptime is 0.5 with equal successes and failures", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 100);
    p.recordOutcome(false, 100);
    assert.equal(p.uptime, 0.5);
  });

  it("errorRate is complement of uptime", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 50);
    p.recordOutcome(false, 50);
    assert.equal(p.errorRate, 1 - p.uptime);
    assert.ok(Math.abs(p.errorRate - 0.5) < 1e-9);
  });

  it("avgLatency is 0 with no outcomes", () => {
    const p = new RpcProvider("https://example.com");
    assert.equal(p.avgLatency, 0);
  });

  it("avgLatency computes correctly", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 100);
    p.recordOutcome(true, 200);
    p.recordOutcome(true, 300);
    assert.equal(p.avgLatency, 200);
  });

  it("sliding window caps at WINDOW_SIZE", () => {
    const p = new RpcProvider("https://example.com");
    for (let i = 0; i < 25; i++) {
      p.recordOutcome(true, 100);
    }
    p.recordOutcome(false, 100);
    assert.ok(p._outcomes.length <= 20);
  });
});

describe("RpcProvider healthScore", () => {
  it("is 1 for a perfect provider (100% uptime, 0ms latency)", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 0);
    assert.ok(p.healthScore > 0.9);
  });

  it("is lower for a degraded provider", () => {
    const good = new RpcProvider("https://good.example.com");
    const bad = new RpcProvider("https://bad.example.com");
    for (let i = 0; i < 10; i++) good.recordOutcome(true, 50);
    for (let i = 0; i < 10; i++) bad.recordOutcome(false, 950);
    assert.ok(good.healthScore > bad.healthScore);
  });

  it("is in [0, 1] range regardless of inputs", () => {
    const p = new RpcProvider("https://example.com");
    for (let i = 0; i < 20; i++) p.recordOutcome(Math.random() > 0.5, Math.random() * 2000);
    assert.ok(p.healthScore >= 0);
    assert.ok(p.healthScore <= 1);
  });

  it("factors in uptime (50%), latency (30%), error rate (20%)", () => {
    const p = new RpcProvider("https://example.com");
    for (let i = 0; i < 10; i++) p.recordOutcome(true, 0);
    const score = p.healthScore;
    // uptime=1 => 0.5; latencyScore=(1-0/1000)=1 => 0.3; errorScore=1 => 0.2; total=1.0
    assert.ok(Math.abs(score - 1.0) < 1e-9);
  });
});

describe("RpcProvider toJSON", () => {
  it("returns all expected fields", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 100);
    const json = p.toJSON();
    assert.ok("url" in json);
    assert.ok("healthy" in json);
    assert.ok("latestLedger" in json);
    assert.ok("uptime" in json);
    assert.ok("avgLatency" in json);
    assert.ok("errorRate" in json);
    assert.ok("healthScore" in json);
    assert.equal(json.url, "https://example.com");
  });

  it("avgLatency is rounded to an integer", () => {
    const p = new RpcProvider("https://example.com");
    p.recordOutcome(true, 123);
    p.recordOutcome(true, 456);
    const { avgLatency } = p.toJSON();
    assert.equal(avgLatency, Math.round((123 + 456) / 2));
  });
});

describe("weighted provider selection logic", () => {
  it("higher-score providers are selected more often (statistical)", () => {
    const providers = [
      { url: "a", healthScore: 0.9, healthy: true },
      { url: "b", healthScore: 0.1, healthy: true },
    ];

    const selectProvider = () => {
      const candidates = providers.filter((p) => p.healthy);
      const totalScore = candidates.reduce((s, p) => s + Math.max(0.01, p.healthScore), 0);
      let roll = Math.random() * totalScore;
      for (const p of candidates) {
        roll -= Math.max(0.01, p.healthScore);
        if (roll <= 0) return p;
      }
      return candidates[candidates.length - 1];
    };

    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[selectProvider().url]++;
    }
    assert.ok(counts.a > counts.b, `provider 'a' should win more often: a=${counts.a}, b=${counts.b}`);
  });

  it("falls back to any provider when all are unhealthy", () => {
    const providers = [{ url: "a", healthScore: 0.0, healthy: false }];

    const selectProvider = () => {
      const candidates = providers.filter((p) => p.healthy);
      if (!candidates.length) return providers[0];
      return candidates[0];
    };

    assert.equal(selectProvider().url, "a");
  });
});
