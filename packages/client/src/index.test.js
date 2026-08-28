/**
 * Unit tests for @soroban-explorer/client.
 *
 * Runs with `node --test` — no external test framework needed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "./index.js";

// Shared test fixtures
const MOCK_EVENT = {
  seq: 42,
  contract_id: "CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44",
  function: "transfer",
  ledger: 123456,
  description: "Transfer 100 tokens from GABC... to GDEF...",
  raw_topics: [],
  tx_hash: "abc123",
};

const MOCK_CONTRACT = {
  id: "CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44",
  version: 1,
  name: "TestToken",
  description: "A test token contract",
  functions: [
    { name: "transfer", description: "Transfer tokens" },
    { name: "balance", description: "Get balance" },
  ],
};

/**
 * Create a mock fetch function that returns predefined responses.
 * @param {Record<string, object>} routes - Map of URL path → response body
 * @returns {Function} mock fetch
 */
function mockFetch(routes) {
  return async (url, init = {}) => {
    const urlObj = new URL(url);
    const path = urlObj.pathname + urlObj.search;
    const match = routes[path];
    if (match) {
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => match,
        text: async () => JSON.stringify(match),
      };
    }
    // Try matching by prefix for parameterized paths
    for (const [route, response] of Object.entries(routes)) {
      if (path.startsWith(route.split("?")[0])) {
        // Simple prefix match for parameterized routes like /api/events/42
        if (route.includes("?") && path.startsWith(route.split("?")[0])) {
          return {
            ok: true,
            status: 200,
            headers: new Map([["content-type", "application/json"]]),
            json: async () => response,
            text: async () => JSON.stringify(response),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => response,
          text: async () => JSON.stringify(response),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ error: "Not found" }),
      text: async () => JSON.stringify({ error: "Not found" }),
    };
  };
}

describe("@soroban-explorer/client", () => {
  describe("createClient", () => {
    it("should create a client with default base URL", () => {
      const client = createClient();
      assert.ok(client);
      assert.equal(typeof client.events, "function");
      assert.equal(typeof client.event, "function");
      assert.equal(typeof client.search, "function");
      assert.equal(typeof client.contract, "function");
      assert.equal(typeof client.listContracts, "function");
      assert.equal(typeof client.wallet, "function");
      assert.equal(typeof client.stats, "function");
      assert.equal(typeof client.contractAbi, "function");
    });

    it("should accept custom base URL", () => {
      const client = createClient({ baseUrl: "https://explorer.example.com" });
      assert.ok(client);
    });

    it("should accept apiKey for authenticated requests", () => {
      const client = createClient({ apiKey: "test-key-123" });
      assert.ok(client);
    });
  });

  describe("events()", () => {
    it("should fetch events with default params", async () => {
      const fetch = mockFetch({
        "/api/events?limit=25": { data: [MOCK_EVENT], next_cursor: null },
      });
      const client = createClient({ fetch });
      const result = await client.events();
      assert.deepEqual(result, { data: [MOCK_EVENT], next_cursor: null });
    });

    it("should pass contract and function filters", async () => {
      let capturedUrl = "";
      const fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ data: [], next_cursor: null }),
        };
      };
      const client = createClient({ fetch });
      await client.events({ contract: "CDA2...", fn: "transfer", limit: 10 });
      assert.ok(capturedUrl.includes("contract=CDA2..."));
      assert.ok(capturedUrl.includes("fn=transfer"));
      assert.ok(capturedUrl.includes("limit=10"));
    });

    it("should handle type filter", async () => {
      let capturedUrl = "";
      const fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: async () => ({ data: [], next_cursor: null }),
        };
      };
      const client = createClient({ fetch });
      await client.events({ type: "soroban" });
      assert.ok(capturedUrl.includes("type=soroban"));
    });
  });

  describe("event()", () => {
    it("should fetch a single event by seq", async () => {
      const fetch = mockFetch({
        "/api/events/42": MOCK_EVENT,
      });
      const client = createClient({ fetch });
      const result = await client.event(42);
      assert.deepEqual(result, MOCK_EVENT);
    });
  });

  describe("search()", () => {
    it("should search with a query", async () => {
      const fetch = mockFetch({
        "/api/search?q=transfer&limit=10": {
          query: "transfer",
          contracts: [],
          events: [MOCK_EVENT],
          wallets: [],
          suggestions: [],
        },
      });
      const client = createClient({ fetch });
      const result = await client.search("transfer");
      assert.equal(result.query, "transfer");
      assert.equal(result.events.length, 1);
    });
  });

  describe("contract()", () => {
    it("should fetch contract metadata", async () => {
      const fetch = mockFetch({
        "/api/contracts/CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44": MOCK_CONTRACT,
      });
      const client = createClient({ fetch });
      const result = await client.contract("CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44");
      assert.equal(result.name, "TestToken");
      assert.equal(result.functions.length, 2);
    });
  });

  describe("listContracts()", () => {
    it("should list contracts", async () => {
      const fetch = mockFetch({
        "/api/contracts?page=1&limit=25": {
          contracts: [{ id: "CDA2...", name: "TestToken" }],
          pagination: { page: 1, limit: 25, total: 1, total_pages: 1 },
        },
      });
      const client = createClient({ fetch });
      const result = await client.listContracts();
      assert.equal(result.contracts.length, 1);
    });
  });

  describe("wallet()", () => {
    it("should fetch wallet events", async () => {
      const fetch = mockFetch({
        "/api/wallet/GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234": {
          events: [MOCK_EVENT],
        },
      });
      const client = createClient({ fetch });
      const result = await client.wallet("GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234");
      assert.equal(result.events.length, 1);
    });
  });

  describe("stats()", () => {
    it("should fetch stats", async () => {
      const fetch = mockFetch({
        "/api/stats": { events: 1000, contracts: 50 },
      });
      const client = createClient({ fetch });
      const result = await client.stats();
      assert.equal(result.events, 1000);
      assert.equal(result.contracts, 50);
    });
  });

  describe("contractAbi()", () => {
    it("should fetch contract ABI", async () => {
      const abiData = { contractId: "CDA2...", name: "TestToken", functions: [] };
      const fetch = mockFetch({
        "/api/contracts/CDA2.../abi": abiData,
      });
      const client = createClient({ fetch });
      const result = await client.contractAbi("CDA2...");
      assert.deepEqual(result, abiData);
    });
  });

  describe("error handling", () => {
    it("should throw on non-OK responses", async () => {
      const fetch = async () => ({
        ok: false,
        status: 500,
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({ error: "Internal server error" }),
        text: async () => JSON.stringify({ error: "Internal server error" }),
      });
      const client = createClient({ fetch });
      await assert.rejects(
        () => client.events(),
        /Internal server error/,
      );
    });

    it("should handle non-JSON error bodies", async () => {
      const fetch = async () => ({
        ok: false,
        status: 502,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "Bad Gateway",
      });
      const client = createClient({ fetch });
      await assert.rejects(
        () => client.events(),
        /Bad Gateway/,
      );
    });
  });
});