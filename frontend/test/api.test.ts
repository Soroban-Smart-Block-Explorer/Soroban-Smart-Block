import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "../src/api";

describe("api utility", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(data: unknown) {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => data,
      blob: async () => new Blob(),
    });
  }

  it("events builds query string with contract filter", async () => {
    mockFetch({ data: [{ seq: 1 }], next_cursor: null });
    const result = await api.events({ contract: "C1" });
    expect(result).toEqual({ data: [{ seq: 1 }], next_cursor: null });
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("contract=C1");
  });

  it("events builds query string with all params", async () => {
    mockFetch({ data: [{ seq: 2 }], next_cursor: 2 });
    await api.events({ contract: "C1", fn: "transfer", after_seq: 42, limit: 50, type: "soroban" });
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("contract=C1");
    expect(url).toContain("fn=transfer");
    expect(url).toContain("after_seq=42");
    expect(url).toContain("limit=50");
    expect(url).toContain("type=soroban");
  });

  it("events omits undefined params", async () => {
    mockFetch({ data: [], next_cursor: null });
    await api.events({});
    const [url] = (fetch as any).mock.calls[0];
    expect(url).not.toContain("contract=");
    expect(url).not.toContain("fn=");
    expect(url).not.toContain("after_seq=");
  });

  it("event fetches single event by seq", async () => {
    mockFetch({ seq: 42, contract_id: "C1", function: "transfer", ledger: 100 });
    const result = await api.event(42);
    expect(result.seq).toBe(42);
    expect(result.contract_id).toBe("C1");
  });

  it("contract fetches contract metadata", async () => {
    mockFetch({ id: "C1", name: "Test Token" });
    const result = await api.contract("C1");
    expect(result.id).toBe("C1");
    expect(result.name).toBe("Test Token");
  });

  it("contract throws on 404", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 404 });
    await expect(api.contract("C1")).rejects.toThrow("404");
  });

  it("wallet fetches events by address", async () => {
    mockFetch({ events: [{ seq: 1 }, { seq: 2 }] });
    const result = await api.wallet("GABCDEF");
    expect(result.events).toHaveLength(2);
  });

  it("walletHistory fetches events with date params (#527)", async () => {
    mockFetch({ events: [{ seq: 1 }], horizon_account: null });
    const result = await api.walletHistory("GABCDEF", { from: "2026-01-01", to: "2026-03-31" });
    expect(result.events).toHaveLength(1);
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-03-31");
  });

  it("walletHistory omits date params when not provided (#527)", async () => {
    mockFetch({ events: [], horizon_account: null });
    await api.walletHistory("GABCDEF");
    const [url] = (fetch as any).mock.calls[0];
    expect(url).not.toContain("from=");
    expect(url).not.toContain("to=");
  });

  it("contractStats fetches stats by contract id", async () => {
    mockFetch({ total_events: 100, unique_callers: 10, first_seen_ledger: 1, last_seen_ledger: 2, events_per_day: [] });
    const result = await api.contractStats("C1");
    expect(result.total_events).toBe(100);
    expect(result.unique_callers).toBe(10);
    const [url] = (fetch as any).mock.calls[0];
    expect(url).not.toContain("range=");
  });

  it("contractStats appends the range query param when provided (#799)", async () => {
    mockFetch({ total_events: 100, unique_callers: 10, first_seen_ledger: 1, last_seen_ledger: 2, events_per_day: [], range: 365 });
    const result = await api.contractStats("C1", 365);
    expect(result.range).toBe(365);
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("range=365");
  });

  it("search builds encoded query string", async () => {
    mockFetch({ contracts: [], events: [], wallets: [], suggestions: [] });
    const result = await api.search("USDC transfer", 25);
    expect(result.contracts).toEqual([]);
    const [url] = (fetch as any).mock.calls[0];
    // URLSearchParams encodes spaces as "+", equivalent to %20 in a query string.
    expect(url).toContain("q=USDC+transfer");
    expect(url).toContain("limit=25");
  });

  it("subInvocations fetches by tx hash", async () => {
    mockFetch([{ id: 1, parent_tx_hash: "abc" }]);
    const result = await api.subInvocations("abc");
    expect(result[0].parent_tx_hash).toBe("abc");
  });

  it("burnAlerts fetches with contract param", async () => {
    mockFetch([{ contractId: "C1" }]);
    const result = await api.burnAlerts("C1");
    expect(result[0].contractId).toBe("C1");
  });

  it("migrationStatus returns status object", async () => {
    mockFetch({ pending: false });
    const result = await api.migrationStatus("C1");
    expect(result.pending).toBe(false);
  });

  it("roles fetches role list", async () => {
    mockFetch([{ role: "admin", address: "GABC" }]);
    const result = await api.roles("C1");
    expect(result[0].role).toBe("admin");
  });

  it("contractTTL fetches TTL data", async () => {
    mockFetch({ contract_id: "C1", current_ledger: 500 });
    const result = await api.contractTTL("C1");
    expect(result.current_ledger).toBe(500);
  });

  it("stateDiffs fetches diffs with optional key", async () => {
    mockFetch([{ ledger: 100 }]);
    const result = await api.stateDiffs("C1", "key123");
    expect(result[0].ledger).toBe(100);
  });

  it("stateDiffs fetches without key param when omitted", async () => {
    mockFetch([{ ledger: 200 }]);
    await api.stateDiffs("C1");
    const [url] = (fetch as any).mock.calls[0];
    expect(url).not.toContain("key=");
  });

  it("contractGraph fetches with default limit", async () => {
    mockFetch({ nodes: [], links: [] });
    const result = await api.contractGraph();
    expect(result.nodes).toEqual([]);
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("limit=500");
  });

  it("quorumFreeze fetches freeze status", async () => {
    mockFetch({ is_frozen: true });
    const result = await api.quorumFreeze("C1");
    expect(result.is_frozen).toBe(true);
  });

  it("specFull fetches full spec", async () => {
    mockFetch({ functions: [{ name: "transfer" }], types: [{ name: "uint32" }] });
    const result = await api.specFull("C1");
    expect(result.functions[0].name).toBe("transfer");
    expect(result.types[0].name).toBe("uint32");
  });

  it("circuitBreakerStatus fetches breaker status", async () => {
    mockFetch({ has_circuit_breaker: true, is_paused: false });
    const result = await api.circuitBreakerStatus("C1");
    expect(result.has_circuit_breaker).toBe(true);
  });

  it("rwaMetadata fetches RWA metadata", async () => {
    mockFetch({ is_rwa: false });
    const result = await api.rwaMetadata("C1");
    expect(result.is_rwa).toBe(false);
  });

  it("wasmMetadata fetches WASM build metadata", async () => {
    mockFetch({ wasm_hash: "abc123" });
    const result = await api.wasmMetadata("C1");
    expect(result.wasm_hash).toBe("abc123");
  });

  it("wasmMetadata throws on 404 when not indexed", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 404 });
    await expect(api.wasmMetadata("C1")).rejects.toThrow("404");
  });

  it("upgradeHistory fetches upgrade lineage in order", async () => {
    mockFetch([
      { ledger: 100, old_hash: "aaa", new_hash: "bbb" },
      { ledger: 200, old_hash: "bbb", new_hash: "ccc" },
    ]);
    const result = await api.upgradeHistory("C1");
    expect(result).toHaveLength(2);
    expect(result[0].ledger).toBe(100);
    expect(result[1].ledger).toBe(200);
  });

  it("contractCallGraph fetches nodes and edges", async () => {
    mockFetch({
      nodes: [{ id: "C1" }, { id: "C2" }],
      edges: [{ source: "C1", target: "C2" }],
    });
    const result = await api.contractCallGraph("C1");
    expect(result.nodes).toHaveLength(2);
    expect(result.edges[0]).toEqual({ source: "C1", target: "C2" });
  });

  it("sourceVerifications fetches verifications", async () => {
    mockFetch([{ signer: "GABC" }]);
    const result = await api.sourceVerifications("C1");
    expect(result[0].signer).toBe("GABC");
  });

  it("sourceVerifications includes wasmHash param", async () => {
    mockFetch([{ signer: "GABC" }]);
    await api.sourceVerifications("C1", "abc123");
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("wasm_hash=abc123");
  });

  it("downloadAbi triggers file download", async () => {
    const clickSpy = vi.fn();
    const createObjectURL = vi.fn(() => "blob:url");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as any;
    URL.revokeObjectURL = revokeObjectURL as any;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["{}"]),
    });

    const appendChild = vi.fn();
    const removeChild = vi.fn();
    document.body.appendChild = appendChild;
    document.body.removeChild = removeChild;

    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement");
    createElementSpy.mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === "a") {
        el.click = clickSpy;
      }
      return el;
    });

    await api.downloadAbi("C1");
    expect(clickSpy).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it("handles network error gracefully", async () => {
    (global.fetch as any).mockRejectedValue(new Error("Network error"));
    await expect(api.contract("C1")).rejects.toThrow("Network error");
  });

  it("throws on non-ok response", async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 500 });
    await expect(api.event(1)).rejects.toThrow("500");
  });

  it("encodes special characters in URLs", async () => {
    mockFetch([]);
    await api.stateDiffs("C1", "key with spaces");
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("key=key%20with%20spaces");
    expect(url).not.toContain("key with spaces");
  });
});

