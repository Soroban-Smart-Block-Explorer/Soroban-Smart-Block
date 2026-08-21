import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { SorobanExplorerClient } from "../src/client.js";
import {
  NotFoundError,
  RateLimitError,
  ValidationError,
  UnauthorizedError,
  SorobanExplorerError,
} from "../src/errors.js";

// ── Mock fetch helper ──────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return mock.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get: (key: string) => headers?.[key.toLowerCase()] ?? null,
    },
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

function createClient(fetchImpl: typeof globalThis.fetch) {
  return new SorobanExplorerClient({
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    fetch: fetchImpl,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SorobanExplorerClient", () => {
  describe("constructor", () => {
    it("throws when baseUrl is missing", () => {
      assert.throws(
        () => new SorobanExplorerClient({ baseUrl: "" }),
        /baseUrl is required/,
      );
    });

    it("strips trailing slash from baseUrl", () => {
      const f = mockFetch(200, { data: [], next_cursor: null });
      const client = new SorobanExplorerClient({
        baseUrl: "https://api.example.com/",
        fetch: f,
      });
      client.getEvents();
      const call = (f as any).mock.calls[0];
      assert.ok(
        call.arguments[0].startsWith("https://api.example.com/api/events"),
        `URL should not have double slash, got: ${call.arguments[0]}`,
      );
    });
  });

  describe("getEvents", () => {
    it("returns cursor-paginated events", async () => {
      const mockData = {
        data: [{ seq: 1, ledger: 100, contract_id: "C123", type: "soroban" }],
        next_cursor: 1,
      };
      const f = mockFetch(200, mockData);
      const client = createClient(f);

      const result = await client.getEvents({ contract: "C123", limit: 10 });

      assert.deepEqual(result, mockData);
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].includes("/api/events?"));
      assert.ok(call.arguments[0].includes("contract=C123"));
      assert.ok(call.arguments[0].includes("limit=10"));
    });

    it("sends x-api-key header", async () => {
      const f = mockFetch(200, { data: [], next_cursor: null });
      const client = createClient(f);
      await client.getEvents();

      const call = (f as any).mock.calls[0];
      assert.equal(call.arguments[1].headers["x-api-key"], "test-key");
    });

    it("omits undefined filter params from query string", async () => {
      const f = mockFetch(200, { data: [], next_cursor: null });
      const client = createClient(f);
      await client.getEvents();

      const call = (f as any).mock.calls[0];
      // Should be just "/api/events" with no query params
      assert.equal(call.arguments[0], "https://api.example.com/api/events");
    });
  });

  describe("getEvent", () => {
    it("returns a single event by seq", async () => {
      const ev = { seq: 42, ledger: 200, type: "soroban" };
      const f = mockFetch(200, ev);
      const client = createClient(f);

      const result = await client.getEvent(42);
      assert.deepEqual(result, ev);
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/events/42"));
    });
  });

  describe("getContract", () => {
    it("returns contract metadata", async () => {
      const meta = { id: "C123", name: "TestToken", functions: [] };
      const f = mockFetch(200, meta);
      const client = createClient(f);

      const result = await client.getContract("C123");
      assert.deepEqual(result, meta);
    });
  });

  describe("getContracts", () => {
    it("passes pagination and filter params", async () => {
      const response = {
        contracts: [],
        pagination: { page: 2, limit: 10, total: 0, total_pages: 0 },
      };
      const f = mockFetch(200, response);
      const client = createClient(f);

      await client.getContracts({ page: 2, limit: 10, type: "token" });
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].includes("page=2"));
      assert.ok(call.arguments[0].includes("limit=10"));
      assert.ok(call.arguments[0].includes("type=token"));
    });
  });

  describe("getWalletEvents", () => {
    it("passes fn, from, to filters", async () => {
      const response = { events: [], horizon_account: null };
      const f = mockFetch(200, response);
      const client = createClient(f);

      await client.getWalletEvents("GABC123", {
        fn: "transfer,mint",
        from: "2025-01-01",
        to: "2025-12-31",
      });

      const call = (f as any).mock.calls[0];
      const url = call.arguments[0] as string;
      assert.ok(url.includes("/api/wallet/GABC123"));
      assert.ok(url.includes("fn=transfer%2Cmint"));
      assert.ok(url.includes("from=2025-01-01"));
      assert.ok(url.includes("to=2025-12-31"));
    });
  });

  describe("search", () => {
    it("sends query and limit params", async () => {
      const response = { query: "token", contracts: [], events: [], wallets: [], suggestions: [] };
      const f = mockFetch(200, response);
      const client = createClient(f);

      await client.search("token", 5);
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].includes("q=token"));
      assert.ok(call.arguments[0].includes("limit=5"));
    });
  });

  describe("getStats", () => {
    it("returns global stats", async () => {
      const stats = { events: 1000, contracts: 50 };
      const f = mockFetch(200, stats);
      const client = createClient(f);

      const result = await client.getStats();
      assert.deepEqual(result, stats);
    });
  });

  describe("getHealth", () => {
    it("returns health status", async () => {
      const health = { status: "healthy", timestamp: "2025-01-01T00:00:00Z" };
      const f = mockFetch(200, health);
      const client = createClient(f);

      const result = await client.getHealth();
      assert.deepEqual(result, health);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws NotFoundError on 404", async () => {
      const f = mockFetch(404, { error: "Not found" });
      const client = createClient(f);

      await assert.rejects(() => client.getEvent(999), (err: unknown) => {
        assert.ok(err instanceof NotFoundError);
        assert.equal(err.status, 404);
        assert.equal(err.message, "Not found");
        return true;
      });
    });

    it("throws RateLimitError on 429 with Retry-After", async () => {
      const f = mockFetch(429, { error: "Too many requests" }, { "retry-after": "30" });
      const client = createClient(f);

      await assert.rejects(() => client.getEvents(), (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.retryAfter, 30);
        return true;
      });
    });

    it("throws ValidationError on 400", async () => {
      const f = mockFetch(400, { error: "Missing search query" });
      const client = createClient(f);

      await assert.rejects(() => client.search(""), (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.status, 400);
        return true;
      });
    });

    it("throws ValidationError on 422", async () => {
      const f = mockFetch(422, { error: "Invalid limit" });
      const client = createClient(f);

      await assert.rejects(() => client.getEvents({ limit: -1 }), (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.status, 422);
        return true;
      });
    });

    it("throws UnauthorizedError on 401", async () => {
      const f = mockFetch(401, { error: "Unauthorized" });
      const client = createClient(f);

      await assert.rejects(() => client.getEvents(), (err: unknown) => {
        assert.ok(err instanceof UnauthorizedError);
        assert.equal(err.status, 401);
        return true;
      });
    });

    it("throws SorobanExplorerError on other status codes", async () => {
      const f = mockFetch(500, { error: "Internal server error" });
      const client = createClient(f);

      await assert.rejects(() => client.getEvents(), (err: unknown) => {
        assert.ok(err instanceof SorobanExplorerError);
        assert.equal(err.status, 500);
        return true;
      });
    });
  });

  // ── Contract sub-resource methods ────────────────────────────────────────────

  describe("contract sub-resources", () => {
    it("getContractStats hits correct URL", async () => {
      const f = mockFetch(200, { total_events: 100 });
      const client = createClient(f);
      await client.getContractStats("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/contracts/C123/stats"));
    });

    it("getContractAbiHistory hits correct URL", async () => {
      const f = mockFetch(200, { contract_id: "C123", history: [] });
      const client = createClient(f);
      await client.getContractAbiHistory("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/contracts/C123/abi-history"));
    });

    it("getContractUpgrades hits correct URL", async () => {
      const f = mockFetch(200, []);
      const client = createClient(f);
      await client.getContractUpgrades("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/contracts/C123/upgrades"));
    });

    it("getContractTtl hits correct URL", async () => {
      const f = mockFetch(200, { contract_id: "C123", current_ledger: 500 });
      const client = createClient(f);
      await client.getContractTtl("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/contracts/C123/ttl"));
    });

    it("getContractCallGraph passes limit param", async () => {
      const f = mockFetch(200, { nodes: [], edges: [] });
      const client = createClient(f);
      await client.getContractCallGraph("C123", 20);
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].includes("/api/contracts/C123/call-graph?limit=20"));
    });

    it("getContractStorageTiers hits correct URL", async () => {
      const f = mockFetch(200, { temporary: 0, persistent: 5, instance: 1 });
      const client = createClient(f);
      await client.getContractStorageTiers("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/contracts/C123/storage-tiers"));
    });

    it("getContractEvents passes pagination params", async () => {
      const f = mockFetch(200, { events: [], pagination: { page: 2, limit: 5, total: 0 } });
      const client = createClient(f);
      await client.getContractEvents("C123", { page: 2, limit: 5 });
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].includes("/api/contracts/C123/events?"));
      assert.ok(call.arguments[0].includes("page=2"));
      assert.ok(call.arguments[0].includes("limit=5"));
    });
  });

  // ── Token methods ────────────────────────────────────────────────────────────

  describe("token methods", () => {
    it("getTokenHolders hits correct URL", async () => {
      const f = mockFetch(200, { contract_id: "C123", holders: [] });
      const client = createClient(f);
      await client.getTokenHolders("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/tokens/C123/holders"));
    });

    it("getTokenVolume hits correct URL", async () => {
      const f = mockFetch(200, { contract_id: "C123", window: "24h" });
      const client = createClient(f);
      await client.getTokenVolume("C123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/tokens/C123/volume"));
    });
  });

  // ── Wallet methods ───────────────────────────────────────────────────────────

  describe("wallet methods", () => {
    it("getWalletBalances hits correct URL", async () => {
      const f = mockFetch(200, { balances: [] });
      const client = createClient(f);
      await client.getWalletBalances("GABC123");
      const call = (f as any).mock.calls[0];
      assert.ok(call.arguments[0].endsWith("/api/wallet/GABC123/balances"));
    });
  });
});
