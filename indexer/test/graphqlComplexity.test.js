import { jest } from "@jest/globals";
import request from "supertest";

const { graphqlComplexityLimiter, TIER_COMPLEXITY_BUDGETS } = await import("../src/rateLimit/graphqlComplexity.js");

// Create a minimal Express app with the complexity limiter for testing
function createMockApp() {
  const express = await import("express");
  const app = express.default();

  app.use(express.default.json());

  // Mock rate context middleware (sets tier)
  app.use((req, res, next) => {
    req.rateContext = { tier: "unauthenticated" };
    next();
  });

  app.use(graphqlComplexityLimiter);

  app.post("/graphql", (req, res) => {
    // Mock GraphQL endpoint that accepts any query
    res.json({ data: { success: true } });
  });

  return app;
}

describe("GraphQL Query Complexity Limiter Integration Tests", () => {
  let app;

  beforeEach(async () => {
    app = await createMockApp();
  });

  describe("Complexity Budget Enforcement", () => {
    it("accepts a simple query within the complexity budget", async () => {
      const query = `
        {
          events(contract: "CABC123") {
            data {
              seq
              contract_id
              function
            }
            next_cursor
          }
        }
      `;

      const res = await request(app)
        .post("/graphql")
        .send({ query });

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
      expect(res.headers["x-graphql-cost"]).toBeDefined();
      const cost = parseInt(res.headers["x-graphql-cost"]);
      expect(cost).toBeLessThanOrEqual(TIER_COMPLEXITY_BUDGETS.unauthenticated);
    });

    it("rejects a query that exceeds the complexity budget", async () => {
      // Construct a query with many fields to exceed budget
      // The unauthenticated budget is 100
      // Each 'events' (list field) costs 10, 'data' costs 10
      // Each Event field costs 1
      // We'll select all Event fields multiple times to exceed the budget
      const query = `
        {
          events1: events(contract: "C1") {
            data {
              seq
              contract_id
              function
              function_name
              ledger
              ledger_sequence
              tx_hash
              description
              cpu_instructions
              mem_bytes
              fee_charged
              is_high_bloat_risk
              is_clawback
            }
            next_cursor
          }
          events2: events(contract: "C2") {
            data {
              seq
              contract_id
              function
              function_name
              ledger
              ledger_sequence
              tx_hash
              description
              cpu_instructions
              mem_bytes
              fee_charged
              is_high_bloat_risk
              is_clawback
            }
            next_cursor
          }
          events3: events(contract: "C3") {
            data {
              seq
              contract_id
              function
              function_name
              ledger
              ledger_sequence
              tx_hash
              description
              cpu_instructions
              mem_bytes
              fee_charged
              is_high_bloat_risk
              is_clawback
            }
            next_cursor
          }
          events4: events(contract: "C4") {
            data {
              seq
              contract_id
              function
              function_name
              ledger
              ledger_sequence
              tx_hash
              description
              cpu_instructions
              mem_bytes
              fee_charged
              is_high_bloat_risk
              is_clawback
            }
            next_cursor
          }
        }
      `;

      const res = await request(app)
        .post("/graphql")
        .send({ query });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Query complexity exceeded");
      expect(res.body.cost).toBeDefined();
      expect(res.body.limit).toBe(TIER_COMPLEXITY_BUDGETS.unauthenticated);
      expect(res.body.cost).toBeGreaterThan(res.body.limit);
    });

    it("provides clear error message including cost and limit", async () => {
      const query = `
        {
          events1: events { data { seq contract_id function function_name ledger ledger_sequence tx_hash description cpu_instructions mem_bytes fee_charged is_high_bloat_risk is_clawback } }
          events2: events { data { seq contract_id function function_name ledger ledger_sequence tx_hash description cpu_instructions mem_bytes fee_charged is_high_bloat_risk is_clawback } }
          events3: events { data { seq contract_id function function_name ledger ledger_sequence tx_hash description cpu_instructions mem_bytes fee_charged is_high_bloat_risk is_clawback } }
          events4: events { data { seq contract_id function function_name ledger ledger_sequence tx_hash description cpu_instructions mem_bytes fee_charged is_high_bloat_risk is_clawback } }
        }
      `;

      const res = await request(app)
        .post("/graphql")
        .send({ query });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "Query complexity exceeded",
        cost: expect.any(Number),
        limit: expect.any(Number),
      });
    });
  });

  describe("List Field Cost Multiplier", () => {
    it("applies 10x cost multiplier to list fields", async () => {
      // Single 'events' query (list field, cost 10)
      const query1 = `{ events { data { seq } } }`;
      const res1 = await request(app).post("/graphql").send({ query1 });

      const cost1 = parseInt(res1.headers["x-graphql-cost"]);

      // Single 'event' query (not a list, cost 1) with same nested fields
      const query2 = `{ event(seq: 1) { seq } }`;
      const res2 = await request(app).post("/graphql").send({ query2 });

      const cost2 = parseInt(res2.headers["x-graphql-cost"]);

      // The first query should cost more due to 'events' being a list field
      expect(cost1).toBeGreaterThan(cost2);
    });

    it("identifies plural field names as list fields", async () => {
      // 'data' ends with 's' but is in LIST_FIELD_NAMES, so it's a list field
      const query = `
        {
          events {
            data {
              seq
            }
          }
        }
      `;

      const res = await request(app).post("/graphql").send({ query });

      const cost = parseInt(res.headers["x-graphql-cost"]);
      // Cost should include: events (10) + data (10) + seq (1) = 21
      expect(cost).toBeGreaterThanOrEqual(21);
    });
  });

  describe("Tier-based Budget Limits", () => {
    it("enforces different budgets for different tiers", async () => {
      const complexQuery = `
        {
          events1: events { data { seq contract_id function } }
          events2: events { data { seq contract_id function } }
          events3: events { data { seq contract_id function } }
          events4: events { data { seq contract_id function } }
          events5: events { data { seq contract_id function } }
        }
      `;

      // Test unauthenticated tier (budget 100)
      const app1 = await createMockApp();
      const res1 = await request(app1)
        .post("/graphql")
        .send({ query: complexQuery });

      // Test 'pro' tier (budget 2000)
      const express = await import("express");
      const app2 = express.default();
      app2.use(express.default.json());
      app2.use((req, res, next) => {
        req.rateContext = { tier: "pro" };
        next();
      });
      app2.use(graphqlComplexityLimiter);
      app2.post("/graphql", (req, res) => res.json({ data: { success: true } }));

      const res2 = await request(app2)
        .post("/graphql")
        .send({ query: complexQuery });

      // Unauthenticated should reject (small budget)
      expect(res1.status).toBe(400);
      expect(res1.body.limit).toBe(100);

      // Pro tier should accept (larger budget)
      expect(res2.status).toBe(200);
    });
  });

  describe("Response Headers", () => {
    it("sets X-GraphQL-Cost header indicating actual query cost", async () => {
      const query = `{ events { data { seq } } }`;
      const res = await request(app).post("/graphql").send({ query });

      expect(res.headers["x-graphql-cost"]).toBeDefined();
      const cost = parseInt(res.headers["x-graphql-cost"]);
      expect(cost).toBeGreaterThan(0);
    });

    it("sets X-GraphQL-Cost-Remaining header indicating remaining budget", async () => {
      const query = `{ events { data { seq } } }`;
      const res = await request(app).post("/graphql").send({ query });

      expect(res.headers["x-graphql-cost-remaining"]).toBeDefined();
      const cost = parseInt(res.headers["x-graphql-cost"]);
      const remaining = parseInt(res.headers["x-graphql-cost-remaining"]);
      const budget = TIER_COMPLEXITY_BUDGETS.unauthenticated;

      expect(remaining).toBe(Math.max(0, budget - cost));
    });
  });

  describe("Edge Cases", () => {
    it("passes through requests with no query body", async () => {
      const res = await request(app).post("/graphql").send({});

      // Should pass through without rejection
      expect(res.status).toBe(200);
    });

    it("gracefully handles malformed queries (parse errors)", async () => {
      const malformedQuery = `{ invalid syntax here }`;
      const res = await request(app)
        .post("/graphql")
        .send({ query: malformedQuery });

      // Should pass through gracefully on parse errors
      expect(res.status).toBe(200);
    });

    it("ignores requests to non-GraphQL endpoints", async () => {
      const express = await import("express");
      const app = express.default();
      app.use(express.default.json());
      app.use((req, res, next) => {
        req.rateContext = { tier: "unauthenticated" };
        next();
      });
      app.use(graphqlComplexityLimiter);
      app.post("/api/events", (req, res) => res.json({ success: true }));

      // A very expensive query, but not on /graphql path
      const res = await request(app)
        .post("/api/events")
        .send({ query: "{ very expensive query }" });

      // Should pass through (complexity limiter only applies to /graphql)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Fragment and Inline Fragment Handling", () => {
    it("accounts for fragment spreads in complexity calculation", async () => {
      // Fragment spreads are counted as cost 1 per spread
      const query = `
        fragment EventFields on Event {
          seq
          contract_id
          function
        }
        {
          events {
            data {
              ...EventFields
            }
          }
        }
      `;

      const res = await request(app).post("/graphql").send({ query });

      // Should calculate cost including fragment spread
      expect(res.status).toBe(200);
      expect(res.headers["x-graphql-cost"]).toBeDefined();
    });
  });
});
