/**
 * heuristicParser.js
 *
 * Guesses parameter types from raw ScVal-converted strings when no ABI is
 * available.  Returns an array of guess-tagged objects suitable for storage
 * and display in the frontend.
 *
 * Each item:  { index, raw, type, value, confidence }
 *   type       — "Address" | "ContractId" | "Amount" | "Hash" | "Symbol" | "Boolean" | "Unknown"
 *   confidence — "likely" | "possible"
 */

// Stellar account address: G + 55 base32 chars (total 56)
const RE_ACCOUNT = /^G[A-Z2-7]{55}$/;
// Stellar contract address: C + 55 base32 chars
const RE_CONTRACT = /^C[A-Z2-7]{55}$/;
// Transaction/WASM hash: 64 hex chars
const RE_HASH = /^[0-9a-f]{64}$/i;
// Symbol / token ticker: 1–12 uppercase letters/digits
const RE_SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/;

/**
 * Guess the type of a single raw value (string, number, bigint, boolean, etc.)
 *
 * @param {*} raw  A value already converted by scValToNative / scValToJs
 * @returns {{ type: string, value: string, confidence: string }}
 */
export function guessType(raw) {
  const s = String(raw);

  if (typeof raw === "boolean") {
    return { type: "Boolean", value: s, confidence: "likely" };
  }

  if (RE_ACCOUNT.test(s)) {
    return { type: "Address", value: s, confidence: "likely" };
  }

  if (RE_CONTRACT.test(s)) {
    return { type: "ContractId", value: s, confidence: "likely" };
  }

  if (RE_HASH.test(s)) {
    return { type: "Hash", value: s, confidence: "likely" };
  }

  // Numeric: could be an amount (i128/u128 from SAC)
  if (typeof raw === "bigint" || (typeof raw === "number" && !isNaN(raw))) {
    return { type: "Amount", value: s, confidence: "possible" };
  }

  // Short all-caps strings look like token symbols
  if (RE_SYMBOL.test(s) && s.length >= 2) {
    return { type: "Symbol", value: s, confidence: "possible" };
  }

  return { type: "Unknown", value: s, confidence: "possible" };
}

/**
 * Parse an array of already-native params (topics[1..] + data) into an array
 * of guess-tagged entries.
 *
 * @param {Array} params  Values already decoded by scValToNative / scValToJs
 * @returns {Array<{ index: number, raw: string, type: string, value: string, confidence: string }>}
 */
export function parseHeuristic(params) {
  return params.map((p, i) => ({
    index: i + 1,
    raw: String(p),
    ...guessType(p),
  }));
}

/**
 * Generate a human-readable fallback description for an event using heuristics.
 * Always returns a non-empty string — never null, undefined, or ''.
 *
 * Intended as the last-resort fallback in the decoder when no ABI is registered
 * and no known SAC/vault pattern matches.
 *
 * @param {object} ev  Event object with function, raw_topics, and raw_data fields
 * @returns {string}  Non-empty description string
 */
export function heuristicParser(ev) {
  const fn = String(ev?.function ?? ev?.fn ?? "") || "unknown";
  const rawTopics = Array.isArray(ev?.raw_topics) ? ev.raw_topics : [];
  // Skip index 0 — that slot holds the function-name topic itself
  const params = rawTopics.slice(1);
  const heuristic = parseHeuristic(params);

  if (!heuristic.length) {
    return `${fn}() [heuristic]`;
  }

  const paramStr = heuristic.map((p) => p.value).join(", ");
  return `${fn}(${paramStr}) [heuristic]`;
}
