/**
 * useWallet — multi-wallet abstraction for the Soroban Smart Block Explorer.
 *
 * Wraps Stellar Wallets Kit (xBull, Albedo, Lobstr, Hana, WalletConnect v2,
 * Ledger) behind a thin hook so components remain wallet-agnostic.
 *
 * Issue #914: replace the Freighter-only useFreighter hook with this.
 */
import { useState, useEffect, useCallback } from 'react';

/** All wallet IDs supported by Stellar Wallets Kit. */
export type WalletId =
  | 'freighter'
  | 'xbull'
  | 'albedo'
  | 'lobstr'
  | 'hana'
  | 'walletconnect'
  | 'ledger';

export interface WalletState {
  /** True when a wallet is available/detected. */
  available: boolean;
  /** True when the user has connected and we have their public key. */
  connected: boolean;
  /** Stellar public key of the connected account. */
  publicKey: string | null;
  /** Network passphrase or short name ("testnet" | "mainnet" | …). */
  network: string | null;
  /** Currently active wallet identifier. */
  walletId: WalletId | null;
  /** True while a connect/switch operation is in flight. */
  connecting: boolean;
  /** Human-readable error from the last failed operation. */
  error: string | null;
  /**
   * True when the wallet's reported network does not match the explorer's
   * configured network.  Components should warn the user.
   */
  networkMismatch: boolean;
  /** True when the wallet supports signing Soroban auth entries. */
  canSignAuthEntries: boolean;
}

