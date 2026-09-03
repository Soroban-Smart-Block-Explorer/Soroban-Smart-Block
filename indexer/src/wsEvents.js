import { logger } from "./logger.js";
/**
 * Live Event Streaming via WebSockets 
 *
 * Uses Node's built-in EventEmitter as the pub/sub bus (no Redis required).
 * The HTTP server is upgraded to handle WebSocket connections via the `ws`
 * package.  When the indexer stores a new event it calls `publish(event)` and
 * every connected client receives the payload within the same event-loop tick.
 */

import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import url from "url";

const API_KEY = process.env.API_KEY;
const bus = new EventEmitter();
bus.setMaxListeners(0);

const txStatusCache = new Map();

export function publish(event) {
  bus.emit("event", event);
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
      if (API_KEY && key !== API_KEY) {
        cb(false, 401, "Unauthorized");
        return;
      }
      cb(true);
    },
  });

  wss.on("connection", (ws, _req) => {
    logger.info("[ws] Client connected");

    const handler = (event) => {
      if (ws.readyState === ws.OPEN) {
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

    bus.on("event", handler);
    bus.on("vault_ratio", vaultHandler);
    bus.on("contract_link", linkHandler);

    ws.on("close", () => {
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
      }),
    );
  });

  logger.info("[ws] WebSocket server attached");
  return wss;
}
