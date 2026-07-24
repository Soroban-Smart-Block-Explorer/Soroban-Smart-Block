# Configuration Validation Documentation

## Overview

The indexer validates all environment variables at startup using [Zod](https://zod.dev/) schemas to prevent runtime errors from malformed configuration. Invalid configuration results in immediate process termination with actionable error messages.

## Problem Statement

Previously, configuration values were parsed using unchecked `parseInt()` and `Number()` calls:

```javascript
const POLL_MS = Number(process.env.POLL_MS || 5000);
const BLOAT_THRESHOLD = Number(process.env.BLOAT_THRESHOLD ?? 50);
```

This approach had critical flaws:
- Empty strings became `NaN`
- Invalid values like `"abc"` became `NaN`
- Negative values were accepted where positive was required
- No validation of URL formats
- No port range checking
- Errors surfaced at runtime, not startup

## Solution

Configuration is now validated through a Zod schema in `src/config.js` that:
- ✅ Enforces type safety
- ✅ Validates numeric ranges (positive, non-negative, port range)
- ✅ Validates URL formats
- ✅ Validates cron expressions
- ✅ Provides default values
- ✅ Fails fast at startup with detailed error messages
- ✅ Exports type-safe configuration object

## Usage

### Import Configuration

```javascript
import config from "./config.js";

// Use validated configuration
const pollInterval = config.POLL_MS; // Guaranteed to be positive integer >= 100
const rpcUrl = config.SOROBAN_RPC_URL; // Guaranteed to be valid URL
const port = config.PORT; // Guaranteed to be 1-65535
```

### Migration from process.env

**Before:**
```javascript
const POLL_MS = Number(process.env.POLL_MS || 5000);
const PORT = Number(process.env.PORT || 3001);
```

**After:**
```javascript
import config from "./config.js";

const POLL_MS = config.POLL_MS;
const PORT = config.PORT;
```

## Validation Rules

### Required Fields

#### DATABASE_URL
- **Type**: String
- **Validation**: Must be PostgreSQL connection string
- **Format**: `postgres://` or `postgresql://`
- **Example**: `postgres://user:pass@localhost:5432/dbname`
- **Error if missing**: Process exits with validation error

### Numeric Fields

#### Positive Integers
These fields must be positive (> 0):

- `PORT` - Server port (also must be 1-65535)
- `POLL_MS` - Polling interval (also must be >= 100ms)
- `GAS_GUZZLERS_INTERVAL_MS` - Gas guzzlers refresh interval (>= 60000ms)
- `BLOAT_THRESHOLD` - Bloat detection threshold
- `METADATA_CACHE_TTL` - Cache TTL in seconds
- `CACHE_L1_MAX` - L1 cache max entries
- `ALERT_GAP_THRESHOLD` - Alert gap threshold
- `ALERT_DLQ_MAX_SIZE` - Dead letter queue max size
- `ALERT_MAX_HEAP_MB` - Max heap size in MB
- `ALERT_INDEXER_STALL_MS` - Indexer stall timeout
- `DLQ_MAX_RETRIES` - Dead letter queue max retries
- `DLQ_RETRY_DELAY_MS` - Dead letter queue retry delay
- `LEADER_LEASE_TTL_S` - Leader election lease TTL
- `LEADER_RENEW_INTERVAL_MS` - Leader renew interval
- `LEADER_ELECTION_POLL_MS` - Election poll interval
- `KAFKA_BUS_DEDUP_TTL_S` - Kafka deduplication TTL
- `KAFKA_BUS_EVENT_TTL_S` - Kafka event TTL
- `RPC_HEALTH_WINDOW` - RPC health check window size
- `RPC_CALL_TIMEOUT_MS` - RPC call timeout
- `RPC_RECOVERY_INTERVAL_MS` - RPC recovery interval
- `RPC_LAG_THRESHOLD` - RPC lag threshold
- `METRICS_PROBE_INTERVAL_MS` - Metrics probe interval
- `METRICS_MAX_SAMPLES` - Max metric samples
- `PRUNE_LEDGER_BUFFER` - Pruner ledger buffer
- `MAX_TEMP_TTL_LEDGERS` - Max temporary TTL ledgers
- `PREDICTIVE_GAP_THRESHOLD` - Predictive gap threshold
- `PREDICTIVE_HISTORY_SIZE` - Predictive history size

**Default Values**: See [`.env.example`](../.env.example) for defaults

**Validation**:
- ❌ Empty string → Uses default
- ❌ `"abc"` → Validation error (not a number)
- ❌ `"-100"` → Validation error (not positive)
- ❌ `"0"` → Validation error (not positive)
- ✅ `"5000"` → Parsed as `5000`

#### Non-negative Integers
These fields can be zero or positive (>= 0):

- `START_LEDGER` - Starting ledger number

**Validation**:
- ✅ `"0"` → Parsed as `0`
- ✅ `"1234567"` → Parsed as `1234567`
- ❌ `"-1"` → Validation error (not non-negative)

#### Positive Floats
These fields must be positive floating-point numbers:

- `CACHE_XFETCH_BETA` - Cache XFetch beta coefficient
- `ALERT_MIN_THROUGHPUT` - Minimum throughput threshold

**Validation**:
- ✅ `"1.5"` → Parsed as `1.5`
- ✅ `"0.5"` → Parsed as `0.5`
- ❌ `"0"` → Validation error (not positive)
- ❌ `"-0.5"` → Validation error (not positive)

### URL Fields

#### Required URLs
- `SOROBAN_RPC_URL` - Soroban RPC endpoint
- `HORIZON_URL` - Horizon API endpoint

**Default**: Stellar testnet URLs

**Validation**:
- ✅ `https://soroban-testnet.stellar.org`
- ✅ `http://localhost:8000`
- ❌ `not-a-url` → Validation error
- ❌ `ftp://invalid.com` → Validation error (must be http/https)

#### Optional URLs
- `REDIS_URL` - Redis connection URL
- `CLOUDFLARE_WEBHOOK_URL` - Cloudflare webhook URL

**Validation**:
- ✅ Not set → `undefined`
- ✅ `redis://localhost:6379`
- ❌ `invalid-url` → Validation error

### String Fields

#### Cron Expressions
- `PRUNE_CRON` - Pruner schedule
- `ABI_SYNC_CRON` - ABI sync schedule

**Validation**:
- ✅ `"0 2 * * *"` - 5 fields (standard cron)
- ✅ `"0 */10 * * * *"` - 6 fields (with seconds)
- ❌ `"invalid cron"` → Validation error

#### Comma-separated Lists
- `SOROBAN_RPC_URLS` - Multiple RPC URLs
- `SAC_ASSETS` - SAC asset contract IDs
- `GEO_BLOCK_LIST` - Country codes to block

**Parsing**:
```javascript
// Input: "CN, RU, KP"
// Output: ["CN", "RU", "KP"]

// Input: ""
// Output: []
```

### Boolean Fields

- `VERIFY_ON_UPLOAD` - Auto-verify on upload

**Parsing**:
- `"true"` → `true`
- `"1"` → `true`
- `"false"` → `false`
- `"0"` → `false`
- Not set → Uses default

### Optional String Fields
- `EXPLORER_CONTRACT_ID`
- `API_KEY`
- `GITHUB_TOKEN`
- `SIMULATE_SOURCE`
- `ADMIN_SECRET`
- `RATE_LIMIT_CONFIG`
- `GEO_RATE_MULTIPLIERS`
- `GEOIP_DB_PATH`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_SECRET_KEY`
- `KAFKA_BROKERS`

## Error Messages

When validation fails, the process exits with actionable error messages:

```
❌ Configuration Validation Error

Invalid environment variables detected. Please fix the following issues:

1. POLL_MS
   Error: Must be a positive integer, got invalid value
   Received: "abc"

2. PORT
   Error: PORT must be between 1 and 65535
   Received: "99999"

3. DATABASE_URL
   Error: DATABASE_URL must be a valid PostgreSQL connection string
   Received: "mysql://localhost"

Please check your .env file or environment variables and try again.

See .env.example for reference configuration.
```

## Testing

### Running Tests

```bash
cd indexer
npm test test/config.test.js
```

### Test Coverage

The test suite covers:
- ✅ Missing required fields
- ✅ Invalid numeric values (NaN, negative, zero)
- ✅ Out-of-range values (port > 65535)
- ✅ Invalid URL formats
- ✅ Invalid cron expressions
- ✅ Default value application
- ✅ Comma-separated list parsing
- ✅ Boolean value parsing
- ✅ Float validation

### Example Test

```javascript
it("should reject NaN for POLL_MS", async () => {
  process.env.POLL_MS = "not-a-number";
  process.env.DATABASE_URL = "postgres://localhost/db";
  
  await expect(async () => {
    await import("../src/config.js");
  }).rejects.toThrow("process.exit(1)");
});
```

## Development Workflow

### Adding New Configuration

1. **Add to `.env.example`**:
```bash
# My new configuration
MY_CONFIG=default_value
```

2. **Add to Zod schema** in `src/config.js`:
```javascript
const configSchema = z.object({
  // ... existing fields
  
  MY_CONFIG: positiveInt(1000).refine((val) => val >= 100, {
    message: "MY_CONFIG must be at least 100",
  }),
});
```

3. **Use in code**:
```javascript
import config from "./config.js";

const myValue = config.MY_CONFIG; // Type-safe and validated
```

4. **Add tests**:
```javascript
it("should validate MY_CONFIG", async () => {
  process.env.MY_CONFIG = "500";
  const config = await import("../src/config.js");
  expect(config.default.MY_CONFIG).toBe(500);
});
```

### Validation Helper Functions

The module provides reusable validation helpers:

```javascript
// Positive integer with default
positiveInt(defaultValue)

// Non-negative integer with default
nonNegativeInt(defaultValue)

// Positive float with default
positiveNumber(defaultValue)

// Required URL
urlString()

// Optional URL
optionalUrl()

// Comma-separated list
commaSeparatedList()

// Boolean with default
booleanWithDefault(defaultValue)

// Cron expression with default
cronExpression(defaultValue)
```

## Migration Guide

### Step 1: Update imports

Replace direct `process.env` access with config import:

**Before:**
```javascript
const TIMEOUT = Number(process.env.TIMEOUT || 1000);
```

**After:**
```javascript
import config from "./config.js";

const TIMEOUT = config.TIMEOUT;
```

### Step 2: Remove manual parsing

Delete parseInt/Number calls:

**Before:**
```javascript
const threshold = Number(process.env.THRESHOLD ?? 50);
if (isNaN(threshold)) {
  console.error("Invalid THRESHOLD");
}
```

**After:**
```javascript
import config from "./config.js";

const threshold = config.THRESHOLD; // Already validated
```

### Step 3: Update tests

Update test environment setup:

**Before:**
```javascript
const threshold = Number(process.env.PREDICTIVE_GAP_THRESHOLD ?? 3);
```

**After:**
```javascript
import config from "./config.js";

const threshold = config.PREDICTIVE_GAP_THRESHOLD;
```

## Benefits

### Before Validation

```javascript
// Silent failures at runtime
const POLL_MS = Number(process.env.POLL_MS || 5000);
// If POLL_MS="abc", this becomes NaN
// Application starts but fails when used

setTimeout(doWork, POLL_MS); // setTimeout called with NaN!
```

### After Validation

```javascript
import config from "./config.js";

// Fails immediately at startup with clear message:
// "POLL_MS: Must be a positive integer, got invalid value"

const POLL_MS = config.POLL_MS; // Guaranteed valid
setTimeout(doWork, POLL_MS); // Always works
```

### Production Benefits

- **Fail Fast**: Errors caught at startup, not during traffic
- **Clear Messages**: Operators know exactly what to fix
- **Type Safety**: No NaN surprises in production
- **Documentation**: Schema serves as configuration reference
- **Testing**: Easy to test invalid configurations

## Troubleshooting

### "Must be a positive integer" Error

```
Error: Must be a positive integer, got invalid value
Received: "0"
```

**Fix**: Ensure the value is greater than 0:
```bash
POLL_MS=5000  # Not 0, not negative
```

### "Must be a valid URL" Error

```
Error: SOROBAN_RPC_URL must be a valid URL
Received: "localhost:8000"
```

**Fix**: Include protocol:
```bash
SOROBAN_RPC_URL=http://localhost:8000
```

### "Must be a valid PostgreSQL connection string" Error

```
Error: DATABASE_URL must be a valid PostgreSQL connection string
Received: "mysql://localhost/db"
```

**Fix**: Use `postgres://` or `postgresql://`:
```bash
DATABASE_URL=postgres://user:pass@localhost:5432/dbname
```

### "Must be a valid cron expression" Error

```
Error: PRUNE_CRON must be a valid cron expression
Received: "every day"
```

**Fix**: Use cron format:
```bash
PRUNE_CRON="0 2 * * *"  # 2:00 AM daily
```

### Empty String Defaults

Empty strings use default values:
```bash
# These are equivalent:
POLL_MS=
# (uses default 5000)

# Not set:
# (also uses default 5000)
```

## References

- [Zod Documentation](https://zod.dev/)
- [Environment Variables Best Practices](https://12factor.net/config)
- [Node.js Environment Variables](https://nodejs.org/dist/latest-v20.x/docs/api/process.html#process_process_env)
