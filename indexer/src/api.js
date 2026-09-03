import { logger } from "./logger.js";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { db as defaultDb, pool } from "./db.js";
import { analyzeSourceDependencies } from "./dependencyScanner.js";
import { fetchTokenMetadata } from "./sep41Metadata.js";
import { fetchWalletBalances, fetchAccountMeta, AccountNotFoundError } from "./horizonBalances.js";
import { attachWebSocketServer, getTransactionStatus, onTransactionStatus, offTransactionStatus } from "./wsEvents.js";
import { verifyAbi } from "./verify_abi.js";
import { getMetrics } from "./rpcMetrics.js";
import { getRpcNodeStatus, getProviderStats } from "./rpcMultiNode.js";
import { cacheHitTotal, cacheMissTotal, apiRequestDuration } from "./metrics.js";
import { tracer } from "./tracing.js";
import { context, propagation } from "@opentelemetry/api";
import { getUptimeHistory } from "./uptimeRecorder.js";
import { getDecodeStats } from "./decoder.js";
// ── Auth & Rate Limiting ──────────────────────────────────────────────────────
import { apiKeyAuthenticator } from "./auth/apiKeyAuth.js";
import { geoIpRateLimiter } from "./rateLimit/geoIpLimiter.js";
import { concurrentRequestLimiter } from "./rateLimit/concurrentLimiter.js";
import { tokenBucketMiddleware } from "./rateLimit/tokenBucket.js";
import { graphqlComplexityLimiter } from "./rateLimit/graphqlComplexity.js";
import { abuseDetector } from "./rateLimit/abuseDetector.js";
import { rateLimitHeaderWriter } from "./rateLimit/headers.js";
import { auditLoggerMiddleware, ensureAuditPartitions } from "./audit/auditLogger.js";
import registerAdminRoutes from "./routes/admin.js";
import registerWebhookRoutes from "./routes/webhooks.js";
import registerDashboardRoutes from "./routes/dashboard.js";
import { stripeWebhookRouter } from "./billing/stripeWebhook.js";
import { csrfTokenHandler, verifyCsrf } from "./csrf.js";
import {
  cacheInvalidate,
  cacheGet,
  cacheSet,
  generateETag,
  getTTL,
  recordCachedLatency,
  recordUncachedLatency,
  getAnalytics,
} from "./cacheLayer.js";
import { recordAccess, schedulePrefetch } from "./prefetchEngine.js";
import { attachGraphQL } from "./graphql.js";
import { requestContext } from "./logger.js";
import { runAllChecks } from "./doctor-lib.js";
import { registry } from "./metrics.js";
import pg from "pg";
import { getBurnAlerts } from "./burnDetector.js";
import { formatAmount } from "./formatAmount.js";
import { sendVerificationEmail, isConfigured } from "./emailService.js";
import { getHealthStatus, getLivenessStatus, getReadinessStatus } from "./health.js";
import { getActiveAlerts } from "./alertManager.js";
import { randomUUID } from "crypto";
import { resolveAsset } from "./horizonClient.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// ── AJV schema validator for POST /api/contracts ──────────────────────────────
// This validates the real ContractMeta shape stored via db.upsertContractMeta
// (id, name, description, functions[].{name,description,args}, registered_by,
// protocol_type, version, abi_version, min_ledger) — NOT the differently-shaped
// contractRegistry.schema.json (contractId/template), which is a separate
// schema for community-submitted custom ABI interpretations.
const _ajv = new Ajv({ allErrors: true, strict: false });
addFormats(_ajv);
const _postContractSchema = {
  type: "object",
  required: ["id", "name", "functions"],
  properties: {
    id: {
      type: "string",
      description: "Stellar contract address (C... strkey, 56 chars)",
      pattern: "^C[A-Z2-7]{55}$",
    },
    name: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: ["string", "null"], maxLength: 500 },
    registered_by: { type: ["string", "null"] },
    protocol_type: {
      type: ["string", "null"],
      enum: ["token", "dex", "lending", "nft", "bridge", "other", null],
    },
    version: { type: ["integer", "null"] },
    abi_version: { type: ["integer", "null"] },
    min_ledger: { type: ["integer", "null"] },
    functions: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          args: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "type"],
              properties: {
                name: { type: "string", minLength: 1 },
                type: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
};
const _validateContractPost = _ajv.compile(_postContractSchema);

function requestIdMiddleware(req, _res, next) {
  req.id = req.headers["x-request-id"] || randomUUID();
  // Echo the request id in responses so clients and tests can observe it.
  _res.setHeader && _res.setHeader("X-Request-Id", req.id);
  // Preserve incoming traceparent header if present
  const tp = req.headers["traceparent"];
  if (tp) _res.setHeader && _res.setHeader("traceparent", tp);
  // Run the rest of the request inside an AsyncLocalStorage context so every
  // logger.* call made while handling it — including deep in other modules —
  // automatically carries this request's ID (#756).
  requestContext.run({ requestId: req.id }, next);
}

// Root span per request (issue #755) — child spans created by db.query,
// cacheGet/cacheSet, and RPC calls nest under this via the AsyncHooksContextManager
// registered in tracing.js, so a full API → cache → DB trace shows up as one trace.
function tracingMiddleware(req, res, next) {
  const parentCtx = propagation.extract(context.active(), req.headers);
  context.with(parentCtx, () => {
    tracer.startActiveSpan(`${req.method} ${req.path}`, { attributes: { "http.method": req.method, "http.target": req.originalUrl } }, (span) => {
      res.on("finish", () => {
        span.setAttribute("http.status_code", res.statusCode);
        span.end();
      });
      next();
    });
  });
}

function createHttpLogger(logDestination) {
  return (req, res, next) => {
    res.on("finish", () => {
      const line = `[api] ${req.method} ${req.url} ${res.statusCode} ${req.id || ''}\n`;
      try {
        if (logDestination && typeof logDestination.write === "function") {
          logDestination.write(line);
        } else {
          logger.info(line.trim());
        }
      } catch (e) {
        logger.info(line.trim());
      }
    });
    next();
  };
}

function metricsMiddleware(req, res, next) {
  const endTimer = apiRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route && req.route.path ? req.route.path : req.path || req.url;
    endTimer({ method: req.method, route: String(route), status: String(res.statusCode) });
  });
  next();
}

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== apiKey) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Gates GET /api/metrics with a Bearer token when METRICS_API_KEY is set;
// unset (the default) leaves the scrape endpoint unauthenticated.
function requireMetricsApiKey(req, res, next) {
  const metricsKey = process.env.METRICS_API_KEY;
  if (!metricsKey) return next();
  const [scheme, token] = String(req.headers["authorization"] || "").split(" ");
  if (scheme !== "Bearer" || token !== metricsKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function parseTxHashes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((v) => String(v).split(",").map((hash) => hash.trim()).filter(Boolean));
  return String(value).split(",").map((hash) => hash.trim()).filter(Boolean);
}

function createSseStream(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
}

function sendSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── Cache middleware factory ──────────────────────────────────────────────────
// Creates an Express middleware that serves from L1/L2 cache on hit,
// intercepts res.json on miss to cache the response and attach headers.
function makeCache(cacheType, getKey) {
  return async (req, res, next) => {
    const key = getKey(req);
    const start = Date.now();

    const cached = await cacheGet(key, cacheType);
    if (cached !== null) {
      cacheHitTotal.inc({ cache: cacheType });
      const etag = generateETag(cached);
      if (req.headers["if-none-match"] === etag) {
        recordCachedLatency(Date.now() - start);
        return res.status(304).end();
      }
      const { l3 } = getTTL(cacheType);
      res.setHeader("Cache-Control", l3);
      res.setHeader("ETag", etag);
      res.setHeader("X-Cache", "HIT");
      recordCachedLatency(Date.now() - start);
      recordAccess(key);
      return res.json(cached);
    }
    cacheMissTotal.inc({ cache: cacheType });

    // Miss: intercept res.json to cache the successful response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const computeMs = Date.now() - start;
        const etag = generateETag(data);
        const { l3 } = getTTL(cacheType);
        res.setHeader("Cache-Control", l3);
        res.setHeader("ETag", etag);
        res.setHeader("X-Cache", "MISS");
        cacheSet(key, data, cacheType, computeMs).catch(() => {});
        recordUncachedLatency(computeMs);
        recordAccess(key);
      }
      return originalJson(data);
    };
    next();
  };
}

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

