import { logger } from "./logger.js";
/**
 * GraphQL Interface for Contract Events
 *
 * Mounts a /graphql endpoint on the Express app using a minimal hand-rolled
 * resolver so no heavy framework dependency is required.  The schema supports
 * flexible field selection and filtering by contractId, function name, ledger
 * range, and pagination — all backed by the existing `db.getEvents` layer.
 *
 * Security features:
 * - Query depth limiting to prevent excessive nesting
 * - Query complexity calculation and limiting
 * - Introspection blocking in production (unless authenticated)
 *
 * POST /graphql   { query: "{ events(contract: \"C…\") { seq ledger function } }" }
 */

import { db } from "./db.js";
import config from "./config.js";

// ── Schema definition (SDL) ───────────────────────────────────────────────────

export const typeDefs = `
  type Event {
    seq: Int
    contract_id: String
    function: String
    function_name: String
    ledger: Int
    ledger_sequence: Int
    tx_hash: String
    description: String
    cpu_instructions: Int
    mem_bytes: Int
    fee_charged: Int
    is_high_bloat_risk: Boolean
    is_clawback: Boolean
  }

  type EventPage {
    data: [Event]
    next_cursor: Int
  }

  type Query {
    events(
      contract: String
      fn: String
      type: String
      after: Int
      limit: Int
    ): EventPage

    event(seq: Int!): Event
  }
`;

// ── Resolvers ─────────────────────────────────────────────────────────────────

const resolvers = {
  Query: {
    events: async (_root, args) => {
      return db.getEventsCursor({
        contract: args.contract || undefined,
        fn: args.fn || undefined,
        type: args.type || undefined,
        after_seq: args.after || 0,
        limit: args.limit ? Math.min(args.limit, 200) : 25,
      });
    },
    event: async (_root, args) => {
      return db.getEvent(args.seq);
    },
  },
  // Field aliases so introspection and queries using the canonical names work.
  // The DB columns are `function` and `ledger`; these expose them under the
  // names required by the issue acceptance criteria.
  Event: {
    function_name: (row) => row.function ?? null,
    ledger_sequence: (row) => row.ledger ?? null,
  },
};

// ── Minimal GraphQL execution (no external runtime needed) ────────────────────

// ── Security: Depth and Complexity Validation ────────────────────────────────

/**
 * Calculate the maximum nesting depth in a parsed GraphQL query.
 * Used to prevent queries with excessive nesting that could cause DoS.
 * 
 * @param {object} parsed - Parsed GraphQL query
 * @returns {number} Maximum depth found
 */
function calculateDepth(parsed) {
  // If the parser calculated depth directly, use it
  if (parsed.maxDepth !== undefined) {
    return parsed.maxDepth;
  }
  
  // Fallback calculation for backwards compatibility
  let maxDepth = 1; // Start at 1 for the root query
  
  if (parsed.topFields && parsed.topFields.length > 0) {
    maxDepth = 2; // Top level fields are depth 2
  }
  
  if (parsed.dataFields && parsed.dataFields.length > 0) {
    maxDepth = 3; // data.* fields are depth 3
  }
  
  return maxDepth;
}

/**
 * Calculate query complexity based on field costs.
 * List-returning fields have higher cost to reflect their DB impact.
 * 
 * @param {object} parsed - Parsed GraphQL query
 * @returns {number} Total complexity cost
 */
function calculateComplexity(parsed) {
  let totalCost = 1; // Base cost for the query
  
  // Cost for top-level fields
  if (parsed.topFields) {
    for (const field of parsed.topFields) {
      if (isListField(field)) {
        totalCost += 10;
      } else {
        totalCost += 1;
      }
    }
  }
  
  // Cost for nested data fields
  if (parsed.dataFields) {
    for (const field of parsed.dataFields) {
      totalCost += 1; // Nested fields have base cost
    }
  }
  
  return totalCost;
}

/**
 * Check if a field name indicates a list-returning field.
 * Used for complexity calculation.
 * 
 * @param {string} fieldName
 * @returns {boolean}
 */
