import type { SubscribeOptions, Subscription, WebSocketMessage } from "./types.js";

/**
 * Resolve a WebSocket constructor. Uses the native `WebSocket` in browsers
 * and falls back to the `ws` npm package in Node.js.
 */
function getWebSocketImpl(): typeof WebSocket {
  // Browser / Deno / Bun — native WebSocket
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket;
  }

  // Node.js >= 22 exposes a global WebSocket (undici-based)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).WebSocket !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).WebSocket;
  }

  // Node.js < 22 — try the `ws` peer dependency
  try {
    // Dynamic require so bundlers don't try to resolve it in browser builds
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ws = require("ws");
    return ws.default ?? ws;
  } catch {
    throw new Error(
      "No WebSocket implementation found. Install the `ws` package as a peer dependency " +
        "(`npm install ws`) or use a runtime with native WebSocket support (Node.js >= 22, browsers, Deno, Bun).",
    );
  }
}

/**
 * Subscribe to live Soroban explorer events via WebSocket with automatic reconnection.
 *
 * The WebSocket connection automatically reconnects on unexpected disconnects
 * using exponential backoff with jitter (1s → 2s → 4s → … capped at 30s).
 *
 * @param baseUrl - The base URL of the explorer API (http/https — will be converted to ws/wss).
 * @param options - Connection and reconnection options.
 * @param callback - Called for every incoming WebSocket message.
 * @returns A `Subscription` object with an `unsubscribe()` method to close the connection.
 *
 * @example
 * ```ts
 * import { subscribeEvents } from "@soroban-explorer/client";
 *
 * const sub = subscribeEvents(
 *   "https://explorer-api.example.com",
 *   { apiKey: "my-key", onReconnect: () => console.log("reconnected") },
 *   (msg) => console.log(msg),
 * );
 *
 * // Later…
 * sub.unsubscribe();
 * ```
 */
export function subscribeEvents(
  baseUrl: string,
  options: SubscribeOptions = {},
  callback: (message: WebSocketMessage) => void,
): Subscription {
  const {
    apiKey,
    maxReconnectAttempts = Infinity,
    reconnectDelay = 1000,
    maxReconnectDelay = 30_000,
    onReconnect,
    onDisconnect,
    onError,
  } = options;

  const WS = getWebSocketImpl();

  // Convert http(s) to ws(s)
  const wsUrl = baseUrl.replace(/^http/, "ws");
  const fullUrl = apiKey ? `${wsUrl}?api_key=${encodeURIComponent(apiKey)}` : wsUrl;

  let ws: WebSocket | null = null;
  let attempt = 0;
  let intentionallyClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    ws = new WS(fullUrl);

    ws.onopen = () => {
      // Reset backoff on successful connection
      if (attempt > 0) {
        onReconnect?.();
      }
      attempt = 0;
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data =
          typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(data) as WebSocketMessage;
        callback(parsed);
      } catch {
        // Silently ignore unparseable messages
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (intentionallyClosed) return;

      onDisconnect?.(event);
      scheduleReconnect();
    };

    ws.onerror = (event: Event) => {
      onError?.(event);
    };
  }

  function scheduleReconnect() {
    if (intentionallyClosed) return;
    if (attempt >= maxReconnectAttempts) return;

    attempt++;

    // Exponential backoff: delay * 2^(attempt-1), capped at maxReconnectDelay
    const baseDelay = Math.min(reconnectDelay * Math.pow(2, attempt - 1), maxReconnectDelay);
    // Add random jitter ±25% to avoid thundering herd
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(baseDelay + jitter));

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function unsubscribe() {
    intentionallyClosed = true;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      ws = null;
    }
  }

  // Initial connection
  connect();

  return { unsubscribe };
}
