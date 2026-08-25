// Issue #210: Sub-invocation search filters — test suite (40+ cases)
import { describe, it, expect } from "vitest";
import {
  parseQuery,
  filterToQuery,
  computeMaxDepth,
  computeAvgDepth,
  computeTopContracts,
  computeDepthDistribution,
  detectReentrancy,
  buildDependencyMap,
  computeLongestChain,
  clusterContracts,
  fuzzyMatch,
  matchesArgQuery,
} from "../src/utils/subInvocationQuery";
import type { SubInvocationExtended } from "../src/api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE: SubInvocationExtended = {
  id: 1,
  parent_tx_hash: "txA",
  depth: 0,
  contract_id: "CAAA",
  function: "transfer",
  args: [{ amount: 500, recipient: "GBBB" }],
  ledger: 1000,
};

function inv(overrides: Partial<SubInvocationExtended>): SubInvocationExtended {
  return { ...BASE, ...overrides };
}

const CHAIN_A: SubInvocationExtended[] = [
  inv({ id: 1, depth: 0, contract_id: "CAAA", function: "swap" }),
  inv({ id: 2, depth: 1, contract_id: "CBBB", function: "transfer" }),
  inv({ id: 3, depth: 2, contract_id: "CCCC", function: "mint" }),
];

const CHAIN_B: SubInvocationExtended[] = [
  inv({ id: 4, parent_tx_hash: "txB", depth: 0, contract_id: "CAAA", function: "burn" }),
  inv({ id: 5, parent_tx_hash: "txB", depth: 1, contract_id: "CAAA", function: "transfer" }), // reentrant
];

// ── parseQuery ────────────────────────────────────────────────────────────────

describe("parseQuery", () => {
  it("parses of: filter", () => {
    expect(parseQuery("of:CABC")).toEqual({ contract: "CABC" });
  });

  it("parses fn: filter", () => {
    expect(parseQuery("fn:transfer")).toEqual({ function: "transfer" });
  });

  it("parses depth:> operator", () => {
    expect(parseQuery("depth:>3")).toMatchObject({ depth_min: 4 });
  });

  it("parses depth:>= operator", () => {
    expect(parseQuery("depth:>=3")).toMatchObject({ depth_min: 3 });
  });

  it("parses depth:< operator", () => {
    expect(parseQuery("depth:<5")).toMatchObject({ depth_max: 4 });
  });

  it("parses exact depth", () => {
    const f = parseQuery("depth:2");
    expect(f.depth_min).toBe(2);
    expect(f.depth_max).toBe(2);
  });

  it("parses gas:> filter", () => {
    expect(parseQuery("gas:>50000")).toMatchObject({ gas_min: 50000 });
  });

  it("parses gas:< filter", () => {
    expect(parseQuery("gas:<100000")).toMatchObject({ gas_max: 100000 });
  });

  it("parses date range", () => {
    const f = parseQuery("date:2024-01-01..2024-12-31");
    expect(f.date_from).toBe("2024-01-01");
    expect(f.date_to).toBe("2024-12-31");
  });

  it("parses single date", () => {
    const f = parseQuery("date:2024-06-01");
    expect(f.date_from).toBe("2024-06-01");
    expect(f.date_to).toBeUndefined();
  });

  it("parses arg: filter", () => {
    expect(parseQuery("arg:amount>100")).toMatchObject({ arg_query: "amount>100" });
  });

  it("parses reentrant:true", () => {
    expect(parseQuery("reentrant:true")).toMatchObject({ has_reentrancy: true });
  });

  it("parses reentrant:false", () => {
    expect(parseQuery("reentrant:false")).toMatchObject({ has_reentrancy: false });
  });

  it("parses ledger:> filter", () => {
    expect(parseQuery("ledger:>1000000")).toMatchObject({ ledger_min: 1000000 });
  });

  it("parses tx: filter", () => {
    expect(parseQuery("tx:abc123")).toMatchObject({ tx_hash: "abc123" });
  });

  it("combines multiple filters", () => {
    const f = parseQuery("of:CAAA fn:transfer depth:>2 gas:>50000");
    expect(f.contract).toBe("CAAA");
    expect(f.function).toBe("transfer");
    expect(f.depth_min).toBe(3);
    expect(f.gas_min).toBe(50000);
  });

  it("treats unrecognized tokens as free-text arg_query", () => {
    const f = parseQuery("hello world");
    expect(f.arg_query).toBe("hello world");
  });

  it("appends free text to existing arg_query", () => {
    const f = parseQuery("arg:amount>0 mytoken");
    expect(f.arg_query).toBe("amount>0 mytoken");
  });

  it("returns empty object for empty query", () => {
    expect(parseQuery("")).toEqual({});
  });

  it("returns empty object for whitespace-only query", () => {
    expect(parseQuery("   ")).toEqual({});
  });
});

// ── filterToQuery (round-trip) ────────────────────────────────────────────────

