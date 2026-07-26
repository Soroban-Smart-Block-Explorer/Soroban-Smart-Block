/**
 * Horizon API client — classic Stellar asset resolution.
 *
 * Wraps @stellar/stellar-sdk's Horizon server to resolve classic (non-Soroban)
 * asset metadata by issuer + code. Results are cached for 24h since asset
 * metadata (code, issuer, decimals) rarely changes once an asset is issued.
 */
import { Horizon } from "@stellar/stellar-sdk";
import config from "./config.js";
import { cacheAside } from "./cacheLayer.js";

// Classic Stellar assets always use 7 decimal places (1 unit = 10,000,000 stroops),
// matching the fixed-point precision used across this codebase for SAC/token
// amounts (see db.js get24hVolume, vaults.decimals default).
const CLASSIC_ASSET_DECIMALS = 7;

let _server = null;
function getServer() {
  if (!_server) {
    _server = new Horizon.Server(config.HORIZON_URL, {
      allowHttp: config.HORIZON_URL.startsWith("http://"),
    });
  }
  return _server;
}

/** Extract the home domain from a Horizon asset record's stellar.toml link, if set. */
function extractDomain(tomlHref) {
  if (!tomlHref) return null;
  try {
    return new URL(tomlHref).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Resolve classic asset metadata from Horizon, cached for 24h.
 * @param {string} issuer  Stellar account ID (G...) that issued the asset
 * @param {string} code    Asset code (e.g. "USDC")
 * @returns {Promise<{ name: string, code: string, issuer: string, decimals: number, domain: string|null } | null>}
 *   null when the issuer has never issued this asset code.
 */
export async function resolveAsset(issuer, code) {
  if (!issuer || !code) return null;

  const cacheKey = `horizon:asset:${issuer}:${code}`;
  return cacheAside(
    cacheKey,
    async () => {
      const page = await getServer().assets().forCode(code).forIssuer(issuer).call();
      const record = page.records?.[0];
      if (!record) return null;

      return {
        // Horizon's asset listing has no curated display name — the asset
        // code is the best identifier available without a SEP-1 TOML lookup.
        name: record.asset_code,
        code: record.asset_code,
        issuer: record.asset_issuer,
        decimals: CLASSIC_ASSET_DECIMALS,
        domain: extractDomain(record._links?.toml?.href),
      };
    },
    "asset_metadata",
  );
}
