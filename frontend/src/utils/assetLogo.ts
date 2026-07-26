/**
 * Asset logo helper — resolves a classic/SEP-41 asset's logo via the issuer's
 * SEP-1 stellar.toml (home_domain → CURRENCIES[].image). Best-effort only:
 * never throws, resolves to null when the issuer has no home_domain or the
 * stellar.toml has no matching entry.
 */
import { StellarToml } from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

// In-memory cache: "code:issuer" → logo URL (or null when none was found)
const cache = new Map<string, Promise<string | null>>();

async function fetchHomeDomain(issuer: string): Promise<string | null> {
  const res = await fetch(`${HORIZON_URL}/accounts/${issuer}`);
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data.home_domain === "string" ? data.home_domain : null;
}

export function resolveAssetLogo(code: string, issuer: string | null): Promise<string | null> {
  if (!issuer) return Promise.resolve(null);
  const key = `${code}:${issuer}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const domain = await fetchHomeDomain(issuer);
      if (!domain) return null;
      const toml = await StellarToml.Resolver.resolve(domain, { timeout: 4000 });
      const currency = toml.CURRENCIES?.find((c) => c.code === code && c.issuer === issuer);
      return currency?.image ?? null;
    } catch {
      return null;
    }
  })();

  cache.set(key, promise);
  return promise;
}