function isListField(fieldName) {
  const listFields = new Set([
    'events', 'data', 'nodes', 'edges', 'items', 'results',
    'records', 'entries', 'list', 'feed', 'page', 'collection'
  ]);
  
  if (listFields.has(fieldName.toLowerCase())) return true;
  
  // Heuristic: plural names (ending in 's') are usually list-returning
  return fieldName.length > 1 && fieldName.endsWith('s');
}

/**
 * Validate query security constraints (depth and complexity).
 * 
 * @param {object} parsed - Parsed GraphQL query
 * @returns {object|null} Error object if validation fails, null if valid
 */
function validateQuerySecurity(parsed) {
  // Check depth
  const depth = calculateDepth(parsed);
  if (depth > config.MAX_GRAPHQL_DEPTH) {
    return {
      message: `Query depth ${depth} exceeds maximum ${config.MAX_GRAPHQL_DEPTH}`
    };
  }
  
  // Check complexity
  const complexity = calculateComplexity(parsed);
  if (complexity > config.MAX_GRAPHQL_COMPLEXITY) {
    return {
      message: `Query complexity ${complexity} exceeds maximum ${config.MAX_GRAPHQL_COMPLEXITY}`
    };
  }
  
  return null;
}

/**
 * Check if the request is authenticated with a valid API key.
 * 
 * @param {object} req - Express request object
 * @returns {boolean} True if authenticated
 */
function isAuthenticated(req) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  return apiKey && apiKey === config.API_KEY;
}

/**
 * Check if introspection should be allowed for this request.
 * 
 * @param {object} req - Express request object
 * @returns {boolean} True if introspection is allowed
 */
function isIntrospectionAllowed(req) {
  // Always allow in development
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  
  // In production, require authentication
  return isAuthenticated(req);
}

/**
 * Parse a GraphQL query and extract structure for security analysis.
 * Supports nested field sets and calculates depth for security validation.
 */
function parseQuery(query) {
  // Strip comments
  const src = query.replace(/#[^\n]*/g, "").trim();

  // Find the operation: { operationName(...) { ... } }
  const mainMatch = src.match(/^\s*\{\s*(\w+)\s*(?:\(([^)]*)\))?\s*\{(.*)$/s);
  if (!mainMatch) throw new Error("Cannot parse GraphQL query");

  const [, opName, rawArgs = "", rawFields] = mainMatch;

  // Parse args: key: "value" or key: 123
  const args = {};
  for (const m of rawArgs.matchAll(/(\w+)\s*:\s*(?:"([^"]*)"|([\d]+))/g)) {
    args[m[1]] = m[3] !== undefined ? Number(m[3]) : m[2];
  }

  // Parse fields and calculate structure for security analysis
  const { topFields, dataFields, maxDepth } = parseFieldsWithDepth(rawFields);

  return { opName, args, topFields, dataFields, maxDepth };
}

/**
 * Parse GraphQL fields and calculate nesting depth.
 * Handles nested field structures for security analysis.
 */
function parseFieldsWithDepth(fieldsText) {
  // Remove trailing closing braces and clean up
  let cleaned = fieldsText.replace(/\s*\}\s*$/, '').trim();
  
  const topFields = [];
  let dataFields = null;
  
  // Calculate depth by counting the maximum brace nesting
  const maxDepth = calculateMaxBraceDepth(cleaned) + 1; // +1 for the operation level
  
  // Extract top-level field names (simple approach)
  const fieldMatches = cleaned.match(/^\s*(\w+)/gm) || [];
  topFields.push(...fieldMatches.map(m => m.trim()));
  
  // Special handling for 'data' field if present
  const dataMatch = cleaned.match(/data\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/s);
  if (dataMatch) {
    const dataContent = dataMatch[1];
    dataFields = extractSimpleFields(dataContent);
  }
  
  return { topFields, dataFields, maxDepth };
}

/**
 * Calculate the maximum brace nesting depth in a string.
 */
function calculateMaxBraceDepth(text) {
  let maxDepth = 0;
  let currentDepth = 0;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (text[i] === '}') {
      currentDepth--;
    }
  }
  
  return maxDepth;
}

