# WebSocket Streaming API

The Soroban Smart Block Explorer exposes a WebSocket endpoint that pushes decoded contract events to connected clients in real time. No polling is required — every new event that the indexer processes is broadcast within the same event-loop tick.

---

## Connection

**Endpoint:** `ws://<host>:3001`

The WebSocket server is attached to the same HTTP server as the REST API. Connect to the root of the server (no path suffix required).

```
ws://localhost:3001
```

For TLS-terminated deployments (reverse proxy in front of the indexer):

```
wss://api.your-domain.com
```

---

## Authentication

Authentication is enforced at the WebSocket handshake level via an `api_key` query parameter. If the server is started with the `API_KEY` environment variable set, every connection **must** supply a matching key. If `API_KEY` is not set, the server accepts all connections.

**Authenticated connection URL:**

```
ws://localhost:3001?api_key=YOUR_API_KEY
```

### Error codes

| Code | Meaning |
|------|---------|
| `4401` | Authentication failed — the supplied `api_key` is missing or does not match the server's `API_KEY`. |
| `4429` | Too many concurrent connections from this client. |
| `1008` | Message buffer exceeded — the server dropped the connection because the client was not consuming messages fast enough. |

> The standard WebSocket close code for an auth failure during the HTTP upgrade is **401** (sent as the HTTP status before the upgrade is rejected). Codes `4xxx` are application-level close codes sent after a connection is established.

---

## Handshake and connected confirmation

Immediately after a successful connection the server sends a `connected` message:

```json
{
  "type": "connected",
  "message": "Soroban event stream ready"
}
```

You can use this as a reliable signal that the stream is live and authentication passed.

---

## Subscribe message format

The current server broadcasts **all** events to every authenticated connection. There is no server-side filter at the protocol level — filtering is done client-side.

If you need to subscribe only to a specific contract you should ignore events whose `data.contract_id` does not match your target (see the JavaScript example below).

> **Note:** A subscription message protocol (with a `subscribe` action and contract/function filters) is planned for a future release. When it is available it will be documented here.

---

## Unsubscribe

To stop receiving events, close the WebSocket connection:

```js
ws.close();
```

The server releases all internal listeners on `close` and `error`, so there is no explicit unsubscribe frame required.

---

## Event message format

Every decoded contract event is pushed as a JSON string with `"type": "event"`.

### Schema

```json
{
  "type": "event",
  "data": {
    "seq": 1042,
    "contract_id": "CC4VM2DTTR4QO4J4E5K2YUXM3HKQLMCZITM3YQZAHF3TJB4",
    "function": "transfer",
    "ledger": 1050320,
    "tx_hash": "a3f1...",
    "description": "Address GABC… transferred 100.0000000 USDC to GXYZ…",
    "raw_topics": ["AAAADgAAAAh0cmFuc2Zlcg==", "..."],
    "raw_data": "{\"amount\":\"1000000000\"}",
    "cpu_instructions": 12450,
    "mem_bytes": 4096,
    "fee_charged": 1200,
    "is_high_bloat_risk": false,
    "is_clawback": false,
    "type": "soroban",
    "slippage_bps": null
  }
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `seq` | integer | Monotonically increasing sequence number assigned by the indexer |
| `contract_id` | string | Soroban contract strkey (starts with `C`) |
| `function` | string | Name of the contract function that emitted the event |
| `ledger` | integer | Stellar ledger sequence number where this event was confirmed |
| `tx_hash` | string | Transaction hash |
| `description` | string | Human-readable decoded summary |
| `raw_topics` | string[] | Base64-encoded raw XDR topic values |
| `raw_data` | string | JSON-encoded raw event data |
| `cpu_instructions` | integer \| null | CPU instructions consumed by the transaction |
| `mem_bytes` | integer \| null | Memory bytes consumed |
| `fee_charged` | integer \| null | Fee charged in stroops |
| `is_high_bloat_risk` | boolean | `true` when the event writes unusually large state |
| `is_clawback` | boolean | `true` for SEP-41 clawback operations |
| `type` | `"soroban"` \| `"classic"` | Event category |
| `slippage_bps` | integer \| null | DEX swap slippage in basis points (present only for swaps) |

---

## Transaction status updates

In addition to contract events, the server pushes transaction status changes as they are confirmed by the indexer.

```json
{
  "type": "vault_ratio",
  "data": {
    "contract_id": "CC4VM2DTTR4QO4J4E5K2YUXM3HKQLMCZITM3YQZAHF3TJB4",
    "ratio": 1.52,
    "total_assets": "15200000000",
    "total_supply": "10000000000",
    "ledger": 1050320
  }
}
```

```json
{
  "type": "contract_link",
  "data": {
    "source": "CC4VM2DTTR4QO4J4E5K2YUXM",
    "target": "CDEX7MZXYZ...",
    "call_count": 42,
    "ledger": 1050321
  }
}
```

For point-in-time transaction status polling or SSE-based streaming use the REST endpoints:

- `GET /api/transactions/:hash/status` — snapshot
- `GET /api/transactions/:hash/status/stream` — SSE stream for a single transaction
- `GET /api/transactions/status?txHashes=hash1,hash2` — SSE stream for multiple transactions

---

## Message types summary

| `type` | When emitted |
|--------|-------------|
| `connected` | Once, immediately after a successful WebSocket handshake |
| `event` | Every time the indexer stores a new decoded contract event |
| `vault_ratio` | When a monitored vault's collateral ratio changes |
| `contract_link` | When a new cross-contract call relationship is recorded |

---

## Error codes reference

| Code | Class | Description |
|------|-------|-------------|
| `4401` | Application | Authentication failed — wrong or missing `api_key`. |
| `4429` | Application | Connection rejected; client has too many open connections. |
| `1000` | Normal | Clean close initiated by the server or client. |
| `1001` | Going away | Server is shutting down. |
| `1006` | Abnormal | Connection lost without a proper close frame (network error). |
| `1008` | Policy violation | Client message buffer exceeded; server closed the connection. |
| `1011` | Internal error | Unexpected server error during message processing. |

---

## Working JavaScript example

The example below connects to the local indexer, authenticates, and filters the broadcast stream to only log events for a specific contract. Paste it into a browser console or a Node.js script.

```js
// WebSocket streaming — filter events for a specific contract
// Works in a browser console (native WebSocket) or Node.js >= 22 (global WebSocket)
// For older Node.js: npm install ws, then: const WebSocket = require("ws");

