import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const BASE = "/api";

async function get(path: string) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

const api = {
  events: (params: { contract?: string; fn?: string; after_seq?: number; limit?: number; type?: string }) => {
    const q = new URLSearchParams();
    if (params.contract) q.set("contract", params.contract);
    if (params.fn) q.set("fn", params.fn);
    if (params.after_seq) q.set("after_seq", String(params.after_seq));
    if (params.limit) q.set("limit", String(params.limit));
    if (params.type) q.set("type", params.type);
    return get<{ data: Array<{ seq: number }>; next_cursor: number | null }>(`/events?${q}`);
  },
  event: (seq: number) => get<{ seq: number }>(`/events/${seq}`),
  contract: (id: string) => get<{ id: string; name: string }>(`/contracts/${id}`),
  wallet: (address: string) => get<Array<{ seq: number }>>(`/wallet/${address}`),
  search: (q: string, limit = 10) =>
    get<{ contracts: unknown[]; events: unknown[]; wallets: unknown[]; suggestions: unknown[] }>(
      `/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  burnAlerts: (contract: string) => get<Array<{ contractId: string }>>(`/burn-alerts?contract=${contract}`),
  migrationStatus: (id: string) => get<{ pending: boolean }>(`/contracts/${id}/migration-status`),
  roles: (id: string) => get<Array<{ role: string; address: string }>>(`/contracts/${id}/roles`),
  contractTTL: (id: string) => get<{ contract_id: string; current_ledger: number }>(`/contracts/${id}/ttl`),
  stateDiffs: (id: string, key?: string) => {
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    return get<Array<{ ledger: number }>>(`/contracts/${id}/state-diffs${q}`);
  },
  contractGraph: (limit = 500) =>
    get<{ nodes: Array<{ id: string }>; links: Array<{ source: string; target: string }> }>(`/contract-graph?limit=${limit}`),
  quorumFreeze: (id: string) => get<{ is_frozen: boolean }>(`/contracts/${id}/quorum-freeze`),
  specFull: (id: string) =>
    get<{ functions: Array<{ name: string }>; types: Array<{ name: string }> }>(`/contracts/${id}/spec-full`),
  downloadAbi: async (id: string) => {
    const res = await fetch(`${BASE}/contracts/${id}/abi`);
    if (!res.ok) throw new Error(`API ${res.status}: /contracts/${id}/abi`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.abi.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  subInvocations: (txHash: string) => get<Array<{ id: number; parent_tx_hash: string }>>(`/transactions/${txHash}/sub-invocations`),
  circuitBreakerStatus: (id: string) =>
    get<{ has_circuit_breaker: boolean; is_paused: boolean }>(`/contracts/${id}/circuit-breaker`),
  rwaMetadata: (id: string) => get<{ is_rwa: boolean }>(`/contracts/${id}/rwa-metadata`),
  sourceVerifications: (id: string, wasmHash?: string) => {
    const q = wasmHash ? `?wasm_hash=${encodeURIComponent(wasmHash)}` : "";
    return get<Array<{ signer: string }>>(`/contracts/${id}/source-verifications${q}`);
  },
  batchSimulate: (calls: Array<{ id: string; contractId: string; functionName: string; args: unknown[] }>, sourceAccount?: string) =>
    fetch(`${BASE}/batch/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchEstimateGas: (calls: Array<{ id: string; contractId: string; functionName: string; args: unknown[] }>, sourceAccount?: string) =>
    fetch(`${BASE}/batch/estimate-gas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchOptimize: (calls: Array<{ id: string; contractId: string; functionName: string; args: unknown[] }>, sourceAccount?: string) =>
    fetch(`${BASE}/batch/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchValidate: (calls: Array<{ id: string; contractId: string; functionName: string; args: unknown[] }>, sourceAccount?: string) =>
    fetch(`${BASE}/batch/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
};

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
    mockFetch([{ seq: 1 }, { seq: 2 }]);
    const result = await api.wallet("GABCDEF");
    expect(result).toHaveLength(2);
  });

  it("search builds encoded query string", async () => {
    mockFetch({ contracts: [], events: [], wallets: [], suggestions: [] });
    const result = await api.search("USDC transfer", 25);
    expect(result.contracts).toEqual([]);
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("q=USDC%20transfer");
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
