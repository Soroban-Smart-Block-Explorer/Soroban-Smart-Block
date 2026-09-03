# @soroban-explorer/sdk

TypeScript SDK client for the Soroban Smart Block Explorer API.

## Status

This package provides complete scaffolding for a generated TypeScript SDK client:
- ✅ Fetch wrapper (`src/index.ts`) — hand-written thin client with auth/CSRF/error handling
- ✅ Build configuration (`package.json`, `tsconfig.json`) — ready to run codegen and build
- ✅ GitHub Actions workflow (`.github/workflows/publish-sdk.yml`) — ready to publish on release
- ❌ **Generated types NOT included** — `npm run generate-types` must be run locally
- ❌ **NOT published to npm** — requires real npm registry credentials and a maintainer-triggered release

## Installation

Once the SDK is published to npm:

```bash
npm install @soroban-explorer/sdk
```

## Usage

### Basic Setup

```typescript
import { createClient } from '@soroban-explorer/sdk';

const client = createClient({
  baseUrl: 'https://api.soroban-explorer.com',
  apiKey: 'your-api-key',
});
```

### Fetching Events

```typescript
const response = await client.get('/api/events', {
  params: {
    contract: 'CC4VM2DTTR4QO4J4E5K2YUXM',
    limit: 25,
  },
});

console.log(response.data);
console.log(response.meta.rateLimitRemaining);
```

### CSRF Protection (Browser Clients)

For browser-based clients, fetch a CSRF token before making state-changing requests:

```typescript
// On app initialization
await client.fetchCsrfToken();

// Then POST/PATCH/DELETE requests will include the token automatically
```

### Error Handling

```typescript
import { ApiError } from '@soroban-explorer/sdk';

try {
  await client.post('/api/contracts', contractMeta);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(`API Error ${error.status}: ${error.statusText}`);
    console.log('Rate limit remaining:', error.meta.rateLimitRemaining);
  }
}
```

### Rate Limiting

All responses include rate-limit metadata:

```typescript
const response = await client.get('/api/events');
const {
  rateLimitLimit,
  rateLimitRemaining,
  rateLimitReset,
  rateLimitTier,
} = response.meta;
```

## Development

### Generate TypeScript Types

The SDK uses `openapi-typescript` to generate type definitions from `docs/api/openapi.yaml`:

```bash
npm run generate-types
# Produces: src/api.types.ts (not committed to git)
```

### Build

```bash
npm run build
# Runs: generate-types → tsc → dist/
```

### Type Checking

```bash
npm run typecheck
```

### Tests

```bash
npm test
```

## For Maintainers: Publishing

1. **Generate and build locally** to verify the OpenAPI spec is correct:
   ```bash
   npm run build
   ```

2. **Commit the changes** (but NOT `src/api.types.ts`, which is generated):
   ```bash
   git add packages/sdk/
   git commit -m "SDK scaffolding: fetch wrapper and codegen setup"
   ```

3. **Tag a release**:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. **GitHub Actions will automatically**:
   - Generate types from the OpenAPI spec
   - Build the package
   - Run tests
   - Publish to npm (requires `NPM_TOKEN` secret in GitHub)

## Authentication

The SDK supports three authentication methods:

- **API Key:** Pass `apiKey` in config or use `client.setApiKey(key)`
- **Bearer Token:** Pass `bearerToken` in config or use `client.setBearerToken(token)`
- **CSRF Token:** Automatically managed by `client.fetchCsrfToken()` (browser clients)

## Configuration

```typescript
const client = createClient({
  baseUrl: 'https://api.soroban-explorer.com',  // Default: http://localhost:3001
  apiKey: 'sk_...',                              // Optional API key
  bearerToken: 'your-jwt-token',                // Optional Bearer token
  csrfToken: 'manually-set-token',              // Optional (usually fetched)
  timeout: 30000,                               // Request timeout (ms)
  headers: {                                    // Custom headers
    'User-Agent': 'MyApp/1.0',
  },
});
```

## API Reference

See the [OpenAPI spec](../../docs/api/openapi.yaml) for detailed endpoint documentation.

## License

MIT