const API_KEY   = "YOUR_API_KEY";          // leave "" if API_KEY is not set on the server
const WS_URL    = "ws://localhost:3001";
const CONTRACT  = "CC4VM2DTTR4QO4J4E5K2YUXM3HKQLMCZITM3YQZAHF3TJB4";

const wsUrl = API_KEY
  ? `${WS_URL}?api_key=${encodeURIComponent(API_KEY)}`
  : WS_URL;

const ws = new WebSocket(wsUrl);

ws.addEventListener("open", () => {
  console.log("[ws] Connection opened");
});

ws.addEventListener("message", (msgEvent) => {
  let msg;
  try {
    msg = JSON.parse(msgEvent.data);
  } catch {
    console.warn("[ws] Non-JSON frame received:", msgEvent.data);
    return;
  }

  switch (msg.type) {
    case "connected":
      // Handshake confirmed — stream is live
      console.log("[ws] Stream ready:", msg.message);
      break;

    case "event": {
      const ev = msg.data;
      // Filter client-side to only the contract we care about
      if (ev.contract_id !== CONTRACT) return;
      console.log(
        `[ws] Event #${ev.seq} | fn: ${ev.function} | ledger: ${ev.ledger}`,
        "\n     ", ev.description,
      );
      break;
    }

    case "vault_ratio":
      console.log("[ws] Vault ratio update:", msg.data);
      break;

    case "contract_link":
      console.log("[ws] New contract link:", msg.data);
      break;

    default:
      console.log("[ws] Unknown message type:", msg.type, msg);
  }
});

ws.addEventListener("close", (ev) => {
  console.warn(`[ws] Connection closed — code: ${ev.code}, reason: ${ev.reason}`);
  // Application-level error codes
  if (ev.code === 4401) console.error("[ws] Authentication failed. Check your api_key.");
  if (ev.code === 4429) console.error("[ws] Too many connections from this client.");
  if (ev.code === 1008) console.error("[ws] Buffer exceeded — consume messages faster or filter client-side.");
});

ws.addEventListener("error", (err) => {
  console.error("[ws] Socket error:", err);
});

// Graceful shutdown — call this when you are done
function disconnect() {
  ws.close(1000, "Client done");
}
```

### Running in Node.js (< 22)

```bash
npm install ws
```

```js
import WebSocket from "ws";
// … rest of the example above unchanged …
```

### Reconnection

The server does not automatically reconnect. Add exponential back-off for production use:

```js
let delay = 1000;

function connect() {
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("open",  ()      => { delay = 1000; /* reset */ });
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", (ev)    => {
    if (ev.code === 4401) return; // auth error — do not retry
    console.log(`[ws] Reconnecting in ${delay}ms…`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  });
}

connect();
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Connection refused | Indexer not running | Start with `make indexer` |
| HTTP 101 upgrade never arrives | Reverse proxy not configured for WebSocket | Add `Upgrade` and `Connection` headers in your proxy config |
| HTTP 401 during upgrade | Wrong `api_key` | Verify the `API_KEY` env var matches |
| Messages stop arriving | Network idle timeout | Send a ping frame periodically; most browsers do this automatically |
| `4401` close code | `api_key` missing or wrong | Check `API_KEY` env var and the query parameter |
| `1008` close code | Slow consumer | Add client-side filtering or increase the server's `perMessageDeflate` threshold |
