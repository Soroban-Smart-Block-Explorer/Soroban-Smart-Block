/**
 * Environment Configuration Validation
 *
 * Validates all environment variables at startup using Zod schemas.
 * Enforces types, ranges, and defaults to prevent runtime NaN errors.
 *
 * Features:
 * - Type-safe configuration with validation
 * - Positive number constraints for numeric values
 * - Required vs optional field enforcement
 * - Actionable validation error messages
 * - Fail-fast on invalid configuration
 */
import "dotenv/config";
import { z } from "zod";

// ── Helper: Positive integer with default ─────────────────────────────────────
const positiveInt = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : defaultValue))
    .refine((val) => !isNaN(val) && val > 0, {
      message: `Must be a positive integer, got invalid value`,
    });

// ── Helper: Non-negative integer with default ─────────────────────────────────
const nonNegativeInt = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : defaultValue))
    .refine((val) => !isNaN(val) && val >= 0, {
      message: `Must be a non-negative integer, got invalid value`,
    });

// ── Helper: Positive number (float) with default ──────────────────────────────
const positiveNumber = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((val) => (val ? parseFloat(val) : defaultValue))
    .refine((val) => !isNaN(val) && val > 0, {
      message: `Must be a positive number, got invalid value`,
    });

// ── Helper: URL validation ────────────────────────────────────────────────────
const urlString = () =>
  z.string().url({ message: "Must be a valid URL" });

// ── Helper: Optional URL ──────────────────────────────────────────────────────
const optionalUrl = () =>
  z
    .string()
    .optional()
    .refine(
      (val) => !val || z.string().url().safeParse(val).success,
      { message: "Must be a valid URL if provided" }
    );

// ── Helper: Comma-separated list ──────────────────────────────────────────────
const commaSeparatedList = () =>
  z
    .string()
    .optional()
    .transform((val) => (val ? val.split(",").map((s) => s.trim()).filter(Boolean) : []));

// ── Helper: Boolean with default ──────────────────────────────────────────────
const booleanWithDefault = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return defaultValue;
      return val.toLowerCase() === "true" || val === "1";
    });

// ── Helper: Cron expression validation ───────────────────────────────────────
const cronExpression = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((val) => val || defaultValue)
    .refine(
      (val) => {
        // Basic cron validation: 5 or 6 fields separated by spaces
        const parts = val.trim().split(/\s+/);
        return parts.length === 5 || parts.length === 6;
      },
      { message: "Must be a valid cron expression (e.g., '0 2 * * *')" }
    );