describe("filterToQuery", () => {
  it("serializes contract filter", () => {
    expect(filterToQuery({ contract: "CAAA" })).toContain("of:CAAA");
  });

  it("serializes function filter", () => {
    expect(filterToQuery({ function: "transfer" })).toContain("fn:transfer");
  });

  it("serializes depth_min", () => {
    expect(filterToQuery({ depth_min: 3 })).toContain("depth:>=3");
  });

  it("serializes exact depth when min===max", () => {
    expect(filterToQuery({ depth_min: 2, depth_max: 2 })).toContain("depth:2");
  });

  it("serializes gas_min", () => {
    expect(filterToQuery({ gas_min: 50000 })).toContain("gas:>50000");
  });

  it("serializes date range", () => {
    const q = filterToQuery({ date_from: "2024-01-01", date_to: "2024-12-31" });
    expect(q).toContain("date:2024-01-01..2024-12-31");
  });

  it("serializes reentrant filter", () => {
    expect(filterToQuery({ has_reentrancy: true })).toContain("reentrant:true");
  });
});

// ── Analytics helpers ─────────────────────────────────────────────────────────

describe("computeMaxDepth", () => {
  it("returns max depth in list", () => {
    expect(computeMaxDepth(CHAIN_A)).toBe(2);
  });

  it("returns 0 for empty list", () => {
    expect(computeMaxDepth([])).toBe(0);
  });
});

describe("computeAvgDepth", () => {
  it("computes average depth", () => {
    expect(computeAvgDepth(CHAIN_A)).toBeCloseTo(1);
  });

  it("returns 0 for empty list", () => {
    expect(computeAvgDepth([])).toBe(0);
  });
});

describe("computeTopContracts", () => {
  it("ranks by call count", () => {
    const items = [
      ...CHAIN_A,
      inv({ id: 10, contract_id: "CAAA", function: "burn" }),
    ];
    const top = computeTopContracts(items, 3);
    expect(top[0].contract_id).toBe("CAAA");
    expect(top[0].call_count).toBe(2);
  });

  it("respects limit", () => {
    expect(computeTopContracts(CHAIN_A, 2)).toHaveLength(2);
  });

  it("returns empty for empty list", () => {
    expect(computeTopContracts([], 5)).toHaveLength(0);
  });
});

describe("computeDepthDistribution", () => {
  it("groups by depth level", () => {
    const dist = computeDepthDistribution(CHAIN_A);
    expect(dist).toEqual([
      { depth: 0, count: 1 },
      { depth: 1, count: 1 },
      { depth: 2, count: 1 },
    ]);
  });

  it("returns empty for empty list", () => {
    expect(computeDepthDistribution([])).toHaveLength(0);
  });
});

describe("detectReentrancy", () => {
  it("detects when same contract appears twice in same tx chain", () => {
    const reentrant = detectReentrancy(CHAIN_B);
    expect(reentrant.length).toBeGreaterThan(0);
    expect(reentrant.every((r) => r.contract_id === "CAAA")).toBe(true);
  });

  it("returns empty when no reentrancy", () => {
    expect(detectReentrancy(CHAIN_A)).toHaveLength(0);
  });
});

describe("buildDependencyMap", () => {
  it("maps callers to callees", () => {
    const map = buildDependencyMap(CHAIN_A);
    expect(map["CAAA"]).toContain("CBBB");
    expect(map["CBBB"]).toContain("CCCC");
  });

  it("returns empty object for empty list", () => {
    expect(buildDependencyMap([])).toEqual({});
  });
});

describe("computeLongestChain", () => {
  it("finds chain with most invocations", () => {
    const all = [...CHAIN_A, ...CHAIN_B];
    const chain = computeLongestChain(all);
    expect(chain.length).toBe(CHAIN_A.length);
  });
});

describe("clusterContracts", () => {
  it("groups contracts that co-appear in same tx", () => {
    const clusters = clusterContracts(CHAIN_A);
    expect(clusters.length).toBeGreaterThan(0);
  });
});

// ── fuzzyMatch ────────────────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  it("matches exact substring", () => {
    expect(fuzzyMatch("transfer_token", "transfer")).toBe(true);
  });

  it("matches fuzzy character sequence", () => {
    expect(fuzzyMatch("transfer", "trnsfr")).toBe(true);
  });

  it("rejects non-matching", () => {
    expect(fuzzyMatch("transfer", "xyz")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("TRANSFER", "transfer")).toBe(true);
  });
});

// ── matchesArgQuery ───────────────────────────────────────────────────────────

describe("matchesArgQuery", () => {
  const sample = inv({ args: [{ amount: 500, recipient: "GBBB" }] });

  it("matches on arg content", () => {
    expect(matchesArgQuery(sample, "amount")).toBe(true);
  });

  it("matches on function name", () => {
    expect(matchesArgQuery(sample, "transfer")).toBe(true);
  });

  it("supports OR boolean operator", () => {
    expect(matchesArgQuery(sample, "xyz or amount")).toBe(true);
  });

  it("supports AND boolean operator — both match", () => {
    expect(matchesArgQuery(sample, "amount and recipient")).toBe(true);
  });

  it("supports AND boolean operator — one fails", () => {
    expect(matchesArgQuery(sample, "amount and NOTEXISTENT12345")).toBe(false);
  });

  it("supports numeric range amount>100", () => {
    expect(matchesArgQuery(sample, "amount>100")).toBe(true);
  });

  it("supports numeric range amount>1000 (should fail)", () => {
    expect(matchesArgQuery(sample, "amount>1000")).toBe(false);
  });

  it("returns true for empty query", () => {
    expect(matchesArgQuery(sample, "")).toBe(true);
  });

  it("fuzzy-matches contract_id", () => {
    expect(matchesArgQuery(sample, "CAA")).toBe(true);
  });
});