/**
 * Analyze nested structure and calculate its depth.
 */
function analyzeNestedStructure(text, startPos) {
  let braceCount = 0;
  let pos = startPos;
  let maxDepth = 0;
  let contentStart = -1;
  let contentEnd = -1;
  
  while (pos < text.length) {
    if (text[pos] === '{') {
      braceCount++;
      maxDepth = Math.max(maxDepth, braceCount);
      if (braceCount === 1) {
        contentStart = pos + 1;
      }
    } else if (text[pos] === '}') {
      if (braceCount === 1) {
        contentEnd = pos;
      }
      braceCount--;
      if (braceCount === 0) {
        break;
      }
    }
    pos++;
  }
  
  const content = (contentStart > -1 && contentEnd > -1) 
    ? text.slice(contentStart, contentEnd).trim() 
    : null;
  
  return {
    depth: maxDepth, // This is the number of nested braces
    content,
    endPos: pos + 1
  };
}

/**
 * Extract simple field names from content (no nested analysis).
 */
function extractSimpleFields(content) {
  if (!content) return [];
  
  // For simple cases, just extract word tokens that could be field names
  const fields = [];
  const words = content.match(/\w+/g) || [];
  
  // Filter out obvious non-field tokens
  for (const word of words) {
    // Skip if it looks like it might be part of a nested structure we can't handle
    if (word.length > 0 && !['true', 'false', 'null'].includes(word.toLowerCase())) {
      fields.push(word);
    }
  }
  
  return fields.slice(0, 10); // Limit to prevent abuse
}

/**
 * Apply Event-level field resolvers to a raw DB row so alias fields
 * (function_name, ledger_sequence) are present before projection.
 */
function resolveEventFields(row) {
  if (!row) return row;
  return {
    ...row,
    function_name: resolvers.Event.function_name(row),
    ledger_sequence: resolvers.Event.ledger_sequence(row),
  };
}

/**
 * Project an object to only the requested fields.
 */
function project(obj, fields) {
  if (!obj || !fields) return obj;
  const out = {};
  for (const f of fields) out[f] = obj[f] ?? null;
  return out;
}

/**
 * Execute a parsed query against the resolvers.
 */
async function execute(parsed) {
  const resolver = resolvers.Query[parsed.opName];
  if (!resolver) throw new Error(`Unknown query: ${parsed.opName}`);

  const result = await resolver(null, parsed.args);

  // Shape result to match requested fields
  if (parsed.opName === "events") {
    const page = result;
    const out = {};
    if (!parsed.topFields || parsed.topFields.includes("next_cursor")) {
      out.next_cursor = page.next_cursor;
    }
    if (!parsed.topFields || parsed.topFields.some((f) => f === "data" || parsed.dataFields)) {
      out.data = (page.data || []).map((ev) => {
        const resolved = resolveEventFields(ev);
        return parsed.dataFields ? project(resolved, parsed.dataFields) : resolved;
      });
    }
    return out;
  }

  // Single event
  const resolved = resolveEventFields(result);
  if (parsed.dataFields) return project(resolved, parsed.dataFields);
  if (parsed.topFields) return project(resolved, parsed.topFields);
  return resolved;
}

// ── Introspection ─────────────────────────────────────────────────────────────

/**
 * Build a minimal introspection response covering the Event type and Query
 * type so that clients can verify the schema without a full graphql-js runtime.
 */
