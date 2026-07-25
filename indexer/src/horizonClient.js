/**
 * Horizon client for resolving classic Stellar asset metadata.
 *
 * Looks up an asset issuer's home_domain via Horizon, fetches that domain's
 * stellar.toml, and extracts the [[CURRENCIES]] entry matching the asset's
 * code (and issuer, when the TOML lists one) to get a display name and logo.
 */
const HORIZON_URL = (process.env.HORIZON_URL || "https://horizon-testnet.stellar.org").replace(/\/$/, "");

// In-memory caches — asset/TOML metadata changes rarely, so a process-lifetime
// cache avoids re-fetching the same domain/account on every decoded event.
const homeDomainCache = new Map(); // issuer -> Promise<string|null>
const tomlCache = new Map(); // domain -> Promise<CurrencyEntry[]>
const assetCache = new Map(); // "code:issuer" -> Promise<{name, logo_url, domain} | null>

/**
 * Look up the home_domain set on a Horizon account.
 * @param {string} issuer  Strkey account ID (G...)
 * @returns {Promise<string|null>}
 */
async function fetchHomeDomain(issuer) {
  if (homeDomainCache.has(issuer)) return homeDomainCache.get(issuer);

  const promise = (async () => {
    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${issuer}`);
      if (!res.ok) return null;
      const account = await res.json();
      return account.home_domain ?? null;
    } catch {
      return null;
    }
  })();

  homeDomainCache.set(issuer, promise);
  return promise;
}

/**
 * Parse `[[CURRENCIES]]` array-of-tables entries out of a stellar.toml body.
 * Only the handful of string fields the explorer cares about are extracted —
 * this intentionally isn't a general TOML parser.
 * @param {string} text  Raw stellar.toml contents
 * @returns {Array<{ code: string, issuer: string|null, name: string|null, image: string|null }>}
 */
function parseCurrencies(text) {
  const currencies = [];
  const blocks = text.split(/\[\[CURRENCIES\]\]/).slice(1);

  for (const block of blocks) {
    // A block runs until the next table/array-of-tables header (or EOF).
    const end = block.search(/\n\s*\[/);
    const body = end === -1 ? block : block.slice(0, end);

    const entry = {};
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_]+)\s*=\s*"([^"]*)"/);
      if (match) entry[match[1]] = match[2];
    }

    if (entry.code) {
      currencies.push({
        code: entry.code,
        issuer: entry.issuer ?? null,
        name: entry.name ?? null,
        image: entry.image ?? null,
      });
    }
  }

  return currencies;
}

/**
 * Fetch and parse `https://{domain}/.well-known/stellar.toml`, returning its
 * `[[CURRENCIES]]` entries. Returns an empty array when the domain has no
 * TOML file or it fails to parse.
 * @param {string} domain
 * @returns {Promise<Array<{ code: string, issuer: string|null, name: string|null, image: string|null }>>}
 */
export async function resolveToml(domain) {
  if (!domain) return [];
  if (tomlCache.has(domain)) return tomlCache.get(domain);

  const promise = (async () => {
    try {
      const res = await fetch(`https://${domain}/.well-known/stellar.toml`);
      if (!res.ok) return [];
      const text = await res.text();
      return parseCurrencies(text);
    } catch {
      return [];
    }
  })();

  tomlCache.set(domain, promise);
  return promise;
}

/**
 * Resolve a classic asset's display name and logo URL via its issuer's
 * stellar.toml. Returns null when the issuer has no home_domain, the TOML
 * is unreachable, or it lists no matching CURRENCIES entry — callers should
 * fall back to the bare asset code and a placeholder icon in that case.
 * @param {string} code    Asset code, e.g. "USDC"
 * @param {string} issuer  Strkey account ID of the asset issuer
 * @returns {Promise<{ name: string|null, logo_url: string|null, domain: string } | null>}
 */
export async function resolveAsset(code, issuer) {
  if (!code || !issuer) return null;
  const key = `${code}:${issuer}`;
  if (assetCache.has(key)) return assetCache.get(key);

  const promise = (async () => {
    const domain = await fetchHomeDomain(issuer);
    if (!domain) return null;

    const currencies = await resolveToml(domain);
    const match = currencies.find((c) => c.code === code && (!c.issuer || c.issuer === issuer));
    if (!match) return null;

    return { name: match.name ?? null, logo_url: match.image ?? null, domain };
  })();

  assetCache.set(key, promise);
  return promise;
}

/** Clears all in-memory caches — for tests only. */
export function _clearCache() {
  homeDomainCache.clear();
  tomlCache.clear();
  assetCache.clear();
}