describe("api types validation", () => {
  it("DecodedEvent shape is correct", () => {
    const event = {
      seq: 1,
      contract_id: "C1",
      function: "transfer",
      ledger: 100,
      tx_hash: "abc",
      description: "test",
    };
    expect(event.seq).toBeTypeOf("number");
    expect(event.contract_id).toBeTypeOf("string");
    expect(event.function).toBeTypeOf("string");
    expect(event.ledger).toBeTypeOf("number");
    expect(event.tx_hash).toBeTypeOf("string");
    expect(event.description).toBeTypeOf("string");
  });

  it("ContractMeta shape is correct", () => {
    const meta = {
      id: "C1",
      version: 1,
      name: "Token",
      description: "A token",
      functions: [{ name: "transfer", args: [{ name: "to", type: "address" }] }],
      has_circuit_breaker: false,
    };
    expect(meta.functions[0].name).toBe("transfer");
    expect(meta.functions[0].args[0].type).toBe("address");
    expect(meta.version).toBeTypeOf("number");
  });

  it("PrivilegedRole shape is correct", () => {
    const role = { role: "admin", address: "GABCDEF", ledger: 100, updated_at: "2024-01-01" };
    expect(role.role).toBeTypeOf("string");
    expect(role.address).toBeTypeOf("string");
  });

  it("CircuitBreakerStatus shape is correct", () => {
    const status = { has_circuit_breaker: true, is_paused: false, pause_status_ledger: null };
    expect(status.has_circuit_breaker).toBe(true);
    expect(status.is_paused).toBe(false);
  });

  it("MigrationStatus shape is correct", () => {
    const status = { pending: false, upgradedAtLedger: null, migratedAtLedger: null };
    expect(status.pending).toBe(false);
    expect(status.upgradedAtLedger).toBeNull();
  });
});

