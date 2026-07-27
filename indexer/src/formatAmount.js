/**
 * Format a raw token amount (BigInt, string, or number) into a human-readable
 * decimal string using integer arithmetic — no IEEE 754 rounding.
 *
 * Overloads:
 *   formatAmount(raw, decimals)       — numeric decimals, returns plain decimal string
 *   formatAmount(raw, symbol)         — asset symbol string, appends symbol suffix
 *   formatAmount(raw, symbol, decimals) — explicit decimals + symbol suffix
 *
 * Classic Stellar (XLM) and SEP-41 assets store amounts in stroops
 * (1 XLM = 10,000,000 stroops, i.e. 7 decimal places). Pass the asset
 * symbol as the second argument to get a formatted "1.0 XLM" style string.
 * Soroban i128 amounts use the same 7-decimal convention by default.
 *
 * Examples:
 *   formatAmount(15000000, 7)          → "1.5"
 *   formatAmount(10000000, "XLM")      → "1.0 XLM"
 *   formatAmount(500000000, "USDC")    → "50.0 USDC"
 *   formatAmount(1000300, 6)           → "1.0003"
 *   formatAmount(1000000, 6)           → "1"
 *   formatAmount(-500000, 6)           → "-0.5"
 *
 * @param {bigint|string|number} raw           Raw amount in the token's smallest unit
 * @param {number|string}        decimalsOrSymbol  Decimal places (number) OR asset symbol (string)
 * @param {number}               [decimals=7]  Explicit decimals when symbol is provided (default 7)
 * @returns {string} Decimal string, optionally suffixed with the asset symbol
 */
export function formatAmount(raw, decimalsOrSymbol = 7, decimals) {
  // Determine whether the caller passed a symbol string or a plain decimals number.
  let symbol = null;
  let scale;

  if (typeof decimalsOrSymbol === "string") {
    symbol = decimalsOrSymbol;
    // Use explicit decimals if provided, otherwise fall back to 7 (stroop standard).
    scale = typeof decimals === "number" ? decimals : 7;
  } else {
    scale = typeof decimalsOrSymbol === "number" ? decimalsOrSymbol : 7;
  }

  // Normalise: strip any decimal point that SQL NUMERIC may produce
  const rawBig = BigInt(String(raw).split(".")[0]);
  const divisor = 10n ** BigInt(scale);

  const neg = rawBig < 0n;
  const abs = neg ? -rawBig : rawBig;

  const whole = abs / divisor;
  const frac = abs % divisor;

  let fracStr = frac.toString().padStart(scale, "0").replace(/0+$/, "");

  // When a symbol is supplied (classic / SEP-41 asset), always keep at least
  // one fractional digit so "1.0 XLM" is preferred over "1 XLM".
  if (symbol !== null && fracStr.length === 0) {
    fracStr = "0";
  }

  const magnitude = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  const signed = neg ? `-${magnitude}` : magnitude;

  return symbol !== null ? `${signed} ${symbol}` : signed;
}