function buildIntrospectionResponse() {
  const eventFields = [
    { name: "seq", type: { name: "Int", kind: "SCALAR" } },
    { name: "contract_id", type: { name: "String", kind: "SCALAR" } },
    { name: "function", type: { name: "String", kind: "SCALAR" } },
    { name: "function_name", type: { name: "String", kind: "SCALAR" } },
    { name: "ledger", type: { name: "Int", kind: "SCALAR" } },
    { name: "ledger_sequence", type: { name: "Int", kind: "SCALAR" } },
    { name: "tx_hash", type: { name: "String", kind: "SCALAR" } },
    { name: "description", type: { name: "String", kind: "SCALAR" } },
    { name: "cpu_instructions", type: { name: "Int", kind: "SCALAR" } },
    { name: "mem_bytes", type: { name: "Int", kind: "SCALAR" } },
    { name: "fee_charged", type: { name: "Int", kind: "SCALAR" } },
    { name: "is_high_bloat_risk", type: { name: "Boolean", kind: "SCALAR" } },
    { name: "is_clawback", type: { name: "Boolean", kind: "SCALAR" } },
  ];

  return {
    __schema: {
      queryType: { name: "Query" },
      types: [
        {
          kind: "OBJECT",
          name: "Event",
          fields: eventFields,
        },
        {
          kind: "OBJECT",
          name: "EventPage",
          fields: [
            { name: "data", type: { name: "Event", kind: "OBJECT" } },
            { name: "next_cursor", type: { name: "Int", kind: "SCALAR" } },
          ],
        },
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            { name: "events", type: { name: "EventPage", kind: "OBJECT" } },
            { name: "event", type: { name: "Event", kind: "OBJECT" } },
          ],
        },
      ],
    },
  };
}

/**
 * Returns true when the query body is a GraphQL introspection request.
 */
function isIntrospectionQuery(query) {
  return typeof query === "string" && query.includes("__schema");
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Attach the /graphql endpoint to an Express app.
 * @param {import('express').Application} app
 */
export function attachGraphQL(app) {
  // POST /graphql — standard GraphQL over HTTP
  app.post("/graphql", async (req, res) => {
    const { query, variables } = req.body;
    if (!query) return res.status(400).json({ errors: [{ message: "Missing query" }] });

    // Handle introspection queries with security check
    if (isIntrospectionQuery(query)) {
      if (!isIntrospectionAllowed(req)) {
        return res.status(400).json({ 
          errors: [{ message: "Introspection is disabled in production. Please authenticate." }] 
        });
      }
      return res.json({ data: buildIntrospectionResponse() });
    }

    try {
      const parsed = parseQuery(query);
      
      // Security validation
      const securityError = validateQuerySecurity(parsed);
      if (securityError) {
        return res.status(400).json({ errors: [securityError] });
      }
      
      // Merge inline args with variables (variables take precedence)
      if (variables) Object.assign(parsed.args, variables);
      const data = await execute(parsed);
      res.json({ data });
    } catch (err) {
      res.status(400).json({ errors: [{ message: err.message }] });
    }
  });

  // GET /graphql?query=… — convenience for browser testing
  app.get("/graphql", async (req, res) => {
    const query = req.query.query;
    if (!query) {
      return res.json({
        info: "POST a JSON body with { query } to use GraphQL",
      });
    }
    
    if (isIntrospectionQuery(String(query))) {
      if (!isIntrospectionAllowed(req)) {
        return res.status(400).json({ 
          errors: [{ message: "Introspection is disabled in production. Please authenticate." }] 
        });
      }
      return res.json({ data: buildIntrospectionResponse() });
    }
    
    try {
      const parsed = parseQuery(String(query));
      
      // Security validation
      const securityError = validateQuerySecurity(parsed);
      if (securityError) {
        return res.status(400).json({ errors: [securityError] });
      }
      
      const data = await execute(parsed);
      res.json({ data });
    } catch (err) {
      res.status(400).json({ errors: [{ message: err.message }] });
    }
  });

  logger.info("[graphql] Endpoint mounted at /graphql with security limits:");
  logger.info(`[graphql]   Max depth: ${config.MAX_GRAPHQL_DEPTH}`);
  logger.info(`[graphql]   Max complexity: ${config.MAX_GRAPHQL_COMPLEXITY}`);
  logger.info(`[graphql]   Introspection: ${process.env.NODE_ENV !== 'production' ? 'enabled' : 'auth required'}`);
}

// Export helper functions for testing
export {
  parseQuery,
  calculateDepth,
  calculateComplexity,
  isListField,
  validateQuerySecurity,
  isAuthenticated,
  isIntrospectionAllowed
};
