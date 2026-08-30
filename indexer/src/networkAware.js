/**
 * Network awareness middleware and helpers for the API layer
 *
 * Allows API clients to specify which network's data they're querying.
 * Default network is 'testnet' for backward compatibility.
 */

import { NETWORK_NAMES, getIndexerNetwork } from "./networkConfig.js";

/**
 * Express middleware to extract and validate network from request.
 * Looks for network in: query param (?network=...), header (X-Network),
 * or defaults to the indexer's NETWORK env var.
 */
export function networkParamMiddleware(req, res, next) {
  // Priority: query param > header > env-configured network
  const networkParam = req.query.network || req.headers["x-network"] || getIndexerNetwork();

  if (!NETWORK_NAMES.includes(networkParam)) {
    return res.status(400).json({
      error: `Invalid network: ${networkParam}. Must be one of: ${NETWORK_NAMES.join(", ")}`,
    });
  }

  req.network = networkParam;
  next();
}

/**
 * Add network scope to a database query constraint.
 * @param {string} network - network name
 * @param {string} tableAlias - SQL table alias/name (e.g., 'events', 'e')
 * @returns {string} SQL WHERE clause fragment (e.g., "events.network = 'testnet'")
 */
export function networkScope(network, tableAlias = null) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return `${prefix}network = '${network.replace(/'/g, "''")}'`;
}

/**
 * Add network parameter to query parameters array and return SQL fragment.
 * Use this for parameterized queries.
 * @param {string} network - network name
 * @param {Array} params - existing query parameters array
 * @param {string} tableAlias - SQL table alias/name
 * @returns {object} { sql, params } — SQL fragment and updated params array
 */
export function networkScopeParam(network, params = [], tableAlias = null) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const index = params.length + 1;
  return {
    sql: `${prefix}network = $${index}`,
    params: [...params, network],
  };
}

/**
 * Ensure an event/contract object belongs to the requested network.
 * @throws {Error} if network mismatch
 */
export function assertNetworkMatch(object, requestedNetwork, objectType = "object") {
  if (object.network && object.network !== requestedNetwork) {
    throw new Error(
      `Network mismatch: ${objectType} belongs to '${object.network}', not '${requestedNetwork}'`
    );
  }
}
