# Building with the API

The indexer exposes a REST API for decoded events, contracts, wallets, and tokens,
plus a WebSocket stream for live updates. This guide shows the common patterns.
The full contract is in [`openapi.json`](../api/openapi.json); try any endpoint in
the [Swagger playground](../api/playground.html) or the
[try-it console](../api/try-it.html).

Prefer a desktop client? Import
[`postman_collection.json`](../api/postman_collection.json) into Postman or
Insomnia (Insomnia opens Postman v2.1 collections natively) for a ready-made
request for every documented endpoint, grouped by tag. It's generated from
`openapi.yaml` — regenerate it with `npm run generate:postman` after changing
the spec; CI fails if the committed file drifts from the spec.

## Base URL and authentication

The API listens on `http://localhost:3001` by default. When an API key is
configured on the server, send it as the `X-API-Key` header:

```bash
curl http://localhost:3001/api/events \
  -H "X-API-Key: $API_KEY"
```

## List events

```bash
# Offset pagination with filters
curl "http://localhost:3001/api/events?contract=C...&fn=swap&page=1"

# Cursor pagination
curl "http://localhost:3001/api/v1/events?limit=50"
```

```javascript
const res = await fetch("http://localhost:3001/api/events?fn=swap&page=1", {
  headers: { "X-API-Key": API_KEY },
});
const events = await res.json();
```

```python
import requests

events = requests.get(
    "http://localhost:3001/api/events",
    params={"fn": "swap", "page": 1},
    headers={"X-API-Key": API_KEY},
).json()
```

## Fetch a single event and a contract

```bash
curl http://localhost:3001/api/events/4521983
curl http://localhost:3001/api/contracts/C...
curl http://localhost:3001/api/contracts/C.../abi
```

## Wallets and tokens

```bash
curl http://localhost:3001/api/wallet/G...
curl http://localhost:3001/api/tokens/C.../holders
curl http://localhost:3001/api/tokens/C.../volume
```

## Live updates over WebSocket

Connect to `ws(s)://<host>/?api_key=<key>`. The server pushes JSON messages:

```javascript
const ws = new WebSocket("ws://localhost:3001/?api_key=" + API_KEY);
ws.onmessage = (msg) => {
  const { type, data } = JSON.parse(msg.data);
  // type is "event" | "vault_ratio" | "contract_link"
  console.log(type, data);
};
```

You can experiment with the stream in the
[try-it console](../api/try-it.html#websocket).

## Error handling and rate limits

- Non-2xx responses return a JSON body with an error message.
- A `401` means the API key is missing or wrong.
- The HTTP API is rate limited per IP. Back off and retry on `429`.

## Next steps

- [Register a contract](#register-contract) to improve decoding quality.
- Read the [architecture deep dive](#architecture-deep-dive) to understand how
  events are produced.
