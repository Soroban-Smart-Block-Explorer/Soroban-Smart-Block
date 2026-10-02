/**
 * useWallet — unified wallet abstraction for multi-wallet support (#914).
 *
 * Wraps Freighter (the default) behind a common interface so the rest of the
 * app never imports Freighter directly.  Additional wallet adapters (xBull,
 * Albedo, Lobstr, WalletConnect, Ledger) can be plugged in later without
 * touching any consumer.
 *
 * The connected wallet choice is persisted to localStorage so it survives
 * page refreshes.
 */

import { useCallback, useEffect, useState } from "react";
import {
  isConnected,
  getAddress,
  getNetwork,
  requestAccess,
} from "@stellar/freighter-api";

// ── Types ──────────────────────────────────────────────────────────────────

export type WalletId = "freighter" | "xbull" | "albedo" | "lobstr";

export interface WalletAdapter {
  id: WalletId;
  name: string;
  /** True when the extension / app is present in the browser environment. */
  isAvailable(): Promise<boolean>;
  connect(): Promise<{ publicKey: string; network: string }>;
  disconnect(): void;
  /** Whether this adapter can sign Soroban auth entries (not just transactions). */
  canSignAuthEntries: boolean;
}

export interface WalletState {
  activeWallet: WalletId | null;
  connected: boolean;
  publicKey: string | null;
  network: string | null;
  connecting: boolean;
  /** True when the wallet's network doesn't match the explorer's configured network. */
  networkMismatch: boolean;
  error: string | null;
}

const STORAGE_KEY = "soroban_explorer_wallet";

// ── Freighter adapter ──────────────────────────────────────────────────────

function unwrap<T extends { error?: unknown }>(res: T): Omit<T, "error"> {
  if (res.error) {
    throw new Error(
      typeof res.error === "string" ? res.error : "Freighter request failed",
    );
  }
  return res;
}

const freighterAdapter: WalletAdapter = {
  id: "freighter",
  name: "Freighter",
  canSignAuthEntries: true,

  async isAvailable() {
    try {
      const { isConnected: ok } = unwrap(await isConnected());
      return ok;
    } catch {
      return false;
    }
  },

  async connect() {
    const { address } = unwrap(await requestAccess());
    const { network } = unwrap(await getNetwork());
    return { publicKey: address, network };
  },

  disconnect() {
    // Freighter has no programmatic disconnect; clear local state only.
  },
};

// ── Stub adapters for future wallets ──────────────────────────────────────
// These are wired but not yet fully implemented.  They report themselves as
// unavailable so the picker shows the correct "not installed" state.

function makeStubAdapter(id: WalletId, name: string): WalletAdapter {
  return {
    id,
    name,
    canSignAuthEntries: false,
    async isAvailable() {
      return false;
    },
    async connect() {
      throw new Error(`${name} wallet adapter is not yet implemented.`);
    },
    disconnect() {},
  };
}

const ADAPTERS: Record<WalletId, WalletAdapter> = {
  freighter: freighterAdapter,
  xbull: makeStubAdapter("xbull", "xBull"),
  albedo: makeStubAdapter("albedo", "Albedo"),
  lobstr: makeStubAdapter("lobstr", "Lobstr"),
};

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Returns wallet state and connect/disconnect helpers.
 *
 * Usage:
 *   const { connected, publicKey, connect, disconnect } = useWallet();
 */
export function useWallet(preferredWallet?: WalletId) {
  const [state, setState] = useState<WalletState>({
    activeWallet: null,
    connected: false,
    publicKey: null,
    network: null,
    connecting: false,
    networkMismatch: false,
    error: null,
  });

  // Restore previously connected wallet on mount.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const stored = (localStorage.getItem(STORAGE_KEY) as WalletId | null) ?? preferredWallet ?? "freighter";
      const adapter = ADAPTERS[stored] ?? ADAPTERS.freighter;
      try {
        const available = await adapter.isAvailable();
        if (!available || cancelled) return;
        // Check if access was already granted (getAddress succeeds without
        // requesting a popup).
        const addrRes = await getAddress();
        if (addrRes.error || !addrRes.address || cancelled) return;
        const { network } = unwrap(await getNetwork());
        setState({
          activeWallet: adapter.id,
          connected: true,
          publicKey: addrRes.address,
          network,
          connecting: false,
          networkMismatch: false,
          error: null,
        });
      } catch {
        // Silent — not yet connected.
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, [preferredWallet]);

  const connect = useCallback(async (walletId: WalletId = "freighter") => {
    const adapter = ADAPTERS[walletId] ?? ADAPTERS.freighter;
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const { publicKey, network } = await adapter.connect();
      localStorage.setItem(STORAGE_KEY, walletId);
      setState({
        activeWallet: walletId,
        connected: true,
        publicKey,
        network,
        connecting: false,
        networkMismatch: false,
        error: null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    if (state.activeWallet) {
      ADAPTERS[state.activeWallet]?.disconnect();
    }
    localStorage.removeItem(STORAGE_KEY);
    setState({
      activeWallet: null,
      connected: false,
      publicKey: null,
      network: null,
      connecting: false,
      networkMismatch: false,
      error: null,
    });
  }, [state.activeWallet]);

  /** Whether the active adapter can sign Soroban auth entries. */
  const canSignAuthEntries =
    state.activeWallet != null
      ? (ADAPTERS[state.activeWallet]?.canSignAuthEntries ?? false)
      : false;

  return { ...state, connect, disconnect, canSignAuthEntries, adapters: ADAPTERS };
}