export function createApi({ logDestination, dbOverride } = {}) {
  // Allow callers (tests) to inject a fake DB implementation via `dbOverride`.
  const db = dbOverride || defaultDb;
  const runningUnderTest = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          connectSrc: ["'self'", "ws:"],
        },
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=()");
    next();
  });
  const isWildcard = process.env.CORS_ORIGINS === '*';
  const allowedOrigins = isWildcard
    ? []
    : process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
      : [];

  const corsOptionsDelegate = (req, callback) => {
    const corsOptions = {
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-API-Key', 'X-CSRF-Token'],
      maxAge: 86400,
    };

    if (isWildcard) {
      corsOptions.origin = '*';
      corsOptions.credentials = false;
    } else {
      const origin = req.header('Origin');
      const isAllowed = origin && allowedOrigins.includes(origin);
      corsOptions.origin = isAllowed ? true : false;
      if (isAllowed) {
        corsOptions.credentials = true;
      }
    }
    callback(null, corsOptions);
  };

  app.use(cors(corsOptionsDelegate));

  // Stripe webhook requires raw body — mount BEFORE express.json()
  app.use("/api/billing", stripeWebhookRouter);

  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(tracingMiddleware);
  app.use(createHttpLogger(logDestination));
  app.use(metricsMiddleware);

  // ── CSRF token endpoint ────────────────────────────────────────────────────
  // Must be registered BEFORE verifyCsrf so it is exempt from CSRF checking
  // (it is what issues the token in the first place).
  app.get("/api/csrf-token", csrfTokenHandler);

  // ── CSRF verification — applied globally to all state-changing methods ─────
  // Exemptions (handled inside verifyCsrf):
  //   • x-api-key header present (machine-to-machine)
  //   • WebSocket upgrade requests
  //   • GET / HEAD / OPTIONS (safe methods)
  app.use(verifyCsrf);

  // ── Auth & Rate Limiting Middleware Stack ─────────────────────────────────
  // Order matters: audit logger sets _startTime first, then auth resolves tier,
  // then geo/concurrent/bucket limiters enforce quotas, then headers are set.
  // Fire-and-forget: guarantees the current month's partition exists before
  // the 500ms flush loop's first tick, even when createApi() is invoked
  // directly (tests) rather than via index.js's startAuditPartitionCron().
  ensureAuditPartitions().catch((err) =>
    logger.error("[api] Startup audit partition check failed:", err.message),
  );
  app.use(auditLoggerMiddleware);
  app.use(apiKeyAuthenticator);
  app.use(geoIpRateLimiter);
  app.use(concurrentRequestLimiter);
  app.use(tokenBucketMiddleware);
  app.use(graphqlComplexityLimiter);
  app.use(abuseDetector);
  app.use(rateLimitHeaderWriter);

  // NOTE: generalLimiter superseded by tokenBucketMiddleware above.
  // Kept as fallback only if Redis is unavailable (tokenBucket fails open).
  // app.use(generalLimiter);

  // ── Admin routes (auth-gated) ─────────────────────────────────────────────
  app.use("/api/admin", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  registerAdminRoutes(app);

  // ── Self-service routes (auth-gated by req.rateContext.keyId) ────────────
  registerWebhookRoutes(app);
  registerDashboardRoutes(app);

  // ── API Documentation ────────────────────────────────────────────────────────
  const openApiPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/api/openapi.yaml");
  if (fs.existsSync(openApiPath)) {
    // Avoid dynamic imports during test runs which may resolve after Jest
    // tears down the environment and cause 'import after teardown' errors.
    // Detect test runs started by Jest (NODE_ENV may not always be set).
    const runningUnderTest = process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID;
    if (!runningUnderTest) {
      const yaml = fs.readFileSync(openApiPath, "utf8");
      import("yaml")
        .then(({ parse }) => {
          const spec = parse(yaml);
          app.use(
            "/api/docs",
            swaggerUi.serve,
            swaggerUi.setup(spec, {
              customCss: ".swagger-ui .topbar { display: none }",
            }),
          );
        })
        .catch(() => {});
    }
  }

  app.get("/api/openapi.yaml", (_req, res) => {
    if (fs.existsSync(openApiPath)) res.type("yaml").sendFile(openApiPath);
    else res.status(404).json({ error: "Not found" });
  });

  // ── Health check endpoints ──────────────────────────────────────────────

  // Comprehensive health check with dependency and active-alert status
  const healthHandler = async (_req, res) => {
    try {
      const health = await getHealthStatus();
      const statusCode = ["healthy", "degraded"].includes(health.status) ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (e) {
      const activeAlerts = getActiveAlerts();
      res.status(503).json({
        status: "unhealthy",
        error: e.message,
        timestamp: new Date().toISOString(),
        alerts: {
          active_count: activeAlerts.length,
          conditions: activeAlerts.map(({ condition }) => condition),
        },
      });
    }
  };

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // Public status page data (issue #758): current health + rolling uptime
  // history, backed by the periodic samples uptimeRecorder.js writes.
  app.get("/api/status/history", async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
      const history = await getUptimeHistory(days);
      res.json({ days, history });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public snapshot of the process-local alert manager.
  app.get("/api/alerts", (_req, res) => {
    const active = getActiveAlerts();
    res.json({ active, count: active.length });
  });

  // Liveness probe (Kubernetes-style)
  app.get("/health/live", (_req, res) => {
    res.json(getLivenessStatus());
  });

  // Readiness probe (Kubernetes-style)
  app.get("/health/ready", async (_req, res) => {
    try {
      const readiness = await getReadinessStatus();
      const statusCode = readiness.status === "ready" ? 200 : 503;
      res.status(statusCode).json(readiness);
    } catch (e) {
      res.status(503).json({
        status: "not_ready",
        error: e.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Prometheus metrics ────────────────────────────────────────────────────
  // Scraped by Prometheus or any OpenMetrics-compatible collector.
  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (e) {
      res.status(500).end(e.message);
    }
  });

  // API-prefixed alias, gated by an optional METRICS_API_KEY Bearer token.
  // Serves the same registry — eventsIngested, decodeLatency, rpcErrors,
  // dbPoolTotal/Idle/Waiting, decoder_success_total, decoder_failure_total,
  // dlq_depth, and the rest of ./metrics.js are all registered on it.
  app.get("/api/metrics", requireMetricsApiKey, async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (e) {
      res.status(500).end(e.message);
    }
  });

  // ── Existing endpoints ──────────────────────────────────────────────────────

  // GET /api/events?contract=&fn=&type=&after_seq=&limit=
  // Keyset (cursor) pagination — `after_seq` is the `next_cursor` value from
  // the previous page (omit for the first page). Responds with
  // { data: Event[], next_cursor: number|null } (#490).
  app.get(
    "/api/events",
    // Validate before the cache middleware so malformed params can never be
    // served a cached 200 (their cache key normalizes to the first page).
    (req, res, next) => {
      if (req.query.limit !== undefined) {
        const parsedLimit = Number(req.query.limit);
        if (isNaN(parsedLimit) || parsedLimit <= 0 || parsedLimit > 200) {
          return res.status(422).json({ error: "Invalid limit" });
        }
      }
      if (req.query.after_seq !== undefined) {
        const parsedAfter = Number(req.query.after_seq);
        if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
          return res.status(422).json({ error: "Invalid after_seq" });
        }
      }
      next();
    },
    makeCache("events_list", (req) => {
      const { contract = "", fn = "", type = "" } = req.query;
      const after = Number(req.query.after_seq) || 0;
      const limit = Number(req.query.limit) || 25;
      return `events:list:${contract}:${fn}:${after}:${limit}:${type}`;
    }),
    async (req, res) => {
      try {
        const contract = req.query.contract || undefined;
        const fn = req.query.fn || undefined;
        const type = req.query.type || undefined;
        const after_seq = req.query.after_seq ? Number(req.query.after_seq) : 0;
        const limit = req.query.limit ? Number(req.query.limit) : 25;

        const result = await db.getEventsCursor({ contract, fn, type, after_seq, limit });

        // Predictive pre-fetch: next page if user is paginating
        if (result.next_cursor !== null) {
          const key = `events:list:${contract ?? ""}:${fn ?? ""}:${after_seq}:${limit}:${type ?? ""}`;
          schedulePrefetch(key, {
            [`events:list:${contract ?? ""}:${fn ?? ""}:${result.next_cursor}:${limit}:${type ?? ""}`]: () =>
              db.getEventsCursor({ contract, fn, type, after_seq: result.next_cursor, limit }),
          });
        }
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/search?q=&limit=
  app.get(
    "/api/search",
    makeCache("search", (req) => {
      const { q = "", limit = "10" } = req.query;
      return `search:${String(q).toLowerCase()}:${limit}`;
    }),
    async (req, res) => {
      try {
        const query = typeof req.query.q === "string" ? req.query.q : "";
        const limit = Number(req.query.limit) || 10;
        if (!query.trim()) return res.status(400).json({ error: "Missing search query" });

        const [contracts, events, wallets, suggestions] = await Promise.all([
          db.searchContracts(query, { limit }),
          db.searchEvents(query, { limit }),
          db.searchWallets(query, { limit }),
          db.searchSuggestions(query, { limit }),
        ]);

        res.json({
          query,
          contracts,
          events,
          wallets,
          suggestions,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/events/:seq
  app.get(
    "/api/events/:seq",
    makeCache("events_single", (req) => `events:single:${req.params.seq}`),
    async (req, res) => {
      try {
        const ev = await db.getEvent(Number(req.params.seq));
        if (!ev) {
          return res.status(404).json({
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: `Event sequence ${req.params.seq} not found`
          });
        }
        res.json(ev);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/events/:seq/zk-costs
  // Returns the ZK host function call list and cost delta for a single event.
  app.get("/api/events/:seq/zk-costs", async (req, res) => {
    try {
      const ev = await db.getEvent(Number(req.params.seq));
      if (!ev) return res.status(404).json({ error: "Not found" });
      if (!ev.zk_host_calls) return res.json({ calls: [], delta: null });
      const zk = typeof ev.zk_host_calls === "string" ? JSON.parse(ev.zk_host_calls) : ev.zk_host_calls;
      res.json(zk);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Transaction status server-sent events endpoint
  app.get("/api/transactions/status", async (req, res) => {
    try {
      const txHashes = parseTxHashes(req.query.txHashes);
      if (txHashes.length === 0) {
        return res.status(400).json({ error: "txHashes query parameter is required" });
      }
      createSseStream(res);

      const listeners = new Map();
      const cleanup = () => {
        for (const listener of listeners.values()) {
          offTransactionStatus(listener);
        }
        res.end();
      };

      req.on("close", cleanup);

      for (const txHash of txHashes) {
        const initialStatus = getTransactionStatus(txHash);
        if (initialStatus) {
          sendSseEvent(res, initialStatus);
          if (initialStatus.status !== "pending") {
            continue;
          }
        } else {
          sendSseEvent(res, {
            tx_hash: txHash,
            status: "pending",
            ledger: null,
            error: null,
          });
        }

        const listener = (status) => {
          if (status.tx_hash !== txHash) return;
          sendSseEvent(res, status);
          if (status.status !== "pending") {
            offTransactionStatus(listener);
          }
        };
        listeners.set(txHash, listener);
        onTransactionStatus(listener);
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // single-transaction SSE stream (compat for frontend hook)
  app.get("/api/transactions/:hash/status/stream", async (req, res) => {
    try {
      const txHash = req.params.hash;
      createSseStream(res);

      const initialStatus = getTransactionStatus(txHash);
      if (initialStatus) {
        sendSseEvent(res, initialStatus);
        if (initialStatus.status !== "pending") {
          return res.end();
        }
      } else {
        sendSseEvent(res, {
          tx_hash: txHash,
          status: "pending",
          ledger: null,
          error: null,
        });
      }

      const listener = (status) => {
        if (status.tx_hash !== txHash) return;
        sendSseEvent(res, status);
        if (status.status !== "pending") {
          offTransactionStatus(listener);
          res.end();
        }
      };

      onTransactionStatus(listener);
      req.on("close", () => {
        offTransactionStatus(listener);
        res.end();
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Transaction status polling endpoint
  app.get("/api/transactions/:hash/status", async (req, res) => {
    try {
      const txHash = req.params.hash;
      const cached = getTransactionStatus(txHash);
      if (cached) return res.json(cached);

      const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
      const server = new SorobanRpc.Server(RPC_URL);
      const txResult = await server.getTransaction(txHash);
      const status = txResult?.status === "SUCCESS" ? "success" : txResult?.status === "FAILED" ? "failed" : "pending";
      const { extractFailureReason } = await import("./diagnosticParser.js");
      const payload = {
        tx_hash: txHash,
        status,
        ledger: txResult?.ledger ?? null,
        error: extractFailureReason(txResult),
      };
      res.json(payload);
    } catch (e) {
      if (e?.message?.includes("404") || e?.message?.includes("not found")) {
        return res.status(404).json({ error: "Not found" });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts?page=&limit=&type=  — paginated list of registered contracts
  app.get(
    "/api/contracts",
    makeCache("contracts_list", (req) => {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const q = req.query.q || "";
      const type = req.query.type || "all";
      return `contracts:list:${page}:${limit}:${q}:${type}`;
    }),
    async (req, res) => {
      try {
        const page = Number(req.query.page) || 1;
        const limit = Math.min(Number(req.query.limit) || 25, 100);
        const q = (req.query.q || "").trim();
        const type = (req.query.type || "all").toLowerCase();

        // Build dynamic query supporting optional search (q) and type filter
        const params = [];
        const conditions = [];

        if (q) {
          params.push(`%${q}%`);
          const idx = params.length;
          conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
        }

        if (type && type !== "all") {
          if (type === "verified") {
            // A contract is "verified" when it has at least one source verification
            conditions.push(
              `id IN (SELECT DISTINCT contract_id FROM source_verifications)`,
            );
          } else {
            // Match protocol_type column (may not exist on all installs — guard with COALESCE)
            params.push(type);
            conditions.push(`LOWER(COALESCE(protocol_type, '')) = $${params.length}`);
          }
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const offset = (page - 1) * limit;
        params.push(limit, offset);

        const [{ rows }, { rows: countRows }] = await Promise.all([
          db.query(
            `SELECT id, name, description, registered_by, has_circuit_breaker, is_paused, is_rwa, rwa_type,
                    protocol_type, created_at
             FROM contracts ${where}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
          ),
          db.query(
            `SELECT COUNT(*)::INT AS total FROM contracts ${where}`,
            params.slice(0, params.length - 2),
          ),
        ]);

        const total = countRows[0].total;
        res.json({
          contracts: rows,
          pagination: {
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
          },
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/contracts/:id/abi-history — ABI version history for a contract
  // Returns all ABI snapshots ordered by version ascending: [{ abi_version, functions, min_ledger, created_at }, ...]
  app.get("/api/contracts/:id/abi-history", async (req, res) => {
    try {
      const history = await db.getContractAbiHistory(req.params.id);
      res.json({ contract_id: req.params.id, history });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts/:id/events?page=&limit=  — events for a specific contract
  app.get(
    "/api/contracts/:id/events",
    makeCache("contract_events", (req) => `contracts:events:${req.params.id}:${req.query.page ?? 1}:${req.query.limit ?? 25}`),
    async (req, res) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      const rows = await db.getEvents({
        contract: req.params.id,
        page,
        limit,
      });
      const total = rows.length; // best-effort; full count would need a second query
      res.json({
        events: rows,
        pagination: {
          page,
          limit,
          total,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
  );

  // GET /api/contracts/:id
  app.get(
    "/api/contracts/:id",
    makeCache("contracts_single", (req) => `contracts:single:${req.params.id}`),
    async (req, res) => {
      try {
        const meta = await db.getContractMeta(req.params.id);
        if (!meta) return res.status(404).json({ error: "Not found" });

        const sourceFiles = Array.isArray(meta.source_files)
          ? meta.source_files
          : meta.source_files
            ? JSON.parse(meta.source_files)
            : [];

        const advisory = await analyzeSourceDependencies(sourceFiles);
        res.json({ ...meta, dependency_advisory: advisory });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );



  // GET /api/contracts/:id/build-metadata — WASM build metadata (compiler, SDK, repo link)
  app.get("/api/contracts/:id/build-metadata", async (req, res) => {
    try {
      const meta = await db.getWasmBuildMetadata(req.params.id);
      if (!meta) return res.status(404).json({ error: "No build metadata found for this contract" });
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts/:id/wasm — WASM build metadata panel (hash, compiler, SDK, size)
  app.get("/api/contracts/:id/wasm", async (req, res) => {
    try {
      const meta = await db.getWasmBuildMetadata(req.params.id);
      if (!meta) return res.status(404).json({ error: "WASM not indexed" });
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts/:id/abi — download standardized ABI JSON
  app.get("/api/contracts/:id/abi", async (req, res) => {
    try {
      const { fetchContractSpec } = await import("./verify_abi.js");
      const meta = await db.getContractMeta(req.params.id);
      const spec = await fetchContractSpec(req.params.id);
      const abi = {
        contractId: req.params.id,
        name: meta?.name || "",
        description: meta?.description || "",
        functions: (spec || []).map((fn) => {
          const registered = meta?.functions?.find((f) => f.name === fn.name);
          return {
            name: fn.name,
            description: registered?.description || "",
            args: fn.args.map((a) => ({ name: a.name, type: a.type })),
          };
        }),
      };
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.abi.json"`);
      res.json(abi);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts/:id/spec-full — fetch full on-chain spec including custom types
  app.get("/api/contracts/:id/spec-full", async (req, res) => {
    try {
      const { fetchContractSpecFull } = await import("./verify_abi.js");
      const spec = await fetchContractSpecFull(req.params.id);
      if (spec === null) {
        return res.status(404).json({ error: "Contract not found or has no WASM spec" });
      }
      res.json(spec);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/contracts  — register ABI metadata
  app.post("/api/contracts", writeLimiter, requireApiKey, async (req, res) => {
    try {
      // ── Issue #522: AJV schema validation ────────────────────────────────
      const valid = _validateContractPost(req.body);
      if (!valid) {
        const errors = (_validateContractPost.errors ?? []).map((e) => ({
          path: e.instancePath || `/${e.params?.missingProperty ?? ""}`,
          message: e.message ?? "invalid",
        }));
        return res.status(400).json({ errors });
      }

      const { id, functions } = req.body;

      const existing = await db.getContractMeta(id);
      if (existing) {
        return res.status(409).json({ error: "Contract already exists" });
      }

      // Verify ABI against on-chain spec if enabled
      if (process.env.VERIFY_ABI !== "false") {
        const verification = await verifyAbi(id, functions);

        if (!verification.valid) {
          return res.status(400).json({
            error: "ABI verification failed",
            details: verification,
          });
        }

        logger.info(`ABI verified for contract ${id}:`, {
          functionsVerified: functions.length,
          missing: verification.missingFunctions.length,
          mismatches: verification.argMismatch.length,
        });
      }

      await db.upsertContractMeta(req.body);
      // ── Issue #523: store the registrant's API key ID for ownership checks
      const keyId = req.rateContext?.keyId ?? null;
      if (keyId) {
        await db.query(
          "UPDATE contracts SET registered_by_key_id = $1 WHERE id = $2",
          [keyId, id],
        ).catch(() => {});
      }
      await cacheInvalidate(`contracts:single:${id}`);
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/contracts/:id  — update ABI metadata (issue #523: ownership check)
  app.patch("/api/contracts/:id", writeLimiter, async (req, res) => {
    try {
      // Must be authenticated. The static admin key (API_KEY env var) is
      // recognized by apiKeyAuthenticator with tier "enterprise" but no DB
      // row, so keyId is null for it too — check tier, not just keyId,
      // otherwise the admin key would be rejected here before ever reaching
      // the isAdmin check below.
      const keyId = req.rateContext?.keyId ?? null;
      const isUnauthenticated = !req.rateContext || req.rateContext.tier === "unauthenticated";
      if (isUnauthenticated) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const contractId = req.params.id;
      const existing = await db.getContractMeta(contractId);
      if (!existing) {
        return res.status(404).json({ error: "Contract not found" });
      }

      // ── Ownership / admin check ──────────────────────────────────────────
      // Fetch the stored registered_by_key_id
      const { rows } = await db.query(
        "SELECT registered_by_key_id FROM contracts WHERE id = $1",
        [contractId],
      );
      const registeredByKeyId = rows[0]?.registered_by_key_id ?? null;

      // Check if caller is admin (tier = 'enterprise' or static admin key)
      const isAdmin =
        req.rateContext?.tier === "enterprise" ||
        req.rateContext?.clientId === "static-admin-key";

      if (!isAdmin && registeredByKeyId !== null && String(registeredByKeyId) !== String(keyId)) {
        return res.status(403).json({ error: "Forbidden: you are not the owner of this contract" });
      }

      // ── Schema validation on the patch payload ───────────────────────────
      const updateBody = { ...existing, ...req.body, id: contractId };
      const valid = _validateContractPost(updateBody);
      if (!valid) {
        const errors = (_validateContractPost.errors ?? []).map((e) => ({
          path: e.instancePath || `/${e.params?.missingProperty ?? ""}`,
          message: e.message ?? "invalid",
        }));
        return res.status(400).json({ errors });
      }

      await db.upsertContractMeta(updateBody);
      await cacheInvalidate(`contracts:single:${contractId}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/verify — verify ABI without registering
  app.post("/api/verify", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { contractId, functions } = req.body;

      if (!contractId || !functions) {
        return res.status(400).json({ error: "Missing contractId or functions" });
      }

      const verification = await verifyAbi(contractId, functions);
      res.json(verification);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/spec/:id — fetch on-chain spec for a contract (functions only, legacy)
  app.get("/api/spec/:id", async (req, res) => {
    try {
      const { fetchContractSpec } = await import("./verify_abi.js");
      const spec = await fetchContractSpec(req.params.id);
      if (spec === null) {
        return res.status(404).json({ error: "Contract not found or has no spec" });
      }
      res.json(spec);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/spec/:id/full — fetch full on-chain spec including custom types
  // Returns { functions: [...], types: [...] } where types includes structs,
  // enums, unions, and error_enums parsed from the contract WASM binary.
  app.get("/api/spec/:id/full", async (req, res) => {
    try {
      const { fetchContractSpecFull } = await import("./verify_abi.js");
      const spec = await fetchContractSpecFull(req.params.id);
      if (spec === null) {
        return res.status(404).json({ error: "Contract not found or has no WASM spec" });
      }
      res.json(spec);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/simulate — issue #46: simulate a contract call via RPC
  app.post("/api/simulate", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { contractId, fn, args = [] } = req.body;
      if (!contractId || !fn) return res.status(400).json({ error: "Missing contractId or fn" });

      const { rpc: SorobanRpc, Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
      const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const server = new SorobanRpc.Server(rpcUrl);

      const contract = new Contract(contractId);
      const scArgs = args.map((a) => nativeToScVal(a));
      const op = contract.call(fn, ...scArgs);

      const account = await server.getAccount(
        process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      );
      const { TransactionBuilder, Networks, BASE_FEE } = await import("@stellar/stellar-sdk");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(sim)) {
        return res.json({ success: false, error: sim.error });
      }

      const cost = sim.cost ?? {};
      const retVal = sim.result?.retval;
      res.json({
        success: true,
        returnValue: retVal ? retVal.toXDR("base64") : undefined,
        cost: {
          cpuInsns: String(cost.cpuInsns ?? 0),
          memBytes: String(cost.memBytes ?? 0),
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Sandbox CRUD (persisted via DB) ─────────────────────────────────────────
  app.post("/api/sandbox", async (req, res) => {
    try {
      const { sandboxId, templateId, files, metadata } = req.body;
      if (!sandboxId || !templateId) return res.status(400).json({ error: "Missing sandboxId or templateId" });
      await db.query(
        `INSERT INTO sandboxes (sandbox_id, template_id, files, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sandbox_id) DO UPDATE SET files=$3, metadata=$4, updated_at=NOW()`,
        [sandboxId, templateId, JSON.stringify(files), JSON.stringify(metadata ?? {})],
      );
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sandbox/:id", async (req, res) => {
    try {
      const { rows } = await db.query("SELECT * FROM sandboxes WHERE sandbox_id = $1", [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "Not found" });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/sandbox/:id", async (req, res) => {
    try {
      await db.query("DELETE FROM sandboxes WHERE sandbox_id = $1", [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sandboxes", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Number(req.query.offset) || 0;
      const { rows } = await db.query(
        `SELECT sandbox_id, template_id, metadata, created_at, updated_at
         FROM sandboxes ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const { rows: countRows } = await db.query("SELECT COUNT(*)::INT AS total FROM sandboxes");
      res.json({ sandboxes: rows, total: countRows[0].total });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/sandbox/simulate — accepts a raw XDR TransactionEnvelope, simulates it directly
  app.post("/api/sandbox/simulate", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { xdrEnvelope } = req.body;
      if (!xdrEnvelope) return res.status(400).json({ error: "Missing xdrEnvelope" });

      const { rpc: SorobanRpc, xdr } = await import("@stellar/stellar-sdk");
      const server = new SorobanRpc.Server(RPC_URL);

      const envelope = xdr.TransactionEnvelope.fromXDR(xdrEnvelope, "base64");
      const sim = await server.simulateTransaction({
        toEnvelope: () => envelope,
      });

      if (SorobanRpc.Api.isSimulationError(sim)) {
        return res.json({ success: false, error: sim.error });
      }

      const cost = sim.cost ?? {};
      const retVal = sim.result?.retval;
      res.json({
        success: true,
        returnValue: retVal ? retVal.toXDR("base64") : undefined,
        cost: {
          cpuInsns: String(cost.cpuInsns ?? 0),
          memBytes: String(cost.memBytes ?? 0),
        },
        minResourceFee: sim.minResourceFee ?? null,
        latestLedger: sim.latestLedger ?? null,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET /api/wallet/:address — events involving a Stellar/Soroban wallet.
  // Returns 200 with { events: [...], horizon_account } (empty array for an
  // unknown address) and 400 when the address is not a well-formed Stellar
  // public key (G... base32). horizon_account is { sequence, subentry_count,
  // home_domain }, fetched from Horizon concurrently with the DB query (#551).
  // Horizon 404 (unfunded account) or any Horizon failure yields
  // horizon_account: null rather than a 500 — the wallet response never
  // depends on Horizon being reachable.
  // Cached for 60s (issue #534) — cache busted by index.js via
  // cacheInvalidate("wallet:events:*") on new events.
  app.get(
    "/api/wallet/:address",
    makeCache("wallet", (req) => `wallet:events:${req.params.address}`),
    async (req, res) => {
    try {
      const address = req.params.address;
      if (!/^[GMC][A-Z2-7]{55,}$/.test(address)) {
        return res.status(400).json({ error: `${address} is not a valid Stellar address` });
      }
      // #527: accept optional from/to date filters (YYYY-MM-DD)
      const from = req.query.from || undefined;
      const to = req.query.to || undefined;
      const [eventsResult, horizonResult] = await Promise.allSettled([
        db.getWalletEvents(address, { from, to }),
        fetchAccountMeta(address),
      ]);
      // A DB failure is a real error (500); a Horizon failure just degrades
      // horizon_account to null — the two have different reliability contracts.
      if (eventsResult.status === "rejected") throw eventsResult.reason;
      const horizon_account = horizonResult.status === "fulfilled" ? horizonResult.value : null;
      res.json({ events: eventsResult.value, horizon_account });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/wallet/:address/balances — classic XLM + SEP-41/classic asset
  // balances sourced from Horizon (issue #530). Cached for 30s per address.
  app.get(
    "/api/wallet/:address/balances",
    makeCache("wallet_balances", (req) => `wallet:balances:${req.params.address}`),
    async (req, res) => {
    try {
      const address = req.params.address;
      if (!/^G[A-Z2-7]{55}$/.test(address)) {
        return res.status(400).json({ error: "Invalid wallet address format" });
      }
      const balances = await fetchWalletBalances(address);
      res.json({ balances });
    } catch (e) {
      if (e instanceof AccountNotFoundError) {
        return res.status(404).json({ error: "Account not found on network" });
      }
      res.status(502).json({ error: e.message });
    }
  },
  );

  // ── Token metadata registry (#550) ──────────────────────────────────────
  // Backed by the `assets` table, populated as classic asset transfers are
  // decoded (see decoder.js's classicAssetLabel).

  function serializeAsset(row) {
    return {
      code: row.code,
      issuer: row.issuer,
      name: row.name,
      decimals: row.decimals,
      logo_url: row.logo_url,
      home_domain: row.domain,
    };
  }

  // GET /api/assets?after=&limit=  — paginated list of all assets seen in
  // indexed events, cursor-based (keyset) navigation via `next_cursor`.
  app.get(
    "/api/assets",
    makeCache("default", (req) => `assets:list:${req.query.after ?? 0}:${req.query.limit ?? 25}`),
    async (req, res) => {
    try {
      if (req.query.limit !== undefined) {
        const parsedLimit = Number(req.query.limit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
          return res.status(422).json({ error: "Invalid limit" });
        }
      }
      if (req.query.after !== undefined) {
        const parsedAfter = Number(req.query.after);
        if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
          return res.status(422).json({ error: "Invalid after" });
        }
      }

      const limit = req.query.limit ? Number(req.query.limit) : 25;
      const after = req.query.after ? Number(req.query.after) : 0;

      const { data, next_cursor } = await db.listAssets({ after_id: after, limit });
      res.json({ data: data.map(serializeAsset), next_cursor });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/assets/:issuer/:code — single asset metadata.
  app.get("/api/assets/:issuer/:code", async (req, res) => {
    try {
      const { issuer, code } = req.params;
      const asset = await db.getAsset(code, issuer);
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      res.json(serializeAsset(asset));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tokens/:id/holders — sorted list of addresses and their token balances
  app.get("/api/tokens/:id/holders", async (req, res) => {
    try {
      const contractId = req.params.id;
      let decimals = 7;
      try {
        const meta = await fetchTokenMetadata(contractId);
        decimals = meta.decimals;
      } catch {
        /* use default */
      }

      const rows = await db.getTokenHolders(contractId);
      const holders = rows.map((r) => ({
        address: r.address,
        balance_raw: r.balance_raw,
        balance: formatAmount(r.balance_raw, decimals),
      }));

      res.json({
        contract_id: contractId,
        decimals,
        total_holders: holders.length,
        holders,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tokens/:id/volume  — 24-hour rolling transfer volume
  app.get("/api/tokens/:id/volume", async (req, res) => {
    try {
      const contractId = req.params.id;
      // Fetch decimals from on-chain metadata (cached via contract registry or live sim)
      let decimals = 7;
      try {
        const meta = await fetchTokenMetadata(contractId);
        decimals = meta.decimals;
      } catch {
        /* use default */
      }

      const volume = await db.get24hVolume(contractId, decimals);
      res.json({ contract_id: contractId, window: "24h", ...volume });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── NFT endpoints ────────────────────────────────────────────────

  // GET /api/tokens/:contractId/nfts
  // Cursor-based (keyset) pagination:
  //   ?owner=<address>  — filter to tokens owned by this address
  //   &limit=<n>        — results per page, max 200 (default 50)
  //   &after=<token_id> — opaque cursor from previous page's `next_cursor`
  //                       (omit for the first page)
  //
  // Page-based pagination (legacy):
  //   &page=<n>         — 1-indexed page number (default 1)
  //
  // Per issue #650, returns { token_id, owner_address, minted_ledger,
  // minted_by, last_transfer_ledger } per item with cursor-based navigation.
  app.get("/api/tokens/:contractId/nfts", async (req, res) => {
    try {
      const { contractId } = req.params;
      const owner = req.query.owner || undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;

      // Validate limit
      if (isNaN(limit) || limit < 1 || limit > 200) {
        return res.status(422).json({ error: "Invalid limit" });
      }

      // Validate after (must be a valid numeric string if provided)
      if (req.query.after !== undefined && (isNaN(Number(req.query.after)) || String(req.query.after).trim() === "")) {
        return res.status(422).json({ error: "Invalid after" });
      }

      // Cursor-based pagination (issue #650) — default unless page param is explicitly provided
      if (req.query.page === undefined) {
        const after = req.query.after || undefined;

        const { tokens, next_cursor } = await db.getNftTokensCursor(contractId, {
          owner,
          after,
          limit,
        });

        res.json({
          contract_id: contractId,
          tokens,
          next_cursor,
        });
      } else {
        // Legacy page-based pagination (backward compatible)
        const page = req.query.page ? Number(req.query.page) : 1;

        if (isNaN(page) || page < 1) {
          return res.status(422).json({ error: "Invalid page" });
        }

        const { tokens, total } = await db.getNftTokens(contractId, { owner, page, limit });

        const totalPages = Math.ceil(total / limit);
        res.json({
          contract_id: contractId,
          tokens,
          pagination: {
            page,
            limit,
            total,
            total_pages: totalPages,
            has_next: page < totalPages,
          },
        });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tokens/:contractId/nfts/analytics
  //   Collection-level analytics (issue #810): mint volume over time and a
  //   unique-holder-count trend, derived from indexed NFT mint/transfer events.
  //   ?days=<n> — rolling window length, default 30, clamped 7..365.
  app.get("/api/tokens/:contractId/nfts/analytics", async (req, res) => {
    try {
      const { contractId } = req.params;
      const days = req.query.days !== undefined ? Number(req.query.days) : 30;
      if (isNaN(days) || days < 1 || days > 365) {
        return res.status(422).json({ error: "Invalid days" });
      }
      const analytics = await db.getNftCollectionAnalytics(contractId, days);
      res.json(analytics);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tokens/:contractId/nfts/:tokenId/history
  //   Returns the full mint + transfer event history for a single NFT token.
  app.get("/api/tokens/:contractId/nfts/:tokenId/history", async (req, res) => {
    try {
      const { contractId, tokenId } = req.params;
      const events = await db.getNftTokenHistory(contractId, tokenId);
      res.json({ contract_id: contractId, token_id: tokenId, events });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── cursor-based pagination endpoint ────────────────────────────
  // GET /api/v1/events?contract=&fn=&type=&after=&limit=
  // `after` is the opaque seq cursor returned as `next_cursor` in the previous page.
  app.get("/api/v1/events", async (req, res) => {
    try {
      if (req.query.limit !== undefined) {
        const parsedLimit = Number(req.query.limit);
        if (isNaN(parsedLimit) || parsedLimit <= 0 || parsedLimit > 200) {
          return res.status(422).json({ error: "Invalid limit" });
        }
      }

      const result = await db.getEventsCursor({
        contract: req.query.contract || undefined,
        fn: req.query.fn || undefined,
        type: req.query.type || undefined,
        after_seq: req.query.after ? Number(req.query.after) : 0,
        limit: req.query.limit ? Number(req.query.limit) : 25,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Contract transaction history ─────────────────────────────────
  // GET /api/v1/contracts/:id/transactions?function_name=&start_ledger=&end_ledger=&page=&limit=
  app.get("/api/v1/contracts/:id/transactions", async (req, res) => {
    try {
      const { function_name, start_ledger, end_ledger, page, limit } = req.query;
      const result = await db.getContractTransactions(req.params.id, {
        function_name: function_name || undefined,
        start_ledger: start_ledger ? Number(start_ledger) : undefined,
        end_ledger: end_ledger ? Number(end_ledger) : undefined,
        page: page ? Number(page) : 1,
        limit: limit ? Math.min(Number(limit), 100) : 25,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/contracts/:id/upgrades — contract WASM upgrade lineage ────────
  app.get("/api/contracts/:id/upgrades", async (req, res) => {
    try {
      const rows = await db.getUpgradeHistory(req.params.id);
      res.json(
        rows.map((r) => ({
          ledger: Number(r.ledger),
          old_hash: r.upgrade_info?.oldHash ?? null,
          new_hash: r.upgrade_info?.newHash ?? null,
          tx_hash: r.tx_hash,
          timestamp: r.created_at,
        })),
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/contracts/:id/migration-status — SEP-49 migration tracker
  app.get("/api/contracts/:id/migration-status", async (req, res) => {
    try {
      const status = await db.getMigrationStatus(req.params.id);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Circuit breaker status endpoint ──────────────────────────────
  // GET /api/contracts/:id/circuit-breaker — detect and return pause status
  app.get("/api/contracts/:id/circuit-breaker", async (req, res) => {
    try {
      const status = await db.getCircuitBreakerStatus(req.params.id);
      res.json(status);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Sub-invocation call graph ─────────────────────────────────────
  // GET /api/contracts/:id/call-graph — top callee contracts by call frequency
  app.get("/api/contracts/:id/call-graph", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const edges = await db.getContractCallGraph(req.params.id, limit);
      const nodes = edges.length
        ? [
            { id: req.params.id, label: req.params.id, type: "contract" },
            ...edges.map((e) => ({ id: e.callee, label: e.callee, type: "contract" })),
          ]
        : [];
      res.json({
        nodes,
        edges: edges.map((e) => ({
          source: req.params.id,
          target: e.callee,
          label: `${e.call_count} call${e.call_count === 1 ? "" : "s"}`,
          call_count: e.call_count,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── RWA token activity endpoint ──────────────────────────────────
  // GET /api/contracts/:id/rwa-metadata — get RWA-specific metadata
  app.get("/api/contracts/:id/rwa-metadata", async (req, res) => {
    try {
      const meta = await db.getContractMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "Not found" });

      const rwaInfo = {
        is_rwa: meta.is_rwa ?? false,
        rwa_type: meta.rwa_type ?? null,
      };
      res.json(rwaInfo);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/auth-tree — parse multi-sig ContractAuth trees ───────────────
  // Body: { auth: string[] }  — array of base64 SorobanAuthorizationEntry XDRs
  // Returns: ordered array of { signer, invocations: [{ depth, scope }] }
  app.post("/api/auth-tree", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { auth } = req.body;
      if (!Array.isArray(auth)) return res.status(400).json({ error: "auth must be an array" });
      const { parseAuthTree } = await import("./authTreeParser.js");
      res.json(parseAuthTree(auth));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── GET /api/burn-alerts?contract= — suspicious burn sequence alerts ────────
  // Returns alerts flagged by burnDetector for rapid supply contraction.
  app.get("/api/burn-alerts", (req, res) => {
    try {
      const alerts = getBurnAlerts(req.query.contract || undefined);
      res.json(alerts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Self-Service API Key Creation with Email Verification ─────────────────────
  
  // POST /api/keys (unauthenticated) - Create an inactive API key and send verification email
  app.post("/api/keys", async (req, res) => {
    try {
      const { name, email } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'name is required and must be a non-empty string' });
      }
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'email is required and must be a valid email address' });
      }

      // Check if email service is configured
      if (!isConfigured()) {
        return res.status(503).json({ error: 'Email service not configured. Contact administrator.' });
      }

      // Import crypto and bcrypt for key generation
      const crypto = (await import('crypto')).default;
      const bcrypt = (await import('bcryptjs')).default;

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Generate API key
      const rawKey = crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const keyPrefix = rawKey.slice(0, 8);
      const keyHash = await bcrypt.hash(rawKey, 12);

      // Insert inactive key with verification data
      const { rows } = await pool.query(
        `INSERT INTO api_keys
           (name, email, key_hash, key_prefix, tier, verified, verification_token, verification_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, email, key_prefix, tier, verified, created_at`,
        [name.trim(), email.trim().toLowerCase(), keyHash, keyPrefix, 'free', false, verificationToken, verificationExpiresAt]
      );

      // Build verification URL
      const baseUrl = process.env.API_BASE_URL || `http://localhost:${PORT}`;
      const verificationUrl = `${baseUrl}/api/keys/verify?token=${verificationToken}`;

      // Send verification email
      await sendVerificationEmail({
        email: email.trim(),
        keyName: name.trim(),
        verificationUrl
      });

      // Return success message (do NOT return the key or verification token)
      res.status(201).json({
        message: 'API key created successfully. Please check your email to verify and activate your key.',
        keyId: rows[0].id,
        keyPrefix: rows[0].key_prefix,
        email: rows[0].email,
        verified: rows[0].verified
      });
    } catch (e) {
      logger.error('[POST /api/keys] Error:', e);
      if (e.message.includes('duplicate key') || e.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'An API key for this email already exists and is pending verification.' });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/keys/verify?token= - Verify email and activate the key, return the full key once
  app.get("/api/keys/verify", async (req, res) => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'token is required' });
      }

      // Look up the key by verification token
      const { rows } = await pool.query(
        `SELECT id, name, email, key_hash, key_prefix, tier, verified, verification_expires_at
         FROM api_keys
         WHERE verification_token = $1`,
        [token]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Invalid verification token' });
      }

      const keyRecord = rows[0];

      // Check if already verified
      if (keyRecord.verified) {
        return res.status(400).json({ error: 'This API key has already been verified' });
      }

      // Check if token has expired
      if (new Date(keyRecord.verification_expires_at) < new Date()) {
        return res.status(400).json({ error: 'Verification token has expired. Please request a new API key.' });
      }

      // Activate the key by setting verified = true and clearing the verification token
      await pool.query(
        `UPDATE api_keys
         SET verified = TRUE,
             verification_token = NULL,
             verification_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [keyRecord.id]
      );

      // Since this is the only time we return the full key, we need to reconstruct it
      // We can't retrieve the original raw key from the hash, so we need to generate a new one
      // and update the record. This is a security trade-off for the one-time display requirement.
      const crypto = (await import('crypto')).default;
      const bcrypt = (await import('bcryptjs')).default;
      
      const newRawKey = crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const newKeyPrefix = newRawKey.slice(0, 8);
      const newKeyHash = await bcrypt.hash(newRawKey, 12);

      await pool.query(
        `UPDATE api_keys
         SET key_hash = $1, key_prefix = $2, updated_at = NOW()
         WHERE id = $3`,
        [newKeyHash, newKeyPrefix, keyRecord.id]
      );

      // Return the full key (this is the only time it will be shown)
      res.json({
        message: 'API key verified and activated successfully. Save this key securely - it will not be shown again.',
        key: newRawKey,
        keyId: keyRecord.id,
        name: keyRecord.name,
        email: keyRecord.email,
        tier: keyRecord.tier
      });
    } catch (e) {
      logger.error('[GET /api/keys/verify] Error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/gaps — ledger gap detection status ─────────────────────────────
  // Returns pending gaps and count of gaps closed in the last 24 hours.
  app.get("/api/gaps", async (_req, res) => {
    try {
      const stats = await db.getGapLogStats();
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── RPC node performance metrics ────────────────────────────────
  // GET /api/rpc-metrics — latency history, uptime, error rate per node
  app.get("/api/rpc-metrics", (_req, res) => {
    try {
      res.json(getMetrics());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/rpc-nodes — live health status from multi-node client (#113)
  app.get("/api/rpc-nodes", (_req, res) => {
    try {
      res.json(getRpcNodeStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/rpc/health — per-provider health/performance snapshot sourced
  // from rpcMultiNode.js's own call-outcome tracking. Cached for 5s.
  app.get(
    "/api/rpc/health",
    makeCache("rpc_health", () => "rpc:health"),
    (_req, res) => {
      try {
        res.json(getProviderStats());
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ── Multi-Signature Source Code Verification ───────────────────

  // POST /api/contracts/:id/source-verifications
  // Body: { wasm_hash, signer, signature, compiler_hash }
  app.post("/api/contracts/:id/source-verifications", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { wasm_hash, signer, signature, compiler_hash } = req.body;
      if (!wasm_hash || !signer || !signature || !compiler_hash) {
        return res.status(400).json({
          error: "Missing wasm_hash, signer, signature, or compiler_hash",
        });
      }
      await db.addSourceVerification({
        contract_id: req.params.id,
        wasm_hash,
        signer,
        signature,
        compiler_hash,
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/contracts/:id/source-verifications?wasm_hash=
  app.get("/api/contracts/:id/source-verifications", async (req, res) => {
    try {
      const rows = await db.getSourceVerifications(req.params.id, req.query.wasm_hash || undefined);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── ABI Version History ───────────────────────────────────────────────────
  // GET /api/contracts/:id/abi-history
  // Returns all rows from contract_versions for this contract, ordered by abi_version ASC.
  app.get("/api/contracts/:id/abi-history", async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, contract_id, abi_version, min_ledger, name, description,
                functions, registered_by, created_at
         FROM contract_versions
         WHERE contract_id = $1
         ORDER BY abi_version ASC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Storage State-Diff Timeline ────────────────────────────────

  // GET /api/contracts/:id/state-diffs?key=&limit=
  app.get("/api/contracts/:id/state-diffs", async (req, res) => {
    try {
      const rows = await db.getStateDiffs(req.params.id, {
        key: req.query.key || undefined,
        limit: req.query.limit ? Math.min(Number(req.query.limit), 500) : 200,
      });
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Contract Stats ────────────────────────────────────────────

  // GET /api/contracts/:id/stats?range=30|90|365 — event/caller counts + a
  // daily event-volume series over the trailing `range` days (default 30,
  // max 365), oldest first and zero-filled. Backs the contract detail page's
  // stats widget and the selectable-time-range invocation frequency chart
  // (#799). The series is computed by db.getContractEventsByDay, which uses
  // idx_events_contract_created (migration 028) for the long-range scan.
  app.get(
    "/api/contracts/:id/stats",
    // Validate before the cache middleware so malformed params can never be
    // served a cached 200 (their cache key would normalize to the default).
    (req, res, next) => {
      if (req.query.range !== undefined) {
        const parsedRange = Number(req.query.range);
        if (!Number.isInteger(parsedRange) || parsedRange < 1 || parsedRange > 365) {
          return res.status(422).json({ error: "Invalid range" });
        }
      }
      next();
    },
    makeCache("stats", (req) => `contracts:stats:${req.params.id}:${req.query.range ?? 30}`),
    async (req, res) => {
      try {
        const range = req.query.range !== undefined ? Number(req.query.range) : 30;
        const [stats, eventsPerDay] = await Promise.all([
          db.getContractStats(req.params.id),
          db.getContractEventsByDay(req.params.id, range),
        ]);
        res.json({ ...stats, events_per_day: eventsPerDay, range });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/contracts/:id/storage-tiers — write counts by storage durability tier
  app.get(
    "/api/contracts/:id/storage-tiers",
    makeCache("stats", (req) => `contracts:storage-tiers:${req.params.id}`),
    async (req, res) => {
      try {
        const tiers = await db.getContractStorageTiers(req.params.id);
        res.json(tiers);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ── Live TTL status for contract instance, code, and persistent storage ──
  // GET /api/contracts/:id/ttl
  // Queries the Soroban RPC getLedgerEntries for the contract's instance and code
  // ledger keys, then returns expiration ledgers alongside the current ledger height.
  app.get("/api/contracts/:id/ttl", async (req, res) => {
    try {
      const contractId = req.params.id;
      const { rpc: SorobanRpc, xdr, Address } = await import("@stellar/stellar-sdk");
      const server = new SorobanRpc.Server(RPC_URL);

      // Build ledger keys for instance and code entries
      const contractAddress = Address.fromString(contractId);
      const instanceKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress.toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );

      // Fetch instance entry first to get the WASM hash for the code key
      const instanceResult = await server.getLedgerEntries(instanceKey);
      const instanceEntry = instanceResult.entries?.[0] ?? null;

      let instanceTTL = null;
      let codeTTL = null;
      let currentLedger = instanceResult.latestLedger ?? 0;

      if (instanceEntry) {
        instanceTTL = instanceEntry.liveUntilLedgerSeq ?? null;

        // Extract WASM hash from the instance entry to build the code key
        try {
          const contractInstance = instanceEntry.val.contractData().val().instance();
          const wasmHash = contractInstance.executable().wasmHash();
          const resolvedCodeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
          const codeResult = await server.getLedgerEntries(resolvedCodeKey);
          const codeEntry = codeResult.entries?.[0] ?? null;
          if (codeEntry) codeTTL = codeEntry.liveUntilLedgerSeq ?? null;
        } catch {
          // WASM hash extraction failed — code TTL unavailable
        }
      }

      res.json({
        contract_id: contractId,
        current_ledger: currentLedger,
        instance: { live_until_ledger: instanceTTL },
        code: { live_until_ledger: codeTTL },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Setup Wizard & Diagnostics Endpoints ────────────────────────────────────
  // These endpoints are disabled in production (NODE_ENV=production) because
  // they can write .env files and run migrations with no additional auth.
  const blockInProduction = (_req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Not available in production" });
    }
    next();
  };

  app.get("/api/setup/doctor", blockInProduction, async (req, res) => {
    try {
      const report = await runAllChecks();
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/setup/test-db", blockInProduction, async (req, res) => {
    try {
      const { databaseUrl } = req.body;
      if (!databaseUrl) return res.status(400).json({ error: "Missing databaseUrl" });
      const client = new pg.Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 3000,
      });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  app.post("/api/setup/save-config", blockInProduction, async (req, res) => {
    try {
      const { sorobanRpcUrl, databaseUrl, pollMs } = req.body;
      const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
      let envContent = "";
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, "utf8");
      }
      // Shell-escape a value so it is safe to embed in a KEY=value .env line.
      // Wraps in single-quotes and escapes any embedded single-quote characters.
      const shellEscape = (val) => `'${String(val).replace(/'/g, "'\\''")}'`;
      const updateEnvVar = (key, val) => {
        if (!val) return;
        const escaped = shellEscape(val);
        const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${escaped}`);
        } else {
          envContent += `\n${key}=${escaped}`;
        }
      };
      updateEnvVar("SOROBAN_RPC_URL", sorobanRpcUrl);
      updateEnvVar("DATABASE_URL", databaseUrl);
      updateEnvVar("POLL_MS", pollMs);
      fs.writeFileSync(envPath, envContent, "utf8");

      // Update current process environment (unescaped raw values)
      if (sorobanRpcUrl) process.env.SOROBAN_RPC_URL = sorobanRpcUrl;
      if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
      if (pollMs) process.env.POLL_MS = pollMs;

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/setup/db-init — create/upgrade the schema only.
  //
  // INTENTIONALLY MINIMAL (issue #417): this handler must call db.init() and
  // nothing else. It does NOT seed sample data. The old seed_lib helper
  // (which generated fake Stellar addresses) was removed during cleanup and must
  // never be re-introduced here — no static import, no `await import("./seed_lib.js")`.
  // The schema-init test in test/api/setup-db-init.test.js guards this invariant.
  app.post("/api/setup/db-init", blockInProduction, async (req, res) => {
    try {
      await db.init();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── CSV/JSON export endpoints ─────────────────────────────────

  function rowsToCsv(rows, columns) {
    if (!rows.length) return columns.join(",") + "\n";
    const escape = (v) => {
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.join(",");
    const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
    return header + "\n" + body + "\n";
  }

  const EVENT_COLUMNS = [
    "seq",
    "ledger",
    "contract_id",
    "contract_name",
    "function",
    "description",
    "tx_hash",
    "created_at",
  ];

  const CONTRACT_COLUMNS = [
    "id",
    "name",
    "description",
    "registered_by",
    "has_circuit_breaker",
    "is_paused",
    "is_rwa",
    "rwa_type",
    "created_at",
  ];

  // GET /api/export/events?format=csv|json&contract=&fn=&type=&wallet=&limit=
  // #528: accepts wallet param to export a single wallet's event history.
  app.get("/api/export/events", async (req, res) => {
    try {
      const format = req.query.format === "json" ? "json" : "csv";
      const limit = Math.min(Number(req.query.limit) || 10000, 10000);
      const wallet = req.query.wallet || undefined;
      const rows = await db.getEventsForExport({
        contract: req.query.contract,
        fn: req.query.fn,
        type: req.query.type,
        wallet,
        limit,
      });
      if (format === "json") {
        const filename = wallet
          ? `wallet-${wallet}-events.json`
          : "events.json";
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", "application/json");
        return res.json(rows);
      }
      const filename = wallet
        ? `wallet-${wallet}-events.csv`
        : "events.csv";
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/csv");
      return res.send(rowsToCsv(rows, EVENT_COLUMNS));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/export/contracts?format=csv|json
  app.get("/api/export/contracts", async (req, res) => {
    try {
      const format = req.query.format === "json" ? "json" : "csv";
      const rows = await db.getContractsForExport();
      if (format === "json") {
        res.setHeader("Content-Disposition", 'attachment; filename="contracts.json"');
        res.setHeader("Content-Type", "application/json");
        return res.json(rows);
      }
      res.setHeader("Content-Disposition", 'attachment; filename="contracts.csv"');
      res.setHeader("Content-Type", "text/csv");
      return res.send(rowsToCsv(rows, CONTRACT_COLUMNS));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Cache analytics endpoint ───────────────────────────────────────────────
  // GET /api/cache/stats — hit rates, latency, invalidations, top keys, etc.
  app.get("/api/cache/stats", (_req, res) => {
    try {
      res.json(getAnalytics());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Stats endpoint (cached) ────────────────────────────────────────────────
  // GET /api/stats — aggregate counts for events and contracts
  app.get(
    "/api/stats",
    makeCache("stats", () => "stats:global"),
    async (_req, res) => {
      try {
        const [eventsResult, contractsResult] = await Promise.all([
          db.query("SELECT COUNT(*) AS total FROM events"),
          db.query("SELECT COUNT(*) AS total FROM contracts"),
        ]);
        res.json({
          events: Number(eventsResult.rows[0].total),
          contracts: Number(contractsResult.rows[0].total),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ── Decoder stats endpoint ─────────────────────────────────────────────────
  // GET /api/stats/decoder — decode success/failure counts over the last 24h.
  app.get("/api/stats/decoder", (_req, res) => {
    try {
      res.json(getDecodeStats());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GraphQL endpoint ───────────────────────────────────────────
  if (!runningUnderTest) attachGraphQL(app);

  // ── Batch Multi-Call Endpoints ───────────────────────────────────────

  // POST /api/batch — dispatch a list of HTTP sub-requests against this API and
  // return their results in the SAME order they were submitted. A sub-request
  // that fails (e.g. 404) is captured as its own result entry and does NOT
  // abort the sibling sub-requests.
  //
  // Body: { requests: [{ method?, path, body? }, ...] } (or a bare array).
  // Response: [{ status, body }, ...] — one entry per submitted request, in order.
  app.post("/api/batch", async (req, res) => {
    try {
      const items = Array.isArray(req.body) ? req.body : req.body?.requests;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: "requests must be an array" });
      }

      const base = `http://${req.headers.host}`;
      const apiKey = req.headers["x-api-key"];

      // Promise.all preserves array order; each sub-request resolves to its own
      // { status, body } so an individual failure never rejects the batch.
      const results = await Promise.all(
        items.map(async (item) => {
          try {
            const method = String(item?.method || "GET").toUpperCase();
            const subPath = item?.path || item?.url || "/";
            const init = { method, headers: {} };
            if (apiKey) init.headers["x-api-key"] = apiKey;
            if (item?.body !== undefined && method !== "GET" && method !== "HEAD") {
              init.headers["content-type"] = "application/json";
              init.body = JSON.stringify(item.body);
            }
            const r = await fetch(base + subPath, init);
            const contentType = r.headers.get("content-type") || "";
            const body = contentType.includes("application/json") ? await r.json() : await r.text();
            return { status: r.status, body };
          } catch (e) {
            return { status: 500, body: { error: e.message } };
          }
        }),
      );

      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/batch/simulate — simulate full batch with per-call results
  app.post("/api/batch/simulate", async (req, res) => {
    try {
      const { calls, sourceAccount, networkPassphrase } = req.body;
      if (!Array.isArray(calls)) {
        return res.status(400).json({ error: "calls must be an array" });
      }
      const result = await (await import("./batch.js")).simulateBatch(
        calls,
        sourceAccount,
        networkPassphrase
      );
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/batch/estimate-gas — detailed gas breakdown per call
  app.post("/api/batch/estimate-gas", async (req, res) => {
    try {
      const { calls, sourceAccount } = req.body;
      if (!Array.isArray(calls)) {
        return res.status(400).json({ error: "calls must be an array" });
      }
      const estimates = await (await import("./batch.js")).estimateGas(calls, sourceAccount);
      const totalGas = estimates.reduce(
        (acc, e) => ({
          cpuInsns: acc.cpuInsns + (e.cpuInsns || 0),
          memBytes: acc.memBytes + (e.memBytes || 0),
          fee: acc.fee + (e.fee || 0),
        }),
        { cpuInsns: 0, memBytes: 0, fee: 0 }
      );
      res.json({ estimates, totalGas });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/batch/optimize — reorder calls for minimum gas
  app.post("/api/batch/optimize", async (req, res) => {
    try {
      const { calls, sourceAccount } = req.body;
      if (!Array.isArray(calls)) {
        return res.status(400).json({ error: "calls must be an array" });
      }
      const batch = await import("./batch.js");
      const estimates = await batch.estimateGas(calls, sourceAccount);
      const optimizedOrder = await batch.optimizeBatchOrder(calls, sourceAccount, estimates);
      const originalGas = batch.summarizeGas(estimates);
      const optimizedGas = optimizedOrder
        .map((id) => estimates.find((estimate) => estimate.callId === id))
        .filter(Boolean)
        .reduce(
          (acc, estimate) => ({
            cpuInsns: acc.cpuInsns + (estimate.cpuInsns || 0),
            memBytes: acc.memBytes + (estimate.memBytes || 0),
            fee: acc.fee + (estimate.fee || 0),
          }),
          { cpuInsns: 0, memBytes: 0, fee: 0 },
        );
      res.json({
        optimizedOrder,
        gasBreakdown: estimates,
        estimatedSavings: {
          cpuInsns: Math.max(0, originalGas.cpuInsns - optimizedGas.cpuInsns),
          memBytes: Math.max(0, originalGas.memBytes - optimizedGas.memBytes),
          fee: Math.max(0, originalGas.fee - optimizedGas.fee),
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/batch/validate — check for conflicts and errors
  app.post("/api/batch/validate", async (req, res) => {
    try {
      const { calls } = req.body;
      if (!Array.isArray(calls)) {
        return res.status(400).json({ error: "calls must be an array" });
      }
      const validation = await (await import("./batch.js")).validateBatch(calls);
      res.json(validation);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Start HTTP + WebSocket server ───────────────────────────────────────────
  const server = http.createServer(app);
  if (!runningUnderTest) attachWebSocketServer(server);

  server.on("close", () => logger.info("[api] server closed"));

  // During test runs we avoid calling `listen()` to prevent port conflicts
  // and background handles that outlive the Jest environment. Tests will
  // use the returned `app` or server object directly via supertest.
  if (process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID) {
    return app;
  }

  server.listen(PORT, () => logger.info(`API listening on :${PORT}`));
  return server;
}

// `startApi` is the name used by src/index.js and the test suite; `createApi`
// is kept for callers that pass { logDestination, dbOverride }. They are aliases.
export { createApi as startApi };
