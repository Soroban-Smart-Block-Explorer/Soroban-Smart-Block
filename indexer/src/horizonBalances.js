/**
 * horizonBalances.js
 *
 * Fetches classic XLM + SEP-41/classic asset balances for a Stellar account
 * from the Horizon API and normalises them for the wallet balances endpoint.
 */
/* global fetch */
import config from "./config.js";
import { cacheAside } from "./cacheLayer.js";

const HORIZON_URL = config.HORIZON_URL.replace(/\/+$/, "");

/** Thrown when the account does not exist on the network (Horizon 404). */
export class AccountNotFoundError extends Error {}

function normalizeBalance(entry) {
  const is_native = entry.asset_type === "native";
  return {
    asset_code: is_native ? "XLM" : (entry.asset_code ?? null),
    asset_issuer: is_native ? null : (entry.asset_issuer ?? null),
    balance: entry.balance,
    is_native,
  };
}

/**
 * Fetch and normalise the balances array for a Stellar account, cached for
 * 30 seconds to avoid hammering Horizon.
 * @param {string} address G... account address
 * @returns {Promise<{asset_code: string, asset_issuer: string|null, balance: string, is_native: boolean}[]>}
 */
export async function fetchWalletBalances(address) {
  return cacheAside(
    `wallet:balances:${address}`,
    async () => {
      const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
      if (res.status === 404) {
        throw new AccountNotFoundError("Account not found on network");
      }
      if (!res.ok) {
        throw new Error(`Horizon request failed with status ${res.status}`);
      }
      const data = await res.json();
      return (data.balances ?? []).map(normalizeBalance);
    },
    "wallet_balances",
  );
}
