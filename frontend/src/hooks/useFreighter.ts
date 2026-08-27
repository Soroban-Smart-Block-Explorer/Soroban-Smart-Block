import { useState, useEffect, useCallback } from 'react';
import {
  isConnected,
  getPublicKey,
  getNetwork,
} from '@stellar/freighter-api';

export interface FreighterState {
  available: boolean;
  connected: boolean;
  publicKey: string | null;
  network: string | null;
  connecting: boolean;
  error: string | null;
}

export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    available: false,
    connected: false,
    publicKey: null,
    network: null,
    connecting: false,
    error: null,
  });

  useEffect(() => {
    async function check() {
      try {
        const connected = await isConnected();
        if (connected) {
          const publicKey = await getPublicKey();
          const network = await getNetwork();
          setState({ available: true, connected: true, publicKey, network, connecting: false, error: null });
        } else {
          setState((s) => ({ ...s, available: true, connected: false, publicKey: null }));
        }
      } catch {
        setState((s) => ({ ...s, available: false }));
      }
    }
    check();
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const publicKey = await getPublicKey();
      const network = await getNetwork();
      setState({ available: true, connected: true, publicKey, network, connecting: false, error: null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState((s) => ({ ...s, connected: false, publicKey: null, network: null, error: null }));
  }, []);

  return { ...state, connect, disconnect };
}
