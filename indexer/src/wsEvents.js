import { logger } from "./logger.js";
/**
 * Live Event Streaming via WebSockets
 *
 * Uses Node's built-in EventEmitter as the pub/sub bus (no Redis required).
 * The HTTP server is upgraded to handle WebSocket connections via the `ws`
 * package.  When the indexer stores a new event it calls `publish(event)` and
 * every connected client receives the payload within the same event-loop tick.
 *
 * Multi-network support: events are emitted to network-scoped channels.
 * Clients specify network via ?network=testnet query param (default: testnet).
 */

import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import url from "url";
import { NETWORK_NAMES, getIndexerNetwork } from "./networkConfig.js";

const API_KEY = process.env.API_KEY;
const bus = new EventEmitter();
bus.setMaxListeners(0);

const txStatusCache = new Map();

/**
 * Emit an event to network-specific channels.
 * Also emits to legacy "event" channel for backward compatibility.
 */
export function publish(event) {
  bus.emit("event", event);
  const network = event.network || getIndexerNetwork();
  bus.emit(`event:${network}`, event);
}

export function publishTransactionStatus(status) {
  const existing = txStatusCache.get(status.tx_hash);
  if (existing && existing.status === status.status && existing.ledger === status.ledger && existing.error === status.error) {
    return;
  }
  txStatusCache.set(status.tx_hash, status);
  bus.emit("transaction_status", status);
}

export function getTransactionStatus(txHash) {
  return txStatusCache.get(txHash) || null;
}

export function onTransactionStatus(listener) {
  bus.on("transaction_status", listener);
}

export function offTransactionStatus(listener) {
  bus.off("transaction_status", listener);
}

export function publishVaultRatio(snapshot) {
  bus.emit("vault_ratio", {
    contract_id: snapshot.contract_id,
    ratio: snapshot.ratio,
    total_assets: snapshot.total_assets,
    total_supply: snapshot.total_supply,
    ledger: snapshot.ledger,
  });
}

export function publishContractLink(link) {
  bus.emit("contract_link", link);
}

export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, cb) => {
      const params = new url.URL(info.req.url || "", "http://localhost").searchParams;
      const key = params.get("api_key");
      const network = params.get("network") || getIndexerNetwork();

      if (API_KEY && key !== API_KEY) {
        cb(false, 401, "Unauthorized");
        return;
      }

      if (!NETWORK_NAMES.includes(network)) {
        cb(false, 400, `Invalid network: ${network}`);
        return;
      }

      cb(true);
    },
  });

  wss.on("connection", (ws, _req) => {
    logger.info("[ws] Client connected");

    // Event batching: accumulate events by ledger, flush on a timer
    const BATCH_TIMEOUT_MS = 50;
    const pendingEventsByLedger = new Map(); // ledger -> array of events
    let flushTimeoutId = null;

    const flushBatch = () => {
      if (pendingEventsByLedger.size === 0) {
        flushTimeoutId = null;
        return;
      }

      if (ws.readyState === ws.OPEN) {
        // Collect all pending events in order by ledger sequence
        const allEvents = [];
        const ledgers = Array.from(pendingEventsByLedger.keys()).sort((a, b) => a - b);
        for (const ledger of ledgers) {
          allEvents.push(...pendingEventsByLedger.get(ledger));
        }
        ws.send(JSON.stringify({ type: "events_batch", data: allEvents }));
      }
      pendingEventsByLedger.clear();
      flushTimeoutId = null;
    };

    const handler = (event) => {
      if (ws.readyState !== ws.OPEN) return;

      const ledger = event.ledger;
      if (!pendingEventsByLedger.has(ledger)) {
        pendingEventsByLedger.set(ledger, []);
      }
      pendingEventsByLedger.get(ledger).push(event);

      // Schedule a flush if one isn't already pending
      if (flushTimeoutId === null) {
        flushTimeoutId = setTimeout(flushBatch, BATCH_TIMEOUT_MS);
      }
    };

    // Backward-compat handler for events without network field
    const legacyHandler = (event) => {
      if (!event.network && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "event", data: event }));
      }
    };

    const vaultHandler = (snapshot) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "vault_ratio", data: snapshot }));
      }
    };

    const linkHandler = (link) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "contract_link", data: link }));
      }
    };

    // Subscribe to network-specific and legacy channels
    bus.on(`event:${network}`, handler);
    bus.on("event", legacyHandler);
    bus.on("vault_ratio", vaultHandler);
    bus.on("contract_link", linkHandler);

    ws.on("close", () => {
      if (flushTimeoutId !== null) {
        clearTimeout(flushTimeoutId);
      }
      bus.off("event", handler);
      bus.off("vault_ratio", vaultHandler);
      bus.off("contract_link", linkHandler);
      logger.info("[ws] Client disconnected");
    });

    ws.on("error", (err) => {
      logger.error("[ws] Socket error:", err.message);
      bus.off("event", handler);
      bus.off("vault_ratio", vaultHandler);
      bus.off("contract_link", linkHandler);
    });

    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Soroban event stream ready",
        network,
      }),
    );
  });

  logger.info("[ws] WebSocket server attached");
  return wss;
}