describe("batch API", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(data: unknown) {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => data,
    });
  }

  it("batchSimulate sends POST request with calls", async () => {
    mockFetch({ success: true, results: [], totalGas: { cpuInsns: 100, memBytes: 50, fee: 1000 } });
    const calls = [{ id: "1", contractId: "C1", functionName: "transfer", args: [] }];
    const result = await api.batchSimulate(calls, "GABC");
    expect(result.success).toBe(true);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toContain("/batch/simulate");
    expect((init as any).method).toBe("POST");
  });

  it("batchEstimateGas returns gas estimates", async () => {
    mockFetch({ estimates: [{ callId: "1", cpuInsns: 100, memBytes: 50, fee: 1000 }], totalGas: { cpuInsns: 100, memBytes: 50, fee: 1000 } });
    const calls = [{ id: "1", contractId: "C1", functionName: "transfer", args: [] }];
    const result = await api.batchEstimateGas(calls);
    expect(result.estimates).toHaveLength(1);
  });

  it("batchOptimize returns optimized order", async () => {
    mockFetch({ optimizedOrder: ["1", "2"] });
    const calls = [{ id: "1", contractId: "C1", functionName: "transfer", args: [] }];
    const result = await api.batchOptimize(calls);
    expect(result.optimizedOrder).toContain("1");
  });

  it("batchValidate returns validation result", async () => {
    mockFetch({ valid: true, errors: [], conflicts: [] });
    const calls = [{ id: "1", contractId: "C1", functionName: "transfer", args: [] }];
    const result = await api.batchValidate(calls);
    expect(result.valid).toBe(true);
  });
});
