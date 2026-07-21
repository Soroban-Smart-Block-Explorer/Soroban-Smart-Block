/**
 * GraphQL Security Tests
 *
 * Tests for query depth limiting, complexity limiting, and introspection security.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import express from "express";
import request from "supertest";
import { attachGraphQL } from "../src/graphql.js";
import config from "../src/config.js";
import { db } from "../src/db.js";

// Mock database responses
const mockDb = {
  getEventsCursor: () => ({
    data: [
      {
        seq: 1,
        contract_id: "CABC123",
        function: "transfer",
        ledger: 1000,
        tx_hash: "abc123",
        description: "Transfer 100 tokens",
        cpu_instructions: 1000000,
        mem_bytes: 512,
        fee_charged: 1000,
        is_high_bloat_risk: false,
        is_clawback: false,
      },
    ],
    next_cursor: 2,
  }),
  getEvent: (seq) => ({
    seq,
    contract_id: "CABC123",
    function: "transfer", 
    ledger: 1000,
    tx_hash: "abc123",
    description: "Transfer 100 tokens",
    cpu_instructions: 1000000,
    mem_bytes: 512,
    fee_charged: 1000,
    is_high_bloat_risk: false,
    is_clawback: false,
  }),
};

describe("GraphQL Security", () => {
  let app;
  let originalDb;
  let originalApiKey;
  let originalNodeEnv;

  beforeEach(() => {
    // Create fresh Express app for each test
    app = express();
    app.use(express.json());
    
    // Mock database
    originalDb = { ...db };
    Object.assign(db, mockDb);
    
    // Store original env vars
    originalApiKey = config.API_KEY;
    originalNodeEnv = process.env.NODE_ENV;
    
    attachGraphQL(app);
  });

  afterEach(() => {
    // Restore original database
    Object.assign(db, originalDb);
    
    // Restore original env vars
    config.API_KEY = originalApiKey;
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("Query Depth Limiting", () => {
    test("should reject query exceeding max depth (depth 5)", async () => {
      // This creates a depth-5 query: root -> events -> data -> field -> nested -> deep
      const deepQuery = `
        {
          events {
            data {
              field {
                nested {
                  deep
                }
              }
            }
          }
        }
      `;

      // Lower the depth limit temporarily to trigger the error
      const originalDepth = config.MAX_GRAPHQL_DEPTH;
      config.MAX_GRAPHQL_DEPTH = 4;

      const response = await request(app)
        .post("/graphql")
        .send({ query: deepQuery })
        .expect(400);

      // Restore original limit
      config.MAX_GRAPHQL_DEPTH = originalDepth;

      assert(response.body.errors);
      assert(response.body.errors[0].message.includes("Query depth"));
      assert(response.body.errors[0].message.includes("exceeds maximum 4"));
    });

    test("should allow query within depth limit (depth 3)", async () => {
      const validQuery = `
        {
          events {
            data {
              seq
              contract_id
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: validQuery })
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.events);
      assert.equal(response.body.data.events.next_cursor, 2);
      assert(Array.isArray(response.body.data.events.data));
    });
  });

  describe("Query Complexity Limiting", () => {
    test("should reject query with complexity exceeding 1000", async () => {
      // This query should have high complexity due to multiple list fields
      const complexQuery = `
        {
          events {
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
          }
        }
      `;

      // Temporarily lower the complexity limit to trigger the error
      const originalComplexity = config.MAX_GRAPHQL_COMPLEXITY;
      config.MAX_GRAPHQL_COMPLEXITY = 15;

      const response = await request(app)
        .post("/graphql")
        .send({ query: complexQuery })
        .expect(400);

      // Restore original limit
      config.MAX_GRAPHQL_COMPLEXITY = originalComplexity;

      assert(response.body.errors);
      assert(response.body.errors[0].message.includes("Query complexity"));
      assert(response.body.errors[0].message.includes("exceeds maximum 15"));
    });

    test("should allow query within complexity limit", async () => {
      const simpleQuery = `
        {
          events {
            seq
            contract_id
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: simpleQuery })
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.events);
    });
  });

  describe("Introspection Security", () => {
    test("should allow introspection in development", async () => {
      process.env.NODE_ENV = "development";
      
      const introspectionQuery = `
        {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: introspectionQuery })
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.__schema);
      assert.equal(response.body.data.__schema.queryType.name, "Query");
    });

    test("should block introspection in production without auth", async () => {
      process.env.NODE_ENV = "production";
      
      const introspectionQuery = `
        {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: introspectionQuery })
        .expect(400);

      assert(response.body.errors);
      assert(response.body.errors[0].message.includes("Introspection is disabled"));
    });

    test("should allow introspection in production with valid API key", async () => {
      process.env.NODE_ENV = "production";
      config.API_KEY = "test-api-key";
      
      const introspectionQuery = `
        {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: introspectionQuery })
        .set("X-API-Key", "test-api-key")
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.__schema);
    });

    test("should block introspection in production with invalid API key", async () => {
      process.env.NODE_ENV = "production";
      config.API_KEY = "correct-api-key";
      
      const introspectionQuery = `
        {
          __schema {
            queryType {
              name
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ query: introspectionQuery })
        .set("X-API-Key", "wrong-api-key")
        .expect(400);

      assert(response.body.errors);
      assert(response.body.errors[0].message.includes("Introspection is disabled"));
    });

    test("should allow introspection via GET with api key in query params", async () => {
      process.env.NODE_ENV = "production";
      config.API_KEY = "test-api-key";
      
      const introspectionQuery = `{ __schema { queryType { name } } }`;

      const response = await request(app)
        .get("/graphql")
        .query({ 
          query: introspectionQuery,
          apiKey: "test-api-key"
        })
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.__schema);
    });
  });

  describe("Edge Cases", () => {
    test("should handle missing query gracefully", async () => {
      const response = await request(app)
        .post("/graphql")
        .send({})
        .expect(400);

      assert(response.body.errors);
      assert(response.body.errors[0].message.includes("Missing query"));
    });

    test("should handle malformed GraphQL gracefully", async () => {
      const malformedQuery = "{ invalid syntax }";

      const response = await request(app)
        .post("/graphql")
        .send({ query: malformedQuery })
        .expect(400);

      assert(response.body.errors);
    });

    test("should handle GET requests without query", async () => {
      const response = await request(app)
        .get("/graphql")
        .expect(200);

      assert(response.body.info);
      assert(response.body.info.includes("POST a JSON body"));
    });

    test("should merge variables with inline arguments", async () => {
      const queryWithVariables = `
        {
          events(limit: 10) {
            data {
              seq
            }
          }
        }
      `;

      const response = await request(app)
        .post("/graphql")
        .send({ 
          query: queryWithVariables,
          variables: { limit: 5 }
        })
        .expect(200);

      assert(response.body.data);
      assert(response.body.data.events);
    });
  });
});

describe("Security Helper Functions", () => {
  test("calculateDepth should correctly measure nesting", async () => {
    const { calculateDepth } = await import("../src/graphql.js");
    
    const shallowParsed = { topFields: ["seq"], dataFields: null };
    assert.equal(calculateDepth(shallowParsed), 2);

    const deepParsed = { topFields: ["events"], dataFields: ["seq", "contract_id"] };
    assert.equal(calculateDepth(deepParsed), 3);
  });

  test("calculateComplexity should assign proper costs", async () => {
    const { calculateComplexity } = await import("../src/graphql.js");
    
    const simpleQuery = { topFields: ["seq"], dataFields: null };
    assert.equal(calculateComplexity(simpleQuery), 2); // 1 base + 1 field

    const listQuery = { topFields: ["events"], dataFields: null };
    assert.equal(calculateComplexity(listQuery), 11); // 1 base + 10 for list field
  });

  test("isListField should identify list-returning fields", async () => {
    const { isListField } = await import("../src/graphql.js");
    
    assert(isListField("events"));
    assert(isListField("data"));
    assert(isListField("items"));
    assert(!isListField("seq"));
    assert(!isListField("contract_id"));
  });
});