// ── Main Configuration Schema ─────────────────────────────────────────────────
const configSchema = z.object({
  // ── Stellar Network ─────────────────────────────────────────────────────────
  SOROBAN_RPC_URL: z
    .string()
    .url({ message: "SOROBAN_RPC_URL must be a valid URL" })
    .default("https://soroban-testnet.stellar.org"),
  
  SOROBAN_RPC_URLS: commaSeparatedList(),
  
  HORIZON_URL: z
    .string()
    .url({ message: "HORIZON_URL must be a valid URL" })
    .default("https://horizon-testnet.stellar.org"),
  
  NETWORK_PASSPHRASE: z
    .string()
    .default("Test SDF Network ; September 2015"),

  // ── PostgreSQL ──────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (val) => val.startsWith("postgres://") || val.startsWith("postgresql://"),
      { message: "DATABASE_URL must be a valid PostgreSQL connection string" }
    ),

  // ── Indexer ─────────────────────────────────────────────────────────────────
  PORT: positiveInt(3001).refine((val) => val >= 1 && val <= 65535, {
    message: "PORT must be between 1 and 65535",
  }),

  START_LEDGER: nonNegativeInt(0),

  POLL_MS: positiveInt(5000).refine((val) => val >= 100, {
    message: "POLL_MS must be at least 100ms to avoid overwhelming the RPC",
  }),

  // Reorg lookback is bounded to the scheduling interval plus supported depth.
  REORG_CHECK_INTERVAL: positiveInt(100),

  REORG_MAX_DEPTH: positiveInt(100),

  EXPLORER_CONTRACT_ID: z.string().optional(),

  // ── DEX / Lending Protocol Integrations ─────────────────────────────────────
  STELLARSWAP_CONTRACT_ID: z.string().optional(),

  BLEND_CONTRACT_ID: z.string().optional(),

  API_KEY: z.string().optional(),

  CORS_ORIGINS: z.string().default("*"),

  // ── GitHub ABI Sync ─────────────────────────────────────────────────────────
  GITHUB_TOKEN: z.string().optional(),

  ABI_REPO: z.string().default("Soroban-Smart-Block-Explorer/verified-abis"),

  ABI_PATH: z.string().default("contracts"),

  ABI_SYNC_CRON: cronExpression("*/10 * * * *"),

  // ── Built-in ABI Seeding ────────────────────────────────────────────────────
  // Seeds the ABIs shipped in indexer/src/abis/ (e.g. StellarSwap, Blend) into
  // the contracts table on startup, so the explorer decodes their events out of
  // the box on a fresh database.
  SEED_BUILTIN_ABIS: booleanWithDefault(true),

  // ── Gas Guzzlers ────────────────────────────────────────────────────────────
  GAS_GUZZLERS_INTERVAL_MS: positiveInt(3600000).refine((val) => val >= 60000, {
    message: "GAS_GUZZLERS_INTERVAL_MS must be at least 60000ms (1 minute)",
  }),

  // ── Bloat Detection ─────────────────────────────────────────────────────────
  BLOAT_THRESHOLD: positiveInt(50),

  // ── Metadata Cache ──────────────────────────────────────────────────────────
  METADATA_CACHE_TTL: positiveInt(300),

  // ── Simulation ──────────────────────────────────────────────────────────────
  SIMULATE_SOURCE: z.string().optional(),

  // ── SAC Assets ──────────────────────────────────────────────────────────────
  SAC_ASSETS: commaSeparatedList(),

  // ── Verification ────────────────────────────────────────────────────────────
  VERIFY_ON_UPLOAD: booleanWithDefault(true),

  // ── Redis ───────────────────────────────────────────────────────────────────
  REDIS_URL: optionalUrl(),

  // ── Cache Configuration ─────────────────────────────────────────────────────
  CACHE_L1_MAX: positiveInt(2000),

  CACHE_XFETCH_BETA: positiveNumber(1.0),

  // ── Alert Manager ───────────────────────────────────────────────────────────
  ALERT_GAP_THRESHOLD: positiveInt(3),

  ALERT_DLQ_MAX_SIZE: positiveInt(100),

  ALERT_MIN_THROUGHPUT: positiveNumber(1),

  ALERT_MAX_HEAP_MB: positiveInt(512),

  ALERT_INDEXER_STALL_MS: positiveInt(30000),

  ALERT_MIN_DECODE_RATE: z
    .string()
    .optional()
    .transform((val) => (val ? parseFloat(val) : 0.7))
    .refine((val) => !isNaN(val) && val > 0 && val <= 1, {
      message: "ALERT_MIN_DECODE_RATE must be a number between 0 (exclusive) and 1 (inclusive)",
    }),

  PAGERDUTY_INTEGRATION_KEY: z.string().optional(),

  // ── Dead Letter Queue ───────────────────────────────────────────────────────
  DLQ_MAX_RETRIES: positiveInt(3),

  DLQ_RETRY_DELAY_MS: positiveInt(30000),

  // ── Leader Election ─────────────────────────────────────────────────────────
  LEADER_ELECTION_KEY: z.string().default("soroban-indexer:leader"),

  LEADER_LEASE_TTL_S: positiveInt(10),

  LEADER_RENEW_INTERVAL_MS: positiveInt(4000),

  LEADER_ELECTION_POLL_MS: positiveInt(5000),

  // ── Kafka Event Bus ─────────────────────────────────────────────────────────
  KAFKA_BROKERS: z.string().optional(),

  KAFKA_BUS_DEDUP_TTL_S: positiveInt(604800), // 7 days

  KAFKA_BUS_EVENT_TTL_S: positiveInt(604800), // 7 days

  // ── RPC Provider Pool ───────────────────────────────────────────────────────
  RPC_HEALTH_WINDOW: positiveInt(20),

  RPC_CALL_TIMEOUT_MS: positiveInt(10000),

  RPC_RECOVERY_INTERVAL_MS: positiveInt(15000),

  RPC_LAG_THRESHOLD: positiveInt(5),

  // ── RPC Metrics ─────────────────────────────────────────────────────────────
  METRICS_PROBE_INTERVAL_MS: positiveInt(15000),

  METRICS_MAX_SAMPLES: positiveInt(120),

  // ── Pruner ──────────────────────────────────────────────────────────────────
  PRUNE_CRON: cronExpression("0 2 * * *"),

  PRUNE_LEDGER_BUFFER: positiveInt(1000),

  MAX_TEMP_TTL_LEDGERS: positiveInt(1382400),

  // ── Predictive Gap Detector ─────────────────────────────────────────────────
  PREDICTIVE_GAP_THRESHOLD: positiveInt(3),

  PREDICTIVE_HISTORY_SIZE: positiveInt(50),

  // ── API Authentication & Rate Limiting ──────────────────────────────────────
  ADMIN_SECRET: z.string().optional(),

  // Optional base32 TOTP secret; when set, /api/admin/* also requires X-Admin-TOTP
  ADMIN_TOTP_SECRET: z.string().optional(),

  RATE_LIMIT_CONFIG: z.string().optional(),

  GEO_BLOCK_LIST: commaSeparatedList(),

  GEO_RATE_MULTIPLIERS: z.string().optional(),

  GEOIP_DB_PATH: z.string().optional(),

  // ── Stripe ──────────────────────────────────────────────────────────────────
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),

  // ── Cloudflare ──────────────────────────────────────────────────────────────
  CLOUDFLARE_WEBHOOK_URL: optionalUrl(),

  // ── GraphQL Security ────────────────────────────────────────────────────────
  MAX_GRAPHQL_DEPTH: positiveInt(4).refine((val) => val >= 1 && val <= 20, {
    message: "MAX_GRAPHQL_DEPTH must be between 1 and 20",
  }),

  MAX_GRAPHQL_COMPLEXITY: positiveInt(1000).refine((val) => val >= 100 && val <= 100000, {
    message: "MAX_GRAPHQL_COMPLEXITY must be between 100 and 100000",
  }),
}).superRefine((val, ctx) => {
  // requireApiKey() in api.js fails OPEN (allows the request through) when
  // API_KEY is unset, so an unset API_KEY in production silently disables
  // auth on every write route (/api/contracts, /api/verify, /api/simulate,
  // /api/sandbox/simulate, /api/auth-tree, source-verifications). Fail fast
  // at startup instead of failing open at request time.
  if (process.env.NODE_ENV === "production" && !val.API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["API_KEY"],
      message: "API_KEY is required when NODE_ENV=production (write routes fail open without it)",
    });
  }
});

// ── Validate and Export Configuration ─────────────────────────────────────────
let config;

try {
  config = configSchema.parse(process.env);
  console.log("[config] ✓ Environment variables validated successfully");
} catch (error) {
  console.error("\n❌ Configuration Validation Error\n");
  console.error("Invalid environment variables detected. Please fix the following issues:\n");
  
  if (error instanceof z.ZodError) {
    error.issues.forEach((err, index) => {
      const path = err.path.join(".");
      const envVar = path || "unknown";
      const message = err.message;
      const receivedValue = process.env[envVar];
      
      console.error(`${index + 1}. ${envVar}`);
      console.error(`   Error: ${message}`);
      if (receivedValue !== undefined) {
        console.error(`   Received: "${receivedValue}"`);
      } else {
        console.error(`   Received: (not set)`);
      }
      console.error("");
    });
  } else {
    console.error(error);
  }
  
  console.error("Please check your .env file or environment variables and try again.\n");
  console.error("See .env.example for reference configuration.\n");
  
  process.exit(1);
}

export default config;