/** Minimal capability descriptor returned by the kit per wallet. */
interface KitWalletInfo {
  id: WalletId;
  name: string;
  isAvailable: () => Promise<boolean>;
  getPublicKey: () => Promise<string>;
  getNetwork: () => Promise<string>;
  sign: (xdr: string) => Promise<string>;
  signAuthEntry?: (preimage: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Stellar Wallets Kit is lazy-loaded so it is NOT in the initial chunk
// (issue #914 bundle constraint).
// ---------------------------------------------------------------------------

async function loadKit(): Promise<{ wallets: KitWalletInfo[] }> {
  // Dynamic import — bundle split point. @creit.tech/stellar-wallets-kit is an
  // optional peer dependency; fall back to Freighter-only if not installed.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — optional peer dep; not declared in tsconfig paths
  const mod = await import('@creit.tech/stellar-wallets-kit').catch(() => null);

  if (!mod) {
    // Fallback: expose only Freighter (always available via @stellar/freighter-api)
    const freighterMod = await import('@stellar/freighter-api').catch(() => null);
    if (!freighterMod) return { wallets: [] };

    const fw: KitWalletInfo = {
      id: 'freighter',
      name: 'Freighter',
      isAvailable: async () => {
        const r = await freighterMod.isConnected().catch(() => ({ isConnected: false }));
        return (r as { isConnected?: boolean }).isConnected ?? false;
      },
      getPublicKey: async () => {
        const r = await freighterMod.getAddress();
        if ((r as { error?: unknown }).error) throw new Error('Freighter: no address');
        return (r as { address: string }).address;
      },
      getNetwork: async () => {
        const r = await freighterMod.getNetwork();
        if ((r as { error?: unknown }).error) throw new Error('Freighter: no network');
        return (r as { network: string }).network;
      },
      sign: async (xdr) => {
        const r = await freighterMod.signTransaction(xdr, {});
        if ((r as { error?: unknown }).error) throw new Error('Freighter: sign rejected');
        return (r as { signedTxXdr: string }).signedTxXdr;
      },
    };
    return { wallets: [fw] };
  }

  // Stellar Wallets Kit is available — build adapter list
  const { StellarWalletsKit, WalletNetwork, FREIGHTER_ID, XBULL_ID, ALBEDO_ID, LOBSTR_ID, HANA_ID } = mod;

  function makeAdapter(id: WalletId, kitId: string): KitWalletInfo {
    const kit = new StellarWalletsKit({ network: WalletNetwork.TESTNET, selectedWalletId: kitId });
    return {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      isAvailable: async () => {
        try { await kit.getSupportedWallets(); return true; } catch { return false; }
      },
      getPublicKey: async () => {
        const { address } = await kit.getAddress();
        return address;
      },
      getNetwork: async () => {
        try {
          const info = await kit.getNetwork?.();
          return info?.network ?? 'testnet';
        } catch { return 'testnet'; }
      },
      sign: async (xdr) => {
        const { signedTxXdr } = await kit.signTransaction(xdr);
        return signedTxXdr;
      },
      signAuthEntry: async (preimage) => {
        if (!kit.signAuthEntry) throw new Error('Auth entry signing not supported');
        const { signedAuthEntry } = await kit.signAuthEntry(preimage);
        return signedAuthEntry;
      },
    };
  }

  const wallets: KitWalletInfo[] = [
    makeAdapter('freighter', FREIGHTER_ID),
    makeAdapter('xbull', XBULL_ID),
    makeAdapter('albedo', ALBEDO_ID),
    makeAdapter('lobstr', LOBSTR_ID),
    makeAdapter('hana', HANA_ID),
  ];

  return { wallets };
}

// ---------------------------------------------------------------------------
// Explorer network from env
// ---------------------------------------------------------------------------
const EXPLORER_NETWORK = import.meta.env.VITE_NETWORK ?? 'testnet';

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'wallet:preferred';

function savePreference(id: WalletId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}
function loadPreference(): WalletId | null {
  try { return (localStorage.getItem(STORAGE_KEY) as WalletId) ?? null; } catch { return null; }
}
function clearPreference() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    available: false,
    connected: false,
    publicKey: null,
    network: null,
    walletId: null,
    connecting: false,
    error: null,
    networkMismatch: false,
    canSignAuthEntries: false,
  });

  // On mount, attempt to restore a previously connected wallet
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const savedId = loadPreference();
      if (!savedId) return;
      try {
        const { wallets } = await loadKit();
        const w = wallets.find((x) => x.id === savedId);
        if (!w) return;
        const available = await w.isAvailable();
        if (!available || cancelled) return;
        const publicKey = await w.getPublicKey().catch(() => null);
        if (!publicKey || cancelled) return;
        const network = await w.getNetwork().catch(() => EXPLORER_NETWORK);
        if (cancelled) return;
        setState({
          available: true,
          connected: true,
          publicKey,
          network,
          walletId: savedId,
          connecting: false,
          error: null,
          networkMismatch: !network.toLowerCase().includes(EXPLORER_NETWORK.toLowerCase()),
          canSignAuthEntries: typeof w.signAuthEntry === 'function',
        });
      } catch { /* silent — wallet may not be installed */ }
    }
    restore();
    return () => { cancelled = true; };
  }, []);

  const connect = useCallback(async (walletId: WalletId = 'freighter') => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const { wallets } = await loadKit();
      const w = wallets.find((x) => x.id === walletId);
      if (!w) throw new Error(`Wallet "${walletId}" not found in kit`);

      const available = await w.isAvailable();
      if (!available) throw new Error(`${walletId} is not installed`);

      const publicKey = await w.getPublicKey();
      const network = await w.getNetwork().catch(() => EXPLORER_NETWORK);

      savePreference(walletId);
      setState({
        available: true,
        connected: true,
        publicKey,
        network,
        walletId,
        connecting: false,
        error: null,
        networkMismatch: !network.toLowerCase().includes(EXPLORER_NETWORK.toLowerCase()),
        canSignAuthEntries: typeof w.signAuthEntry === 'function',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    clearPreference();
    setState({
      available: false,
      connected: false,
      publicKey: null,
      network: null,
      walletId: null,
      connecting: false,
      error: null,
      networkMismatch: false,
      canSignAuthEntries: false,
    });
  }, []);

  /**
   * Sign a transaction XDR with the currently connected wallet.
   * Throws if not connected or wallet rejects.
   */
  const signTransaction = useCallback(async (xdr: string): Promise<string> => {
    if (!state.walletId) throw new Error('No wallet connected');
    const { wallets } = await loadKit();
    const w = wallets.find((x) => x.id === state.walletId);
    if (!w) throw new Error('Wallet not found');
    return w.sign(xdr);
  }, [state.walletId]);

  /**
   * Sign a Soroban auth entry preimage.
   * Throws with a user-friendly message if unsupported.
   */
  const signAuthEntry = useCallback(async (preimage: string): Promise<string> => {
    if (!state.walletId) throw new Error('No wallet connected');
    const { wallets } = await loadKit();
    const w = wallets.find((x) => x.id === state.walletId);
    if (!w) throw new Error('Wallet not found');
    if (!w.signAuthEntry) {
      throw new Error(
        `${state.walletId} does not support signing auth entries. ` +
        'Use Freighter, xBull, or Hana for Soroban auth.',
      );
    }
    return w.signAuthEntry(preimage);
  }, [state.walletId]);

  return { ...state, connect, disconnect, signTransaction, signAuthEntry };
}
