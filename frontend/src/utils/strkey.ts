/**
 * strkey.ts — Stellar strkey address utilities for the frontend.
 *
 * Handles cross-chain interoperability
 *  - Detects G... (ed25519 account), M... (muxed account), C... (contract) addresses
 *  - Resolves M... muxed addresses to their base G... account for routing
 */
import { StrKey, decodeAddressToMuxedAccount } from "@stellar/stellar-sdk";

/** Returns true if the string looks like a Stellar G... account address. */
export function isAccountAddress(addr: string): boolean {
  return typeof addr === "string" && addr.startsWith("G") && addr.length === 56;
}

/** Returns true if the string looks like a Stellar M... muxed account address. */
export function isMuxedAddress(addr: string): boolean {
  return typeof addr === "string" && addr.startsWith("M") && addr.length >= 56;
}

/** Returns true if the string looks like a Stellar C... contract address. */
export function isContractAddress(addr: string): boolean {
  return typeof addr === "string" && addr.startsWith("C") && addr.length === 56;
}

/** Returns true if the string is a recognized Stellar address of any kind (G/M/C). */
export function isValidStellarAddress(addr: string): boolean {
  return isAccountAddress(addr) || isMuxedAddress(addr) || isContractAddress(addr);
}

/**
 * Returns the route target for a Stellar address:
 *  - G... → /wallet/:addr
 *  - M... → /wallet/:baseGAddress  (muxed resolved to base account)
 *  - C... → /contract/:addr
 *  - other → null (not linkable)
 */
export function addressRoute(addr: string): string | null {
  if (isAccountAddress(addr)) return `/wallet/${addr}`;
  if (isContractAddress(addr)) return `/contract/${addr}`;
  if (isMuxedAddress(addr)) {
    const base = resolveMuxed(addr);
    return base ? `/wallet/${base}` : null;
  }
  return null;
}

/**
 * Resolve a muxed M... address to its base G... account address.
 * Returns null if the input is not a valid muxed address.
 */
export function resolveMuxed(addr: string): string | null {
  if (!isMuxedAddress(addr)) return null;
  try {
    const muxed = decodeAddressToMuxedAccount(addr, true);
    return StrKey.encodeEd25519PublicKey(muxed.med25519().ed25519());
  } catch {
    return null;
  }
}

/**
 * Returns the numeric multiplexing ID embedded in a muxed M... address,
 * or null if the input is not a valid muxed address.
 */
export function muxedId(addr: string): string | null {
  if (!isMuxedAddress(addr)) return null;
  try {
    const muxed = decodeAddressToMuxedAccount(addr, true);
    return muxed.med25519().id().toString();
  } catch {
    return null;
  }
}

/**
 * Truncate a Stellar address for display: "GABCD…WXYZ"
 */
export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (typeof addr !== "string" || addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
