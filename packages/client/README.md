# @soroban-explorer/client

Typed JavaScript/TypeScript client for the [Soroban Smart Block Explorer](https://github.com/AnsaBaby/Soroban-Smart-Block) API. Query decoded Soroban smart-contract events, contracts, wallets, and more — with full TypeScript types and zero boilerplate.

## Features

- **Full REST API coverage** — events, contracts, wallets, search, tokens, health
- **Complete TypeScript types** for every request and response shape
- **WebSocket support** — subscribe to live events with auto-reconnect (exponential backoff + jitter)
- **Typed error classes** — `NotFoundError`, `RateLimitError`, `ValidationError`, etc.
- **Dual ESM + CJS** — works in Node.js, browsers, Deno, and Bun
- **Zero runtime dependencies** — uses native `fetch` and optional `ws` peer dep for Node.js WebSocket

## Installation

```bash
npm install @soroban-explorer/client
```

For WebSocket support in Node.js < 22, also install:

```bash
npm install ws
```

> **Note:** Browsers, Deno, and Bun have native WebSocket — no extra install needed.

## Quick Start

### 1. Create a Client

```ts
import { SorobanExplorerClient } from "@soroban-explorer/client";

const client = new SorobanExplorerClient({
  baseUrl: "https://your-explorer-api.example.com",
  apiKey: "your-api-key", // optional
});
```

### 2. Fetch Events

```ts
// Get the first page of events for a specific contract
const { data, next_cursor } = await client.getEvents({
  contract: "CABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
  limit: 10,
});

console.log(`Got ${data.length} events`);
for (const event of data) {
  console.log(`${event.function} at ledger ${event.ledger}`);
}

// Paginate
if (next_cursor) {
  const page2 = await client.getEvents({ after_seq: next_cursor });
}
```

### 3. Look Up a Contract

```ts
const contract = await client.getContract("CABCDEF…");
console.log(contract.name);          // "ExampleToken"
console.log(contract.functions);     // [{ name: "transfer", params: [...] }, ...]
```

### 4. Search

```ts
const results = await client.search("token", 5);
console.log(results.contracts); // matching contracts
console.log(results.events);   // matching events
console.log(results.wallets);  // matching wallets
```

### 5. Subscribe to Live Events

```ts
const sub = client.subscribeEvents(
  {
    maxReconnectAttempts: 10,
    onReconnect: () => console.log("Reconnected!"),
    onDisconnect: () => console.log("Disconnected"),
    onError: (err) => console.error("WS error:", err),
  },
  (message) => {
    switch (message.type) {
      case "event":
        console.log("New event:", message.data);
        break;
      case "vault_ratio":
        console.log("Vault update:", message.data);
        break;
      case "connected":
        console.log("Stream ready:", message.message);
        break;
    }
  },
);

// Later — cleanly close the connection
sub.unsubscribe();
```

## API Reference

### `SorobanExplorerClient`

#### Constructor

```ts
new SorobanExplorerClient(options: ClientOptions)
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `baseUrl` | `string` | ✅ | Base URL of the explorer API |
| `apiKey` | `string` | ❌ | Sent as `x-api-key` header |
| `fetch` | `typeof fetch` | ❌ | Custom fetch implementation |

#### Methods

| Method | Description |
|--------|-------------|
| `getEvents(filter?)` | List events (cursor pagination) |
| `getEvent(seq)` | Get a single event by sequence number |
| `getContracts(filter?)` | List registered contracts |
| `getContract(id)` | Get contract metadata |
| `getContractEvents(id, filter?)` | Get events for a contract |
| `getContractStats(id)` | Contract statistics + 30-day sparkline |
| `getContractAbiHistory(id)` | ABI version history |
| `getContractUpgrades(id)` | WASM upgrade lineage |
| `getContractTtl(id)` | Live TTL status |
| `getContractCallGraph(id, limit?)` | Sub-invocation call graph |
| `getContractStorageTiers(id)` | Storage tier write counts |
| `getWalletEvents(address, filter?)` | Events involving a wallet |
| `getWalletBalances(address)` | XLM + asset balances |
| `search(query, limit?)` | Full-text search |
| `getTokenHolders(contractId)` | Token holder list |
| `getTokenVolume(contractId)` | 24h transfer volume |
| `getStats()` | Global aggregate stats |
| `getHealth()` | API health status |
| `subscribeEvents(options, callback)` | Live WebSocket subscription |

### Error Handling

All methods throw typed errors:

```ts
import {
  NotFoundError,       // 404
  RateLimitError,      // 429 — has .retryAfter (seconds)
  ValidationError,     // 400 / 422
  UnauthorizedError,   // 401
  SorobanExplorerError // any other HTTP error
} from "@soroban-explorer/client";

try {
  await client.getContract("invalid-id");
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log("Contract not found");
  } else if (err instanceof RateLimitError) {
    console.log(`Rate limited. Retry in ${err.retryAfter}s`);
  }
}
```

### `subscribeEvents` (standalone)

You can also use the WebSocket wrapper directly without the client class:

```ts
import { subscribeEvents } from "@soroban-explorer/client";

const sub = subscribeEvents(
  "https://your-explorer-api.example.com",
  { apiKey: "your-key" },
  (msg) => console.log(msg),
);
```

## Requirements

- **Node.js** >= 18 (uses native `fetch`)
- **WebSocket** (Node.js): install `ws` as a peer dependency, or use Node.js >= 22 (native WebSocket)
- **Browsers**: works out of the box — native `fetch` and `WebSocket`

## License

MIT
