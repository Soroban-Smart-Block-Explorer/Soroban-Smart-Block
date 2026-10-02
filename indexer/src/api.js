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
import {
  getNetworkMetrics,
  RANGES as NETWORK_METRIC_RANGES,
  getLedgerDetail,
  listLedgers,
} from "./networkMetrics.js";
import { safeFetch } from "./safeHttp.js";
import config from "./config.js";
import { InvalidCursorError, CursorFilterMismatchError } from "./cursor.js";

export function handleLegacyOffset(req, res) {
  const hasLegacy = req.query.offset !== undefined || req.query.page !== undefined;
  if (!hasLegacy) return false;

  if (!config.PAGINATION_LEGACY_OFFSET) {
    res.status(400).json({
      error: "offset_pagination_deprecated",
      message: "OFFSET/page pagination is deprecated and disabled. Use keyset cursor pagination (cursor/after/before).",
    });
    return true;
  }

  res.setHeader("Deprecation", "true");
  res.setHeader("Link", '</docs/api/pagination>; rel="deprecation"');
  return false;
}

export function handleCursorError(e, res) {
  if (e instanceof InvalidCursorError || e?.code === "invalid_cursor") {
    res.status(400).json({ error: "invalid_cursor", message: e.message });
    return true;
  }
  if (e instanceof CursorFilterMismatchError || e?.code === "cursor_filter_mismatch") {
    res.status(400).json({ error: "cursor_filter_mismatch", message: e.message });
    return true;
  }
  return false;
}
import { analyzeSourceDependencies } from "./dependencyScanner.js";
import { fetchTokenMetadata } from "./sep41Metadata.js";
import { fetchWalletBalances, fetchAccountMeta, AccountNotFoundError } from "./horizonBalances.js";
import { attachWebSocketServer, attachEventStreamRoutes, getTransactionStatus, onTransactionStatus, offTransactionStatus } from "./wsEvents.js";
import { verifyAbi } from "./verify_abi.js";
import { getMetrics } from "./rpcMetrics.js";
import { getRpcNodeStatus, getProviderStats, multiNodeRpc } from "./rpcMultiNode.js";
import { cacheHitTotal, cacheMissTotal, apiRequestDuration, httpRequestsInFlight } from "./metrics.js";
import { tracer, getTraceHeaders } from "./tracing.js";
import { context, propagation } from "@opentelemetry/api";
import { getUptimeHistory } from "./uptimeRecorder.js";
import { getDecodeStats } from "./decoder.js";
// ── Auth & Rate Limiting ──────────────────────────────────────────────────────
import { apiKeyAuthenticator } from "./auth/apiKeyAuth.js";
import { scopeMiddleware, assertRoutesDeclareScopes } from "./auth/scopes.js";
import { toFilterAst, planFilter, FilterError, FILTER_TIER_LIMITS } from "./filters/filter.js";
import { compileFilter } from "./filters/sql.js";
import { parseRpcFilters, compileRpcFilters, RpcFilterError } from "./rpcFilters.js";
import { geoIpRateLimiter } from "./rateLimit/geoIpLimiter.js";
import { concurrentRequestLimiter } from "./rateLimit/concurrentLimiter.js";
import { tokenBucketMiddleware } from "./rateLimit/tokenBucket.js";
import { graphqlComplexityLimiter } from "./rateLimit/graphqlComplexity.js";
import { abuseDetector } from "./rateLimit/abuseDetector.js";
import { abuseScorer } from "./abuse/scorer.js";
import { rateLimitHeaderWriter } from "./rateLimit/headers.js";
import { auditLoggerMiddleware, ensureAuditPartitions } from "./audit/auditLogger.js";
import registerAdminRoutes from "./routes/admin.js";
import { requestSigningMiddleware } from "./auth/requestSigning.js";
import { requestVerification, getCodeVerification } from "./contractVerifier.js";
import { getEventLineage } from "./lineage.js";
import registerWebhookRoutes from "./routes/webhooks.js";
import registerDashboardRoutes from "./routes/dashboard.js";
import { requireAuthenticatedKey } from "./auth/requireAuthenticatedKey.js";
import { ALERT_EVENT_TIME_GRACE_MS, evaluateAlertRule } from "./alertingEngine.js";
import { getIndexerNetwork } from "./networkConfig.js";
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
  edgeCachePolicy,
} from "./cacheLayer.js";
import { recordAccess, schedulePrefetch } from "./prefetchEngine.js";
import { attachGraphQL } from "./graphql.js";
import { attachCollabServer, createSession as createCollabSession, authorize as authorizeCollab, rotateToken as rotateCollabToken, kickParticipants as kickCollabParticipants } from "./collab/server.js";
import { requestContext } from "./logger.js";
import { runAllChecks } from "./doctor-lib.js";
import { registry } from "./metrics.js";
import {
  loadSession,
  requireSession,
  requireStepUp,
  startSession,
  rotateSession,
  endSession,
  issueChallenge,
  takeChallenge,
  isElevated,
} from "./auth/session.js";
import { registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication } from "./auth/passkeys.js";
import { EMAIL_PURPOSES, sendEmailLink, consumeEmailLink, issueRecoveryCodes, hashRecoveryCode } from "./auth/recovery.js";
import { sep10Enabled, buildChallenge as buildSep10Challenge, verifyChallenge as verifySep10Challenge } from "./auth/sep10.js";
import { createKey } from "./admin/keyManager.js";
import { evaluateSubmission, reportContract, fileAppeal, HIDDEN_STATUSES } from "./moderation/service.js";
import pg from "pg";
import { analyticsPool, executeAnalyticsQuery, toCsv } from "./analyticsSql.js";
import { ALLOWED_RPC_METHODS, proxyRpcRequest } from "./rpcProxy.js";
import { adaptiveLoadShedder, getLoadShedderMetrics } from "./loadShedder.js";
import { getBurnAlerts } from "./burnDetector.js";
import { formatAmount } from "./formatAmount.js";
import { verifySourceVerification } from "./sourceVerification.js";
import { sendVerificationEmail, isConfigured } from "./emailService.js";
import { getHealthStatus, getLivenessStatus, getReadinessStatus } from "./health.js";
import * as alertManager from "./alertManager.js";

const { getActiveAlerts } = alertManager;
import { randomUUID } from "crypto";
import Ajv from "ajv";
import { isPurgeHealthy } from "./cdnPurge.js";
import {
  submitJob,
  cancelJob,
  jobView,
  validateJobRequest,
  signedResultUrl,
  verifyResultUrl,
} from "./jobs/queryJobs.js";
import { loadResponseValidator, responseValidationMiddleware } from "./openapiValidator.js";
import { loadSigningKeys, publishedKeys, signEnvelope, wantsSignedResponse, SIGNED_MEDIA_TYPE } from "./signing.js";
import addFormats from "ajv-formats";
import {
  generateEventReportPdf,
  generateContractReportPdf,
  generateBatchEventsReportPdf,
  verifyReport,
} from "./reports/index.js";

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
    is_private: { type: "boolean" },
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
    tracer.startActiveSpan(
      `${req.method} ${req.path}`,
      { attributes: { "http.method": req.method, "http.target": req.originalUrl } },
      (span) => {
        res.on("finish", () => {
          span.setAttribute("http.status_code", res.statusCode);
          span.end();
        });
        next();
      },
    );
  });
}

function validateAlertRule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "rule body must be an object" };
  }
  const ruleTypes = new Set([
    "threshold",
    "rate_of_change",
    "anomaly",
    "absence",
    "function_match",
    "decoded_predicate",
    "system_event",
  ]);
  if (!ruleTypes.has(input.rule_type)) return { valid: false, error: "unsupported rule_type" };
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 120) {
    return { valid: false, error: "name must be 1-120 characters" };
  }
  if (input.contract_id != null && !/^C[A-Z2-7]{55}$/.test(input.contract_id)) {
    return { valid: false, error: "contract_id must be a valid Stellar contract address" };
  }
  const channels = input.channels ?? ["in_app"];
  if (
    !Array.isArray(channels) ||
    channels.length === 0 ||
    channels.some((channel) => !["email", "webhook", "in_app"].includes(channel)) ||
    new Set(channels).size !== channels.length
  ) {
    return { valid: false, error: "channels must be unique values from email, webhook, in_app" };
  }
  const window_seconds = Number(input.window_seconds ?? 3600);
  const cooldown_seconds = Number(input.cooldown_seconds ?? 0);
  if (!Number.isInteger(window_seconds) || window_seconds < 60 || window_seconds > 86400) {
    return { valid: false, error: "window_seconds must be an integer between 60 and 86400" };
  }
  if (!Number.isInteger(cooldown_seconds) || cooldown_seconds < 0 || cooldown_seconds > 2_592_000) {
    return { valid: false, error: "cooldown_seconds must be an integer between 0 and 2592000" };
  }

  const config = input.config ?? {};
  let normalizedConfig = config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, error: "config must be an object" };
  }
  const operators = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
  if (input.rule_type === "threshold") {
    if (!operators.has(config.operator ?? "gt") || !Number.isFinite(Number(config.value))) {
      return { valid: false, error: "threshold requires a valid operator and numeric value" };
    }
  } else if (input.rule_type === "rate_of_change") {
    if (
      !["increase", "decrease"].includes(config.direction ?? "increase") ||
      !Number.isFinite(Number(config.minimum_change_percent ?? 50)) ||
      Number(config.minimum_change_percent ?? 50) < 0
    ) {
      return { valid: false, error: "rate_of_change requires direction and a non-negative percentage" };
    }
  } else if (input.rule_type === "anomaly") {
    if (
      !Number.isInteger(Number(config.baseline_windows ?? 24)) ||
      Number(config.baseline_windows ?? 24) < 3 ||
      Number(config.baseline_windows ?? 24) > 168 ||
      !Number.isFinite(Number(config.standard_deviations ?? 3)) ||
      Number(config.standard_deviations ?? 3) <= 0
    ) {
      return { valid: false, error: "anomaly requires 3-168 baseline windows and a positive deviation" };
    }
  } else if (input.rule_type === "function_match") {
    if (typeof config.function !== "string" || config.function.length < 1 || config.function.length > 128) {
      return { valid: false, error: "function_match requires a function name" };
    }
  } else if (input.rule_type === "system_event") {
    if (!["upgrade", "pause", "circuit_breaker"].includes(config.event)) {
      return { valid: false, error: "system_event must be upgrade, pause, or circuit_breaker" };
    }
  } else if (input.rule_type === "decoded_predicate") {
    const allowedFields = /^(function|description|ledger|cpu_instructions|fee_charged|raw_topics\.\d{1,2})$/;
    if (
      typeof config.field !== "string" ||
      !allowedFields.test(config.field) ||
      !operators.has(config.operator) ||
      config.value === undefined ||
      !["string", "number"].includes(typeof config.value)
    ) {
      return { valid: false, error: "decoded_predicate requires a supported field, operator, and scalar value" };
    }
    if (
      ["function", "description"].includes(config.field) &&
      !["eq", "neq"].includes(config.operator)
    ) {
      return { valid: false, error: "string predicates support only eq and neq" };
    }
    if (
      !["function", "description"].includes(config.field) &&
      !Number.isFinite(Number(config.value))
    ) {
      return { valid: false, error: "numeric predicates require a numeric value" };
    }
    if (!["function", "description"].includes(config.field)) {
      normalizedConfig = { ...config, value: Number(config.value) };
    }
  }

  const mute_windows = input.mute_windows ?? [];
  if (
    !Array.isArray(mute_windows) ||
    mute_windows.length > 50 ||
    mute_windows.some((window) => {
      const start = new Date(window?.start);
      const end = new Date(window?.end);
      return !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end;
    })
  ) {
    return { valid: false, error: "mute_windows must contain at most 50 valid start/end timestamps" };
  }

  return {
    valid: true,
    value: {
      name: input.name.trim(),
      contract_id: input.contract_id ?? null,
      rule_type: input.rule_type,
      config: normalizedConfig,
      channels,
      window_seconds,
      cooldown_seconds,
      digest_mode: input.digest_mode === true,
      auto_resolve: input.auto_resolve !== false,
      mute_windows,
    },
  };
}

async function validateAlertChannels(db, apiKeyId, channels) {
  if (channels.includes("email")) {
    if (!isConfigured()) return "Email delivery is not configured";
    if (!(await db.getVerifiedEmailForApiKey(apiKeyId))) {
      return "A verified email address is required for email alerts";
    }
  }
  if (channels.includes("webhook") && (await db.getActiveWebhooksForApiKey(apiKeyId)).length === 0) {
    return "Create an active webhook subscription before enabling webhook alerts";
  }
  return null;
}

async function dryRunAlertRule(db, rule) {
  const durationMs = Number(rule.window_seconds) * 1000;
  const now = Date.now();
  const end = Math.floor((now - ALERT_EVENT_TIME_GRACE_MS) / durationMs) * durationMs;
  const start = Math.floor((now - 86_400_000) / durationMs) * durationMs;
  const baselineWindows = rule.rule_type === "anomaly"
    ? Math.min(168, Math.max(3, Number(rule.config.baseline_windows) || 24))
    : rule.rule_type === "rate_of_change"
      ? 1
      : 0;
  const queryStart = new Date(start - baselineWindows * durationMs);
  const params = [getIndexerNetwork(), rule.contract_id, rule.window_seconds, new Date(start), queryStart, new Date(end)];
  let predicate = "";
  if (rule.rule_type === "function_match") {
    params.push(rule.config.function);
    predicate = ` AND function = $${params.length}`;
  } else if (rule.rule_type === "system_event") {
    if (rule.config.event === "upgrade") predicate = " AND upgrade_info IS NOT NULL";
    else if (rule.config.event === "pause") predicate = " AND function ~* '(pause|unpause|halt)'";
    else predicate = " AND function ~* '(circuit|breaker|trip)'";
  } else if (rule.rule_type === "decoded_predicate") {
    const field = rule.config.field;
    const operators = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    let expression;
    let cast;
    if (field === "raw_topics.0" || /^raw_topics\.\d{1,2}$/.test(field)) {
      const index = Number(field.slice("raw_topics.".length));
      expression = `CASE WHEN (raw_topics->>$${params.length + 1}::INT) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (raw_topics->>$${params.length + 1}::INT)::NUMERIC END`;
      params.push(index);
      cast = "NUMERIC";
    } else if (["function", "description"].includes(field)) {
      expression = field;
      cast = "TEXT";
    } else {
      expression = field;
      cast = "NUMERIC";
    }
    params.push(rule.config.value);
    predicate = ` AND ${expression} ${operators[rule.config.operator]} $${params.length}::${cast}`;
  }
  const { rows } = await db.query(
    `SELECT date_bin(make_interval(secs => $3), created_at, $4) AS bucket, COUNT(*)::INT AS total
     FROM events
     WHERE network = $1 AND ($2::TEXT IS NULL OR contract_id = $2)
       AND created_at >= $5 AND created_at < $6${predicate}
     GROUP BY bucket`,
    params,
  );
  const counts = new Map(rows.map((row) => [new Date(row.bucket).toISOString(), Number(row.total)]));
  const windows = [];
  let active = Boolean(rule.active);
  let lastFiredAt = rule.last_fired_at ? new Date(rule.last_fired_at).getTime() : 0;
  for (let current = start; current < end; current += durationMs) {
    const windowStart = new Date(current);
    const currentCount = counts.get(windowStart.toISOString()) ?? 0;
    const syntheticEvent = {};
    if (rule.rule_type === "function_match") {
      syntheticEvent.function = rule.config.function;
    } else if (rule.rule_type === "system_event") {
      if (rule.config.event === "upgrade") syntheticEvent.upgrade_info = {};
      else syntheticEvent.function = rule.config.event === "pause" ? "pause" : "circuit_breaker";
    } else if (rule.rule_type === "decoded_predicate") {
      const expected = rule.config.value;
      const actualByOperator = {
        eq: expected,
        neq: typeof expected === "number" ? expected + 1 : `${expected}_other`,
        gt: Number(expected) + 1,
        gte: expected,
        lt: Number(expected) - 1,
        lte: expected,
      };
      const actual = actualByOperator[rule.config.operator];
      if (rule.config.field.startsWith("raw_topics.")) {
        const index = Number(rule.config.field.slice("raw_topics.".length));
        syntheticEvent.raw_topics = [];
        syntheticEvent.raw_topics[index] = String(actual);
      } else {
        syntheticEvent[rule.config.field] = actual;
      }
    }
    const syntheticEvents =
      currentCount > 0 && ["function_match", "decoded_predicate", "system_event"].includes(rule.rule_type)
        ? [syntheticEvent]
        : [];
    const result = evaluateAlertRule(rule, syntheticEvents, counts, windowStart);
    const windowEnd = current + durationMs;
    const muted =
      (rule.muted_until && new Date(rule.muted_until).getTime() > windowEnd) ||
      (rule.mute_windows ?? []).some(
        (mute) => new Date(mute.start).getTime() <= windowEnd && new Date(mute.end).getTime() > windowEnd,
      );
    const cooldownElapsed =
      !lastFiredAt || windowEnd - lastFiredAt >= Number(rule.cooldown_seconds) * 1000;
    const wouldFire = result.matched && !muted && (!active || (rule.cooldown_seconds > 0 && cooldownElapsed));
    if (wouldFire) {
      windows.push({
        window_start: windowStart.toISOString(),
        window_end: new Date(windowEnd).toISOString(),
        event_count: currentCount,
        metric: result.metric,
      });
      active = true;
      lastFiredAt = windowEnd;
    } else if (!result.matched && active && rule.auto_resolve) {
      active = false;
    }
  }
  return {
    rule_id: rule.id,
    period_start: new Date(start).toISOString(),
    period_end: new Date(end).toISOString(),
    windows,
  };
}

function createHttpLogger(logDestination) {
  return (req, res, next) => {
    res.on("finish", () => {
      const line = `[api] ${req.method} ${req.url} ${res.statusCode} ${req.id || ""}\n`;
      try {
        if (logDestination && typeof logDestination.write === "function") {
          logDestination.write(line);
        } else {
          logger.info(line.trim());
        }
      } catch {
        logger.info(line.trim());
      }
    });
    next();
  };
}

function metricsMiddleware(req, res, next) {
  const endTimer = apiRequestDuration.startTimer();
  httpRequestsInFlight.inc();
  res.once("close", () => httpRequestsInFlight.dec());
  res.on("finish", () => {
    const route = req.route && req.route.path ? req.route.path : req.path || req.url;
    endTimer({ method: req.method, route: String(route), status: String(res.statusCode) });
  });
  next();
}

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

function requireApiKey(req, res, next) {
  if (req.rateContext?.keyId) return next();
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
  if (Array.isArray(value))
    return value.flatMap((v) =>
      String(v)
        .split(",")
        .map((hash) => hash.trim())
        .filter(Boolean),
    );
  return String(value)
    .split(",")
    .map((hash) => hash.trim())
    .filter(Boolean);
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

const _generalLimiter = rateLimit({
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
  const runningUnderTest =
    process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID || !!process.env.NODE_TEST_CONTEXT;
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

  // ── Verifiable responses (#904) ────────────────────────────────────────────
  // `?signed=1` or `Accept: application/vnd.soroban-explorer.signed+json`
  // wraps successful JSON bodies in an Ed25519-signed envelope bound to the
  // last indexed ledger. See signing.js.
  const signingKeys = loadSigningKeys();
  app.use((req, res, next) => {
    if (!wantsSignedResponse(req)) return next();
    res.vary("Accept");
    if (!signingKeys.active) {
      return res.status(501).json({ error: "Response signing is not configured" });
    }
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) return sendJson(body);
      Promise.resolve(db.getLastIndexedLedger?.())
        .catch(() => null)
        .then((ledger) => {
          res.set("Content-Type", `${SIGNED_MEDIA_TYPE}; charset=utf-8`);
          sendJson(signEnvelope(body, ledger ?? null, signingKeys));
        })
        .catch(next);
      return res;
    };
    next();
  });

  // ── CDN edge caching (#905) ────────────────────────────────────────────────
  // Edge TTL + surrogate keys per endpoint class; the daemon purges keys on
  // each ledger. The API key is not part of the cache key (no Vary on it), so
  // authenticated reads of public data share edge entries; usage for edge
  // hits is counted from CDN logs (docs/guides/cdn.md).
  app.use("/api", (req, res, next) => {
    const policy = edgeCachePolicy({ method: req.method, path: req.originalUrl.split("?")[0] }, {
      purgeHealthy: isPurgeHealthy(),
    });
    res.set("Surrogate-Control", policy.edge);
    res.set("CDN-Cache-Control", policy.edge);
    if (policy.keys.length) {
      res.set("Surrogate-Key", policy.keys.join(" "));
      res.set("Cache-Tag", policy.keys.join(","));
    }
    next();
  });

  // ── Test-mode OpenAPI response validation (#907) ───────────────────────────
  // Registered after the signing wrapper so the raw body is validated. Any
  // response that does not match docs/api/openapi.yaml becomes a 500.
  if (process.env.OPENAPI_VALIDATE_RESPONSES === "true") {
    const validate = loadResponseValidator(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/api/openapi.yaml"),
    );
    if (validate) app.use("/api", responseValidationMiddleware(validate));
  }

  app.get("/.well-known/explorer-keys.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(publishedKeys(signingKeys));
  });
  // Report-only CSP: does not block anything (safe alongside the enforced
  // policy above), but lets us observe what a tighter policy would break
  // before ever enforcing it. Violations are POSTed to /api/csp-report.
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      "default-src 'self'; script-src 'self'; style-src 'self'; report-uri /api/csp-report",
    );
    next();
  });
  const isWildcard = process.env.CORS_ORIGINS === "*";
  const allowedOrigins = isWildcard
    ? []
    : process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
      : [];

  const corsOptionsDelegate = (req, callback) => {
    const corsOptions = {
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-API-Key", "X-CSRF-Token"],
      maxAge: 86400,
    };

    if (isWildcard) {
      corsOptions.origin = "*";
      corsOptions.credentials = false;
    } else {
      const origin = req.header("Origin");
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

  // Keep the raw bytes: request signatures (#852) are computed over them.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(requestIdMiddleware);
  app.use(tracingMiddleware);
  app.use(createHttpLogger(logDestination));
  app.use(metricsMiddleware);
  app.use((req, res, next) => {
    res.setHeader("X-Data-Freshness", db.getLastWriteLsn?.() || "primary");
    next();
  });

  // ── CSRF token endpoint ────────────────────────────────────────────────────
  // Must be registered BEFORE verifyCsrf so it is exempt from CSRF checking
  // (it is what issues the token in the first place).
  app.get("/api/csrf-token", csrfTokenHandler);

  // ── CSP violation reports ───────────────────────────────────────────────────
  // Registered before verifyCsrf so browser-sent reports (no CSRF token) aren't
  // rejected. Logged so violations are visible in log-based observability.
  app.post("/api/csp-report", express.json({ type: ["application/csp-report", "application/json"] }), (req, res) => {
    const report = req.body?.["csp-report"] || req.body;
    console.warn("[csp-violation]", JSON.stringify(report));
    res.status(204).end();
  });

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
  ensureAuditPartitions().catch((err) => logger.error("[api] Startup audit partition check failed:", err.message));
  app.use(auditLoggerMiddleware);
  app.use(apiKeyAuthenticator);
  // HMAC request signing + replay protection on mutating routes (#852).
  app.use(requestSigningMiddleware);
  // Scoped API tokens (#901): enforce each route's declared scopes.
  app.use(scopeMiddleware);
  // RATE_LIMITING_DISABLED short-circuits the per-client throttles. Intended
  // only for load/perf harnesses (e.g. the k6 PR baseline job) that drive
  // thousands of requests/second from a single origin and would otherwise
  // just be measuring 429s. Never set this in production.
  if (process.env.RATE_LIMITING_DISABLED !== "true") {
    app.use(geoIpRateLimiter);
    app.use(concurrentRequestLimiter);
    app.use(tokenBucketMiddleware);
  }
  app.use(graphqlComplexityLimiter);
  if (process.env.RATE_LIMITING_DISABLED !== "true") {
    app.use(abuseDetector);
    app.use(abuseScorer);
  }
  app.use(rateLimitHeaderWriter);

  // NOTE: generalLimiter superseded by tokenBucketMiddleware above.
  // Kept as fallback only if Redis is unavailable (tokenBucket fails open).
  // app.use(_generalLimiter);

  // ── Admin routes (auth-gated) ─────────────────────────────────────────────
  app.use("/api/admin", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  registerAdminRoutes(app);

  // ── Self-service routes (auth-gated by req.rateContext.keyId) ────────────
  registerWebhookRoutes(app);
  registerDashboardRoutes(app);
  const alertsRouter = express.Router();
  alertsRouter.use(requireAuthenticatedKey);

  alertsRouter.get("/notifications", async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, rule_id, kind, payload, channels, channel_status, created_at, delivered_at, read_at
         FROM alert_notifications
         WHERE api_key_id = $1 AND network = $2
           AND channels @> ARRAY['in_app']::TEXT[]
           AND channel_status->'in_app'->>'status' = 'sent'
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.rateContext.keyId, getIndexerNetwork()],
      );
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.post("/notifications/:id/read", async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE alert_notifications SET read_at = NOW()
         WHERE id = $1 AND api_key_id = $2 AND network = $3
         RETURNING id, read_at`,
        [req.params.id, req.rateContext.keyId, getIndexerNetwork()],
      );
      if (!rows[0]) return res.status(404).json({ error: "notification not found" });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.get("/", async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM alert_rules WHERE api_key_id = $1 AND network = $2 ORDER BY created_at DESC`,
        [req.rateContext.keyId, getIndexerNetwork()],
      );
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.post("/", async (req, res) => {
    const rule = validateAlertRule(req.body);
    if (!rule.valid) return res.status(400).json({ error: rule.error });
    try {
      const channelError = await validateAlertChannels(db, req.rateContext.keyId, rule.value.channels);
      if (channelError) return res.status(400).json({ error: channelError });
      if (rule.value.contract_id && !(await db.getContractMeta(rule.value.contract_id))) {
        return res.status(400).json({ error: "contract not found" });
      }
      const { rows } = await db.query(
        `INSERT INTO alert_rules
           (api_key_id, network, name, contract_id, rule_type, config, channels, window_seconds,
            cooldown_seconds, digest_mode, auto_resolve, mute_windows)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          req.rateContext.keyId,
          getIndexerNetwork(),
          rule.value.name,
          rule.value.contract_id,
          rule.value.rule_type,
          JSON.stringify(rule.value.config),
          rule.value.channels,
          rule.value.window_seconds,
          rule.value.cooldown_seconds,
          rule.value.digest_mode,
          rule.value.auto_resolve,
          JSON.stringify(rule.value.mute_windows),
        ],
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.put("/:id", async (req, res) => {
    const rule = validateAlertRule(req.body);
    if (!rule.valid) return res.status(400).json({ error: rule.error });
    try {
      const channelError = await validateAlertChannels(db, req.rateContext.keyId, rule.value.channels);
      if (channelError) return res.status(400).json({ error: channelError });
      if (rule.value.contract_id && !(await db.getContractMeta(rule.value.contract_id))) {
        return res.status(400).json({ error: "contract not found" });
      }
      const { rows } = await db.query(
        `UPDATE alert_rules SET
           name = $3, contract_id = $4, rule_type = $5, config = $6, channels = $7,
           window_seconds = $8, cooldown_seconds = $9, digest_mode = $10,
           auto_resolve = $11, mute_windows = $12,
           last_evaluated_window = date_bin(make_interval(secs => $8), NOW(), TIMESTAMPTZ 'epoch'),
           last_fired_at = NULL, active = FALSE, updated_at = NOW()
         WHERE id = $1 AND api_key_id = $2 AND network = $13
         RETURNING *`,
        [
          req.params.id,
          req.rateContext.keyId,
          rule.value.name,
          rule.value.contract_id,
          rule.value.rule_type,
          JSON.stringify(rule.value.config),
          rule.value.channels,
          rule.value.window_seconds,
          rule.value.cooldown_seconds,
          rule.value.digest_mode,
          rule.value.auto_resolve,
          JSON.stringify(rule.value.mute_windows),
          getIndexerNetwork(),
        ],
      );
      if (!rows[0]) return res.status(404).json({ error: "alert rule not found" });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.delete("/:id", async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE alert_rules SET enabled = FALSE, updated_at = NOW()
         WHERE id = $1 AND api_key_id = $2 AND network = $3
         RETURNING id`,
        [req.params.id, req.rateContext.keyId, getIndexerNetwork()],
      );
      if (!rows[0]) return res.status(404).json({ error: "alert rule not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.post("/:id/enable", async (req, res) => {
    try {
      const { rows } = await db.query(
        `UPDATE alert_rules SET enabled = TRUE, updated_at = NOW()
         WHERE id = $1 AND api_key_id = $2 AND network = $3
         RETURNING id, enabled`,
        [req.params.id, req.rateContext.keyId, getIndexerNetwork()],
      );
      if (!rows[0]) return res.status(404).json({ error: "alert rule not found" });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.post("/:id/mute", async (req, res) => {
    const mutedUntil = new Date(req.body?.muted_until);
    if (!Number.isFinite(mutedUntil.getTime()) || mutedUntil <= new Date()) {
      return res.status(400).json({ error: "muted_until must be a future ISO timestamp" });
    }
    try {
      const { rows } = await db.query(
        `UPDATE alert_rules SET muted_until = $3, updated_at = NOW()
         WHERE id = $1 AND api_key_id = $2 AND network = $4
         RETURNING id, muted_until`,
        [req.params.id, req.rateContext.keyId, mutedUntil, getIndexerNetwork()],
      );
      if (!rows[0]) return res.status(404).json({ error: "alert rule not found" });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.get("/:id/history", async (req, res) => {
    try {
      const rule = await db.query(
        "SELECT id FROM alert_rules WHERE id = $1 AND api_key_id = $2 AND network = $3",
        [req.params.id, req.rateContext.keyId, getIndexerNetwork()],
      );
      if (!rule.rows[0]) return res.status(404).json({ error: "alert rule not found" });
      const { rows } = await db.query(
        `SELECT id, window_start, window_end, status, event_count, details, evaluated_at
         FROM alert_evaluations WHERE rule_id = $1
         ORDER BY window_start DESC LIMIT 200`,
        [req.params.id],
      );
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  alertsRouter.post("/:id/dry-run", async (req, res) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM alert_rules WHERE id = $1 AND api_key_id = $2 AND network = $3",
        [req.params.id, req.rateContext.keyId, getIndexerNetwork()],
      );
      if (!rows[0]) return res.status(404).json({ error: "alert rule not found" });
      const result = await dryRunAlertRule(db, rows[0]);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.use("/api/alert-rules", alertsRouter);

  // ── Developer accounts: passkeys, sessions, recovery, SEP-10 (#933) ────────
  // All POSTs here pass through verifyCsrf above (no x-api-key), so a session
  // cookie alone can never drive a state change.
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Development/test only: return email tokens in the response so E2E tests
  // can complete the flow without a mailbox. Never enabled in production.
  const echoEmailToken = process.env.NODE_ENV !== "production" && process.env.AUTH_EMAIL_ECHO_TOKEN === "true";
  const authError = (res, e) => res.status(e.status ?? 500).json({ error: e.message });
  const accountView = async (accountId) => {
    const [account, passkeys, recoveryCodesLeft] = await Promise.all([
      db.getAccount(accountId),
      db.listPasskeys(accountId),
      db.countRecoveryCodes(accountId),
    ]);
    return {
      id: account.id,
      email: account.email,
      stellar_address: account.stellar_address,
      passkeys: passkeys.map(({ public_key: _pk, counter: _c, ...p }) => p),
      recovery_codes_remaining: recoveryCodesLeft,
    };
  };

  app.use("/api/auth", loadSession);

  // Email link for signup (first passkey), claim (existing API keys) or recovery.
  app.post("/api/auth/email/start", authLimiter, async (req, res) => {
    try {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const purpose = String(req.body?.purpose ?? "signup");
      if (!EMAIL_RE.test(email) || !EMAIL_PURPOSES.includes(purpose)) {
        return res.status(400).json({ error: "valid email and purpose are required" });
      }
      // Recovery links only go to existing accounts; response is identical either way.
      const token =
        purpose === "recovery" && !(await db.getAccountByEmail(email)) ? null : await sendEmailLink(email, purpose);
      res.status(202).json({ ok: true, ...(echoEmailToken && token ? { token } : {}) });
    } catch (e) {
      authError(res, e);
    }
  });

  // Signup: the email link creates the account and an enrollment session
  // (elevated, so the first passkey can be registered). Recovery codes are
  // shown exactly once.
  app.post("/api/auth/email/verify", authLimiter, async (req, res) => {
    try {
      const email = await consumeEmailLink(String(req.body?.token ?? ""), "signup");
      if (!email) return res.status(400).json({ error: "Invalid or expired link" });
      const account = await db.findOrCreateAccountByEmail(email);
      if (!account.created && (await db.listPasskeys(account.id)).length > 0) {
        // Existing accounts with passkeys must sign in with a passkey or use recovery.
        return res.status(409).json({ error: "Account already has passkeys; sign in or use recovery" });
      }
      await startSession(req, res, account.id, "email", { elevated: true });
      const recovery_codes = account.created ? await issueRecoveryCodes(account.id) : undefined;
      const claimed = await db.claimApiKeysByEmail(account.id, email);
      res.json({ account: await accountView(account.id), recovery_codes, claimed_api_keys: claimed });
    } catch (e) {
      authError(res, e);
    }
  });

  // One-time migration for existing key holders: verified email → keys linked.
  app.post("/api/auth/claim", authLimiter, requireSession, async (req, res) => {
    try {
      const email = await consumeEmailLink(String(req.body?.token ?? ""), "claim");
      const account = await db.getAccount(req.session.account_id);
      if (!email || email !== account.email) return res.status(400).json({ error: "Invalid or expired link" });
      res.json({ claimed_api_keys: await db.claimApiKeysByEmail(account.id, email) });
    } catch (e) {
      authError(res, e);
    }
  });

  // Recovery requires BOTH the email link AND an unused recovery code.
  app.post("/api/auth/recovery", authLimiter, async (req, res) => {
    try {
      const email = await consumeEmailLink(String(req.body?.token ?? ""), "recovery");
      const account = email ? await db.getAccountByEmail(email) : null;
      const codeOk = account && (await db.consumeRecoveryCode(account.id, hashRecoveryCode(req.body?.code ?? "")));
      if (!codeOk) return res.status(400).json({ error: "Invalid link or recovery code" });
      await db.revokeAccountSessions(account.id);
      await startSession(req, res, account.id, "recovery", { elevated: true });
      res.json({ account: await accountView(account.id) });
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/passkeys/register/options", requireStepUp, async (req, res) => {
    try {
      const account = await db.getAccount(req.session.account_id);
      const options = await registrationOptions(account);
      await issueChallenge(res, { purpose: "register", challenge: options.challenge, accountId: account.id });
      res.json(options);
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/passkeys/register/verify", requireStepUp, async (req, res) => {
    try {
      const challenge = await takeChallenge(req, res, "register");
      if (!challenge || challenge.account_id !== req.session.account_id) {
        return res.status(400).json({ error: "Challenge expired" });
      }
      const account = await db.getAccount(req.session.account_id);
      const ok = await verifyRegistration(account, req.body?.response, challenge.challenge, req.body?.name);
      if (!ok) return res.status(400).json({ error: "Passkey verification failed" });
      await rotateSession(req, res);
      res.status(201).json({ account: await accountView(account.id) });
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/passkeys/login/options", authLimiter, async (req, res) => {
    try {
      const options = await authenticationOptions();
      await issueChallenge(res, { purpose: "login", challenge: options.challenge });
      res.json(options);
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/passkeys/login/verify", authLimiter, async (req, res) => {
    try {
      const challenge = await takeChallenge(req, res, "login");
      if (!challenge) return res.status(400).json({ error: "Challenge expired" });
      const accountId = await verifyAuthentication(req.body?.response, challenge.challenge);
      if (!accountId) return res.status(401).json({ error: "Passkey sign-in failed" });
      await startSession(req, res, accountId, "passkey");
      res.json({ account: await accountView(accountId) });
    } catch (e) {
      authError(res, e);
    }
  });

  // Step-up re-authentication with a passkey of the signed-in account.
  app.post("/api/auth/step-up/options", requireSession, async (req, res) => {
    try {
      const options = await authenticationOptions(req.session.account_id);
      await issueChallenge(res, { purpose: "step_up", challenge: options.challenge, accountId: req.session.account_id });
      res.json(options);
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/step-up/verify", requireSession, async (req, res) => {
    try {
      const challenge = await takeChallenge(req, res, "step_up");
      if (!challenge || challenge.account_id !== req.session.account_id) {
        return res.status(400).json({ error: "Challenge expired" });
      }
      const accountId = await verifyAuthentication(req.body?.response, challenge.challenge, req.session.account_id);
      if (!accountId) return res.status(401).json({ error: "Re-authentication failed" });
      await rotateSession(req, res, { elevated: true });
      res.json({ elevated: true });
    } catch (e) {
      authError(res, e);
    }
  });

  app.get("/api/auth/me", requireSession, async (req, res) => {
    try {
      res.json({
        account: await accountView(req.session.account_id),
        session: { auth_method: req.session.auth_method, elevated: isElevated(req.session), expires_at: req.session.expires_at },
        api_keys: await db.listAccountApiKeys(req.session.account_id),
      });
    } catch (e) {
      authError(res, e);
    }
  });

  app.delete("/api/auth/passkeys/:id", requireStepUp, async (req, res) => {
    try {
      const ok = await db.deletePasskey(req.session.account_id, req.params.id);
      res.status(ok ? 204 : 404).end();
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/recovery-codes", requireStepUp, async (req, res) => {
    try {
      res.json({ recovery_codes: await issueRecoveryCodes(req.session.account_id) });
    } catch (e) {
      authError(res, e);
    }
  });

  // Account-owned API keys; admin-scoped keys require a step-up.
  app.post("/api/auth/api-keys", requireSession, async (req, res) => {
    try {
      const { name, tier, scopes, expires_at } = req.body ?? {};
      const wantsAdmin = Array.isArray(scopes) && scopes.some((s) => String(s).startsWith("admin:"));
      if (wantsAdmin && !isElevated(req.session)) {
        return res.status(403).json({ error: "Re-authentication required", step_up: true });
      }
      const account = await db.getAccount(req.session.account_id);
      const result = await createKey(
        { name, tier, scopes, expires_at, email: account.email, verified: true },
        { allowAdmin: wantsAdmin },
      );
      await db.assignApiKeyAccount(result.record.id, account.id);
      res.status(201).json(result);
    } catch (e) {
      res.status(/required|must be|scope/i.test(e.message) ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      await endSession(req, res);
      res.status(204).end();
    } catch (e) {
      authError(res, e);
    }
  });

  // SEP-10: link a wallet (stepped-up session) or sign in with a linked wallet.
  app.get("/api/auth/stellar/challenge", authLimiter, async (req, res) => {
    try {
      if (!sep10Enabled()) return res.status(404).json({ error: "SEP-10 sign-in is not enabled" });
      const account = String(req.query.account ?? "");
      if (!/^G[A-Z2-7]{55}$/.test(account)) return res.status(400).json({ error: "account must be a G... address" });
      const transaction = buildSep10Challenge(account);
      await issueChallenge(res, { purpose: "stellar", challenge: transaction, accountId: req.session?.account_id ?? null });
      res.json({ transaction });
    } catch (e) {
      authError(res, e);
    }
  });

  app.post("/api/auth/stellar/verify", authLimiter, async (req, res) => {
    try {
      const challenge = await takeChallenge(req, res, "stellar");
      if (!challenge) return res.status(400).json({ error: "Challenge expired" });
      const address = verifySep10Challenge(String(req.body?.transaction ?? ""), challenge.challenge);
      if (req.session) {
        if (!isElevated(req.session)) return res.status(403).json({ error: "Re-authentication required", step_up: true });
        await db.linkStellarAddress(req.session.account_id, address);
        return res.json({ linked: address });
      }
      const account = await db.getAccountByStellarAddress(address);
      if (!account) return res.status(404).json({ error: "No account is linked to this wallet" });
      await startSession(req, res, account.id, "stellar");
      res.json({ account: await accountView(account.id) });
    } catch (e) {
      res.status(e.status ?? 400).json({ error: e.message });
    }
  });

  // ── API Documentation ────────────────────────────────────────────────────────
  const openApiPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/api/openapi.yaml");
  if (fs.existsSync(openApiPath)) {
    // Avoid dynamic imports during test runs which may resolve after Jest
    // tears down the environment and cause 'import after teardown' errors.
    // Detect test runs started by Jest (NODE_ENV may not always be set).
    const runningUnderTest =
      process.env.NODE_ENV === "test" || !!process.env.JEST_WORKER_ID || !!process.env.NODE_TEST_CONTEXT;
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

  app.post("/api/sql", async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["query", "format"].includes(key))
    ) {
      return res.status(400).json({ error: "Expected only query and format fields" });
    }
    try {
      const result = await executeAnalyticsQuery(body.query, {
        clientId: req.rateContext?.keyId ?? req.rateContext?.clientId ?? "anonymous",
        tier: req.rateContext?.tier ?? "unauthenticated",
        format: body.format ?? "json",
      });
      if (result.format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=analytics.csv");
        res.setHeader("X-Row-Count", String(result.row_count));
        res.setHeader("X-Results-Truncated", String(result.truncated));
        return res.send(toCsv(result.rows));
      }
      res.json(result);
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      if (!analyticsPool) {
        return res.status(503).json({ error: "Analytics database is not configured" });
      }
      logger.error("[analytics-sql] Query failed:", error.message);
      res.status(500).json({ error: "Analytics query failed" });
    }
  });

  app.post("/api/rpc", async (req, res) => {
    const body = req.body;
    const id = body?.id ?? null;
    const rpcError = (status, code, message) =>
      res.status(status).json({ jsonrpc: "2.0", id, error: { code, message } });

    if (Buffer.byteLength(JSON.stringify(body ?? {})) > 32_768) {
      return rpcError(413, -32600, "RPC request exceeds 32768 bytes");
    }
    if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(400, -32600, "Invalid JSON-RPC request");
    }
    if (!ALLOWED_RPC_METHODS.has(body.method)) {
      return rpcError(403, -32601, "RPC method is not allowed");
    }

    try {
      const result = await proxyRpcRequest(body.method, body.params ?? {});
      res.json({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const status = error.statusCode ?? 502;
      const code = status === 400 ? -32602 : -32000;
      if (status >= 500) logger.warn("[rpc-proxy] RPC request failed:", error.message);
      rpcError(status, code, status >= 500 ? "Soroban RPC request failed" : error.message);
    }
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

  // RFC 9116 security contact (#932) — mirrors frontend/public/.well-known/security.txt.
  app.get("/.well-known/security.txt", (_req, res) => {
    res.type("text/plain").send(
      [
        "Contact: https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/security/advisories/new",
        "Expires: 2027-09-26T00:00:00.000Z",
        "Policy: https://github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/blob/main/SECURITY.md",
        "Preferred-Languages: en",
        "",
      ].join("\n"),
    );
  });

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
  app.get("/api/load-shedder", (_req, res) => {
    res.json(getLoadShedderMetrics());
  });

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
  app.get("/metrics", requireMetricsApiKey, async (_req, res) => {
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

  // GET /api/events?contract=&fn=&type=&cursor=&after=&before=&after_seq=&limit=&count=
  // Keyset (cursor) pagination — supports bidirectional navigation with signed tokens.
  // Legacy offset/page supported during deprecation window.
  app.get(
    "/api/events",
    // Validate before the cache middleware so malformed params can never be
    // served a cached 200 (their cache key normalizes to the first page).
    (req, res, next) => {
      if (handleLegacyOffset(req, res)) return;

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
      for (const key of ["from", "to"]) {
        if (req.query[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[key]))) {
          return res.status(422).json({ error: `Invalid ${key}` });
        }
      }
      next();
    },
    // Filter DSL (#902): ?filter=<text or JSON AST> or ?query_id=<saved query>.
    // Served uncached — results depend on the caller's tier limits.
    async (req, res, next) => {
      if (req.query.filters !== undefined) return runRpcFilteredEvents(req, res, req.query.filters);
      if (req.query.filter === undefined && req.query.query_id === undefined) return next();
      await runFilteredEvents(req, res);
    },
    makeCache("events_list", (req) => {
      const { contract = "", fn = "", type = "", cursor = "", after = "", before = "", count = "" } = req.query;
      const afterSeq = Number(req.query.after_seq) || 0;
      const limit = Number(req.query.limit) || 25;
      return `events:list:${contract}:${fn}:${cursor}:${after}:${before}:${afterSeq}:${limit}:${type}:${count}`;
    }),
    async (req, res) => {
      try {
        const contract = req.query.contract || undefined;
        const fn = req.query.fn || undefined;
        const type = req.query.type || undefined;
        const cursor = req.query.cursor || undefined;
        const after = req.query.after || undefined;
        const before = req.query.before || undefined;
        const after_seq = req.query.after_seq ? Number(req.query.after_seq) : 0;
        const limit = req.query.limit ? Number(req.query.limit) : 25;
        const count = req.query.count || undefined;

        const result = await db.getEventsCursor({
          contract,
          fn,
          type,
          cursor,
          after,
          before,
          after_seq,
          limit,
          count,
        });

        // Predictive pre-fetch: next page if user is paginating
        if (result.next_cursor !== null) {
          const key = `events:list:${contract ?? ""}:${fn ?? ""}:${cursor ?? ""}:${after ?? ""}:${before ?? ""}:${after_seq}:${limit}:${type ?? ""}:${count ?? ""}`;
          schedulePrefetch(key, {
            [`events:list:${contract ?? ""}:${fn ?? ""}:${result.next_cursor}::::0:${limit}:${type ?? ""}:${count ?? ""}`]:
              () => db.getEventsCursor({ contract, fn, type, after: result.next_cursor, limit, count }),
          });
        }
        res.json(result);
      } catch (e) {
        if (handleCursorError(e, res)) return;
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ── Event filter DSL + saved queries (#902) ─────────────────────────────────
  // Grammar and limits: docs/guides/filters.md.

  /** Parse, plan and run a filter for GET /api/events or a saved query. */
  async function runFilteredEvents(req, res, savedFilter) {
    try {
      let input = savedFilter;
      if (input === undefined && req.query.query_id !== undefined) {
        if (!req.rateContext?.keyId) return res.status(401).json({ error: "Saved queries require an API key" });
        const saved = await db.getSavedQuery(String(req.query.query_id), req.rateContext.keyId);
        if (!saved) return res.status(404).json({ error: "Saved query not found" });
        input = saved.filter;
      }
      const ast = toFilterAst(input ?? req.query.filter);
      const plan = planFilter(ast);
      if (!plan.ok) return res.status(422).json({ error: `Filter cannot use an index: ${plan.reason}` });
      const { sql, params } = compileFilter(ast);
      const limits = FILTER_TIER_LIMITS[req.rateContext?.tier] ?? FILTER_TIER_LIMITS.unauthenticated;
      const limit = Math.min(Number(req.query.limit) || 25, 200);
      const afterSeq = Number(req.query.after_seq) || 0;
      const result = await db.queryEventsByFilter({ where: sql, params, afterSeq, limit, ...limits });
      res.set("Cache-Control", "no-store").json(result);
    } catch (e) {
      if (e instanceof FilterError) return res.status(400).json({ error: e.message });
      res.status(e.status ?? 500).json({ error: e.message });
    }
  }

  // ── Soroban-RPC-compatible filters (#903) ──────────────────────────────────
  // GET /api/events?filters=<URL-encoded JSON> or POST /api/events { filters }.
  async function runRpcFilteredEvents(req, res, input) {
    try {
      const filters = parseRpcFilters(input);
      const { sql, params } = compileRpcFilters(filters);
      const limits = FILTER_TIER_LIMITS[req.rateContext?.tier] ?? FILTER_TIER_LIMITS.unauthenticated;
      const source = req.method === "POST" ? req.body ?? {} : req.query;
      const limit = Math.min(Number(source.limit) || 25, 200);
      const afterSeq = Number(source.after_seq) || 0;
      const result = await db.queryEventsByFilter({ where: sql, params, afterSeq, limit, ...limits });
      res.set("Cache-Control", "no-store").json(result);
    } catch (e) {
      if (e instanceof RpcFilterError) return res.status(400).json({ error: e.message });
      res.status(e.status ?? 500).json({ error: e.message });
    }
  }

  app.post("/api/events", async (req, res) => {
    if (req.body?.filters === undefined) {
      return res.status(400).json({ error: "body must contain an RPC-style filters array" });
    }
    await runRpcFilteredEvents(req, res, req.body.filters);
  });

  const requireKey = (req, res) => {
    if (!req.rateContext?.keyId) {
      res.status(401).json({ error: "An API key is required" });
      return null;
    }
    return req.rateContext.keyId;
  };

  app.post("/api/queries", async (req, res) => {
    const keyId = requireKey(req, res);
    if (!keyId) return;
    const { name, filter } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || name.length > 128) {
      return res.status(400).json({ error: "name is required (max 128 characters)" });
    }
    try {
      const ast = toFilterAst(filter);
      const plan = planFilter(ast);
      if (!plan.ok) return res.status(422).json({ error: `Filter cannot use an index: ${plan.reason}` });
      res.status(201).json(await db.createSavedQuery({ apiKeyId: keyId, name: name.trim(), filter: ast }));
    } catch (e) {
      res.status(e instanceof FilterError ? 400 : 500).json({ error: e.message });
    }
  });

  app.get("/api/queries", async (req, res) => {
    const keyId = requireKey(req, res);
    if (keyId) res.json({ data: await db.listSavedQueries(keyId) });
  });

  app.get("/api/queries/:id/events", async (req, res) => {
    const keyId = requireKey(req, res);
    if (!keyId) return;
    const saved = await db.getSavedQuery(req.params.id, keyId).catch(() => null);
    if (!saved) return res.status(404).json({ error: "Saved query not found" });
    await runFilteredEvents(req, res, saved.filter);
  });

  app.delete("/api/queries/:id", async (req, res) => {
    const keyId = requireKey(req, res);
    if (!keyId) return;
    const deleted = await db.deleteSavedQuery(req.params.id, keyId).catch(() => false);
    if (!deleted) return res.status(404).json({ error: "Saved query not found" });
    res.status(204).end();
  });

  // GET /api/search?q=&limit=
  app.get(
    "/api/search",
    makeCache("search", (req) => {
      const { q = "", limit = "10" } = req.query;
      return `search:${req.rateContext?.keyId || "public"}:${String(q).toLowerCase()}:${limit}`;
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

  // GET /api/events/:id — canonical event ID (#892). Numeric seq is still
  // accepted for one deprecation cycle and redirected to the event ID.
  app.get(
    "/api/events/:seq",
    makeCache("events_single", (req) => `events:single:${req.params.seq}`),
    async (req, res) => {
      try {
        if (EVENT_ID_RE.test(req.params.seq)) {
          const byId = await db.getEventByEventId(req.params.seq);
          if (!byId) return res.status(404).json({ error: `Event ${req.params.seq} not found` });
          return res.json(byId);
        }
        const ev = await db.getEvent(Number(req.params.seq));
        if (ev?.event_id) {
          res.set("Deprecation", "true");
          res.set("Link", `</api/events/${ev.event_id}>; rel="canonical"`);
          return res.redirect(301, `/api/events/${ev.event_id}`);
        }
        if (!ev) {
          return res.status(404).json({
            type: "about:blank",
            title: "Not Found",
            status: 404,
            detail: `Event sequence ${req.params.seq} not found`,
          });
        }
        res.json(ev);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  app.get("/api/events/:seq/proof", async (req, res) => {
    try {
      const proof = await db.getEventProof(Number(req.params.seq));
      if (!proof) return res.status(404).json({ error: "Not found" });
      res.json(proof);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/events/:seq/lineage — public provenance summary (#945).
  // The full chain (run IDs, provider sources, ledger ranges) is admin-only.
  app.get("/api/events/:seq/lineage", async (req, res) => {
    try {
      const seq = Number(req.params.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) return res.status(400).json({ error: "Invalid event id" });
      const lineage = await getEventLineage(seq, { full: false });
      if (!lineage) return res.status(404).json({ error: "Not found" });
      res.json(lineage);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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

  // POST /api/events/filter
  // Advanced event filtering using DSL with support for arg/topic predicates
  // Request body: { filter: DSL object, after_seq?: number, limit?: number }
  // Response: { data: Event[], next_cursor: number|null, cost: number }
  app.post("/api/events/filter", async (req, res) => {
    try {
      const { filter, after_seq, limit } = req.body;

      // Validate filter DSL
      const validation = validateFilter(filter);
      if (!validation.valid) {
        return res.status(422).json({ error: validation.error });
      }

      // Convert DSL to SQL
      const { where, params } = filterToSql(filter);

      // Add pagination
      const afterSeq = after_seq ? Number(after_seq) : 0;
      const limitValue = limit ? Math.min(Number(limit), 200) : 25;

      let sqlWhere = where;
      let sqlParams = [...params];

      if (afterSeq > 0) {
        sqlWhere = sqlWhere ? `${sqlWhere} AND seq < $${sqlParams.length + 1}` : `seq < $${sqlParams.length + 1}`;
        sqlParams.push(afterSeq);
      }

      const finalWhere = sqlWhere ? `WHERE ${sqlWhere}` : "";
      sqlParams.push(limitValue + 1); // Fetch one extra to detect next page

      const { rows } = await pool.query(
        `SELECT *, CASE WHEN contract_id IS NULL OR contract_id = '' THEN 'classic' ELSE 'soroban' END AS type
         FROM events ${finalWhere} ORDER BY seq DESC LIMIT $${sqlParams.length}`,
        sqlParams
      );

      const data = rows.slice(0, limitValue);
      const next_cursor = rows.length > limitValue ? rows[limitValue - 1].seq : null;

      // Estimate cost for UI
      const cost = estimateFilterCost(filter);

      res.json({ data, next_cursor, cost });
    } catch (e) {
      logger.error("Event filter error", { error: e.message, filter: req.body.filter });
      res.status(500).json({ error: e.message });
    }
  });

  // Transaction status server-sent events endpoint
  app.get("/api/tx/:hash", async (req, res) => {
    try {
      const transaction = await db.getTransaction(req.params.hash);
      if (!transaction) return res.status(404).json({ error: "Transaction not found" });
      res.json(transaction);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get("/api/accounts/:id/transactions", async (req, res) => {
    try { res.json(await db.getAccountTransactions(req.params.id, req.query.limit)); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });

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

  // GET /api/contracts?cursor=&after=&before=&page=&limit=&type=&q=&count=
  app.get(
    "/api/contracts",
    (req, res, next) => {
      if (handleLegacyOffset(req, res)) return;
      next();
    },
    makeCache("contracts_list", (req) => {
      const page = req.query.page || "";
      const limit = Number(req.query.limit) || 25;
      const q = req.query.q || "";
      const type = req.query.type || "all";
      const cursor = req.query.cursor || req.query.after || req.query.before || "";
      return `contracts:list:${page}:${limit}:${q}:${type}:${cursor}`;
    }),
    async (req, res) => {
      try {
        const result = await db.listContracts({
          page: req.query.page,
          limit: req.query.limit ? Number(req.query.limit) : 25,
          type: req.query.type,
          q: req.query.q,
          cursor: req.query.cursor,
          after: req.query.after,
          before: req.query.before,
          count: req.query.count,
        });
        res.json(result);
      } catch (e) {
        if (handleCursorError(e, res)) return;
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

  // GET /api/contracts/:id/events?cursor=&after=&before=&page=&limit=&count=  — events for a specific contract
  app.get(
    "/api/contracts/:id/events",
    (req, res, next) => {
      if (handleLegacyOffset(req, res)) return;
      next();
    },
    makeCache("contract_events", (req) => {
      const cursor = req.query.cursor || req.query.after || req.query.before || "";
      const page = req.query.page ?? "";
      const limit = req.query.limit ?? 25;
      return `contracts:events:${req.params.id}:${cursor}:${page}:${limit}`;
    }),
    async (req, res) => {
      try {
        const isLegacy =
          !req.query.cursor &&
          !req.query.after &&
          !req.query.before &&
          (req.query.page !== undefined || req.query.offset !== undefined);
        const limit = Math.min(Number(req.query.limit) || 25, 100);

        if (isLegacy) {
          const page = Number(req.query.page) || 1;
          const rows = await db.getEvents({
            contract: req.params.id,
            page,
            limit,
          });
          return res.json({
            events: rows,
            data: rows,
            pagination: {
              page,
              limit,
              total: rows.length,
            },
          });
        }

        const result = await db.getEventsCursor({
          contract: req.params.id,
          cursor: req.query.cursor,
          after: req.query.after,
          before: req.query.before,
          limit,
          count: req.query.count,
        });

        res.json({
          events: result.data,
          data: result.data,
          page_info: result.page_info,
          next_cursor: result.next_cursor,
          total: result.total,
          count_is_estimate: result.count_is_estimate,
        });
      } catch (e) {
        if (handleCursorError(e, res)) return;
        res.status(500).json({ error: e.message });
      }
    },
  );

  // GET /api/contracts/:id
  app.get(
    "/api/contracts/:id",
    makeCache("contracts_single", (req) => `contracts:single:${req.rateContext?.keyId || "public"}:${req.params.id}`),
    async (req, res) => {
      try {
        const meta = await db.getContractMeta(req.params.id);
        if (!meta) return res.status(404).json({ error: "Not found" });
        // Held/hidden/rejected registrations keep their on-chain data but not
        // their curated metadata (#934).
        if (HIDDEN_STATUSES.includes(meta.moderation_status)) {
          return res.json({
            id: meta.id,
            moderation_status: meta.moderation_status,
            name: null,
            description: null,
            functions: [],
          });
        }

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

  // POST /api/contracts/:id/simulate — Read/Write tab simulation (#913)
  // Wraps the general /api/simulate endpoint with a contract-scoped URL.
  app.post("/api/contracts/:id/simulate", writeLimiter, async (req, res) => {
    try {
      const contractId = req.params.id;
      const { function: fn, args = {} } = req.body;
      if (!fn) return res.status(400).json({ error: "Missing function name" });

      const { rpc: SorobanRpc, Contract, nativeToScVal, TransactionBuilder, Networks, BASE_FEE, Account } = await import("@stellar/stellar-sdk");
      const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
      const server = new SorobanRpc.Server(rpcUrl, { allowHttp: true });

      const contract = new Contract(contractId);
      // Convert named-args object to positional ScVal array
      const scArgs = Object.values(args).map((a) => nativeToScVal(a));
      const op = contract.call(fn, ...scArgs);

      const dummySource = process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      const account = new Account(dummySource, "0");
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        return res.json({ error: sim.error });
      }

      const { scValToNative } = await import("@stellar/stellar-sdk");
      const retval = sim.result?.retval;
      res.json({
        result: retval ? scValToNative(retval) : null,
        fee_stroops: sim.minResourceFee ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/contracts/:id/reports — "Report this contract" (#934)
  app.post("/api/contracts/:id/reports", writeLimiter, async (req, res) => {
    try {
      const reporter = req.rateContext?.keyId ? String(req.rateContext.keyId) : `ip:${req.ip}`;
      const result = await reportContract(req.params.id, {
        reporter,
        reason: String(req.body?.reason ?? ""),
        details: req.body?.details ? String(req.body.details) : null,
      });
      res.status(201).json(result);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  // POST /api/contracts/:id/appeals — submitter appeals a moderation decision (#934)
  app.post("/api/contracts/:id/appeals", writeLimiter, async (req, res) => {
    try {
      const submitter = req.rateContext?.keyId ?? null;
      if (!submitter) return res.status(401).json({ error: "Appeals require the API key used to register" });
      const appeal = await fileAppeal(req.params.id, { submitter, message: String(req.body?.message ?? "") });
      res.status(201).json(appeal);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

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
      const keyId = req.rateContext?.keyId ?? null;
      if (req.body.is_private && !keyId) {
        return res.status(400).json({ error: "Private contracts require a per-key API credential" });
      }

      const existing = await db.getContractMeta(id);
      if (existing) {
        return res.status(409).json({ error: "Contract already exists" });
      }

      // Verify ABI against on-chain spec if enabled
      let abiMismatches = 0;
      if (process.env.VERIFY_ABI !== "false") {
        const verification = await verifyAbi(id, functions);
        abiMismatches = (verification.missingFunctions?.length ?? 0) + (verification.argMismatch?.length ?? 0);

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

      await db.upsertContractMeta({
        ...req.body,
        registered_by_key_id: keyId,
      });
      // ── Issue #523: store the registrant's API key ID for ownership checks
      if (keyId) {
        await db.query("UPDATE contracts SET registered_by_key_id = $1 WHERE id = $2", [keyId, id]).catch(() => {});
      }
      // Risk scoring (#934): low → published, medium → pending, high → held.
      const moderation = await evaluateSubmission(id, req.body, {
        submitter: keyId ?? req.body.registered_by,
        abiMismatches,
      });
      await cacheInvalidate(`contracts:single:*:${id}`);
      res.status(201).json({ ok: true, moderation_status: moderation.status });
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
      const { rows } = await db.query("SELECT registered_by_key_id FROM contracts WHERE id = $1", [contractId]);
      const registeredByKeyId = rows[0]?.registered_by_key_id ?? null;

      // Check if caller is admin (tier = 'enterprise' or static admin key)
      const isAdmin = req.rateContext?.tier === "enterprise" || req.rateContext?.clientId === "static-admin-key";

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
      await cacheInvalidate(`contracts:single:*:${contractId}`);
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

  // ── Collaborative sandbox sessions (#926) ───────────────────────────────────
  // Sync runs over WebSocket at /collab/:sessionId (collab/server.js); these
  // routes create sessions and let the owner rotate link tokens / kick.
  app.post("/api/collab/sessions", async (req, res) => {
    try {
      const sandboxId = typeof req.body?.sandboxId === "string" ? req.body.sandboxId.slice(0, 128) : null;
      res.status(201).json(await createCollabSession({ sandboxId }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const requireCollabOwner = async (req, res) => {
    const role = await authorizeCollab(req.params.id, req.get("x-collab-token"));
    if (role !== "owner") {
      res.status(403).json({ error: "Only the session owner can do this" });
      return false;
    }
    return true;
  };

  app.post("/api/collab/sessions/:id/rotate", async (req, res) => {
    try {
      const role = req.body?.role;
      if (role !== "edit" && role !== "view") return res.status(400).json({ error: "role must be edit or view" });
      if (!(await requireCollabOwner(req, res))) return;
      res.json({ role, token: await rotateCollabToken(req.params.id, role) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/collab/sessions/:id/kick", async (req, res) => {
    try {
      if (!(await requireCollabOwner(req, res))) return;
      kickCollabParticipants(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sandboxes", async (req, res) => {
    try {
      if (handleLegacyOffset(req, res)) return;

      const result = await db.listSandboxes({
        cursor: req.query.cursor,
        after: req.query.after,
        before: req.query.before,
        page: req.query.page,
        limit: req.query.limit,
        offset: req.query.offset,
        count: req.query.count,
      });
      res.json(result);
    } catch (e) {
      if (handleCursorError(e, res)) return;
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/sandbox/ledger-entries — RPC proxy used by the in-browser host
  // (#925) to import contract state: { keys: [LedgerKey XDR base64] }.
  app.post("/api/sandbox/ledger-entries", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const keys = req.body?.keys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 200 || !keys.every((k) => typeof k === "string")) {
        return res.status(400).json({ error: "keys must be an array of 1-200 base64 LedgerKey XDR strings" });
      }
      const { rpc: SorobanRpc, xdr } = await import("@stellar/stellar-sdk");
      const server = new SorobanRpc.Server(RPC_URL);
      const [found, network, latest] = await Promise.all([
        server.getLedgerEntries(...keys.map((k) => xdr.LedgerKey.fromXDR(k, "base64"))),
        server.getNetwork(),
        server.getLatestLedger(),
      ]);
      res.json({
        entries: found.entries.map((e) => ({
          key: e.key.toXDR("base64"),
          entry: new xdr.LedgerEntry({ lastModifiedLedgerSeq: e.lastModifiedLedgerSeq ?? 0, data: e.val, ext: new xdr.LedgerEntryExt(0) }).toXDR("base64"),
          liveUntilLedgerSeq: e.liveUntilLedgerSeq ?? null,
        })),
        latestLedger: latest.sequence,
        protocolVersion: latest.protocolVersion ?? network.protocolVersion,
        networkPassphrase: network.passphrase,
      });
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
        // Footprint (SorobanTransactionData XDR) so the in-browser host (#925)
        // can import exactly the entries an invocation touches.
        transactionData: sim.transactionData ? sim.transactionData.build().toXDR("base64") : undefined,
        events: (sim.events ?? []).map((e) => e.toXDR("base64")),
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
    makeCache("wallet", (req) => `wallet:events:${req.params.address}:${req.query.after_seq || 0}:${req.query.limit || 25}:${req.query.fn || ""}:${req.query.from || ""}:${req.query.to || ""}`),
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
    },
  );

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
    },
  );

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

  // GET /api/tokens/:id/metadata — SEP-41 token metadata (#915)
  // Returns name, symbol, decimals fetched via on-chain simulation.
  app.get("/api/tokens/:id/metadata", async (req, res) => {
    try {
      const contractId = req.params.id;
      const meta = await fetchTokenMetadata(contractId);
      res.json({ contract_id: contractId, ...meta });
    } catch (e) {
      res.status(502).json({ error: e.message });
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
  // Older clients still call /api/tokens/:contractId/analytics — accept that
  // alias while keeping the canonical /nfts/analytics route.
  const nftAnalyticsHandler = async (req, res) => {
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
  };
  app.get("/api/tokens/:contractId/nfts/analytics", nftAnalyticsHandler);
  app.get("/api/tokens/:contractId/analytics", nftAnalyticsHandler);

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
  // GET /api/v1/events?contract=&fn=&type=&cursor=&after=&before=&limit=&count=
  app.get("/api/v1/events", async (req, res) => {
    try {
      if (handleLegacyOffset(req, res)) return;

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
        cursor: req.query.cursor || undefined,
        after: req.query.after || undefined,
        before: req.query.before || undefined,
        after_seq: req.query.after_seq ? Number(req.query.after_seq) : 0,
        limit: req.query.limit ? Number(req.query.limit) : 25,
        count: req.query.count || undefined,
      });
      res.json(result);
    } catch (e) {
      if (handleCursorError(e, res)) return;
      res.status(500).json({ error: e.message });
    }
  });

  // ── Contract transaction history ─────────────────────────────────
  // GET /api/v1/contracts/:id/transactions?function_name=&start_ledger=&end_ledger=&cursor=&after=&before=&page=&limit=
  app.get("/api/v1/contracts/:id/transactions", async (req, res) => {
    try {
      if (handleLegacyOffset(req, res)) return;

      const { function_name, start_ledger, end_ledger, page, limit, cursor, after, before } = req.query;
      const result = await db.getContractTransactions(req.params.id, {
        function_name: function_name || undefined,
        start_ledger: start_ledger ? Number(start_ledger) : undefined,
        end_ledger: end_ledger ? Number(end_ledger) : undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Math.min(Number(limit), 100) : 25,
        cursor: cursor || undefined,
        after: after || undefined,
        before: before || undefined,
      });
      res.json(result);
    } catch (e) {
      if (handleCursorError(e, res)) return;
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
      if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "name is required and must be a non-empty string" });
      }
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "email is required and must be a valid email address" });
      }

      // Check if email service is configured
      if (!isConfigured()) {
        return res.status(503).json({ error: "Email service not configured. Contact administrator." });
      }

      // Import crypto and bcrypt for key generation
      const crypto = (await import("crypto")).default;
      const bcrypt = (await import("bcryptjs")).default;

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Generate API key
      const rawKey = crypto
        .randomBytes(32)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const keyPrefix = rawKey.slice(0, 8);
      const keyHash = await bcrypt.hash(rawKey, 12);

      // Insert inactive key with verification data
      const { rows } = await pool.query(
        `INSERT INTO api_keys
           (name, email, key_hash, key_prefix, tier, verified, verification_token, verification_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, email, key_prefix, tier, verified, created_at`,
        [
          name.trim(),
          email.trim().toLowerCase(),
          keyHash,
          keyPrefix,
          "free",
          false,
          verificationToken,
          verificationExpiresAt,
        ],
      );

      // Build verification URL
      const baseUrl = process.env.API_BASE_URL || `http://localhost:${PORT}`;
      const verificationUrl = `${baseUrl}/api/keys/verify?token=${verificationToken}`;

      // Send verification email
      await sendVerificationEmail({
        email: email.trim(),
        keyName: name.trim(),
        verificationUrl,
      });

      // Return success message (do NOT return the key or verification token)
      res.status(201).json({
        message: "API key created successfully. Please check your email to verify and activate your key.",
        keyId: rows[0].id,
        keyPrefix: rows[0].key_prefix,
        email: rows[0].email,
        verified: rows[0].verified,
      });
    } catch (e) {
      logger.error("[POST /api/keys] Error:", e);
      if (e.message.includes("duplicate key") || e.message.includes("unique constraint")) {
        return res.status(409).json({ error: "An API key for this email already exists and is pending verification." });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/keys/introspect — what the presented API key can do (#901).
  app.get("/api/keys/introspect", (req, res) => {
    const ctx = req.rateContext;
    if (!ctx?.keyId && !ctx?.scopes) {
      return res.status(401).json({ error: "Present an API key in the x-api-key header" });
    }
    res.set("Cache-Control", "no-store").json({
      key_id: ctx.keyId,
      name: ctx.keyName,
      tier: ctx.tier,
      scopes: ctx.scopes,
      allowed_contract_ids: ctx.allowedContractIds ?? [],
      allowed_origins: ctx.allowedOrigins ?? [],
      expires_at: ctx.expiresAt ?? null,
    });
  });

  // GET /api/keys/verify?token= - Verify email and activate the key, return the full key once
  app.get("/api/keys/verify", async (req, res) => {
    try {
      const { token } = req.query;

      if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "token is required" });
      }

      // Look up the key by verification token
      const { rows } = await pool.query(
        `SELECT id, name, email, key_hash, key_prefix, tier, verified, verification_expires_at
         FROM api_keys
         WHERE verification_token = $1`,
        [token],
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Invalid verification token" });
      }

      const keyRecord = rows[0];

      // Check if already verified
      if (keyRecord.verified) {
        return res.status(400).json({ error: "This API key has already been verified" });
      }

      // Check if token has expired
      if (new Date(keyRecord.verification_expires_at) < new Date()) {
        return res.status(400).json({ error: "Verification token has expired. Please request a new API key." });
      }

      // Activate the key by setting verified = true and clearing the verification token
      await pool.query(
        `UPDATE api_keys
         SET verified = TRUE,
             verification_token = NULL,
             verification_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [keyRecord.id],
      );

      // Since this is the only time we return the full key, we need to reconstruct it
      // We can't retrieve the original raw key from the hash, so we need to generate a new one
      // and update the record. This is a security trade-off for the one-time display requirement.
      const crypto = (await import("crypto")).default;
      const bcrypt = (await import("bcryptjs")).default;

      const newRawKey = crypto
        .randomBytes(32)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
      const newKeyPrefix = newRawKey.slice(0, 8);
      const newKeyHash = await bcrypt.hash(newRawKey, 12);

      await pool.query(
        `UPDATE api_keys
         SET key_hash = $1, key_prefix = $2, updated_at = NOW()
         WHERE id = $3`,
        [newKeyHash, newKeyPrefix, keyRecord.id],
      );

      // Return the full key (this is the only time it will be shown)
      res.json({
        message: "API key verified and activated successfully. Save this key securely - it will not be shown again.",
        key: newRawKey,
        keyId: keyRecord.id,
        name: keyRecord.name,
        email: keyRecord.email,
        tier: keyRecord.tier,
      });
    } catch (e) {
      logger.error("[GET /api/keys/verify] Error:", e);
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
  // ── Reproducible-build verification (#796) ─────────────────────────────────
  // POST queues a build from source coordinates; the badge is derived solely
  // from verifier-computed hashes, never from submitted metadata.
  app.post("/api/contracts/:id/code-verifications", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const result = await requestVerification(req.params.id, req.body ?? {}, req.rateContext?.keyId ?? null);
      const { status, ...body } = result;
      res.status(status).json(body);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/contracts/:id/code-verification", async (req, res) => {
    try {
      res.json(await getCodeVerification(req.params.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/contracts/:id/source-verifications", writeLimiter, requireApiKey, async (req, res) => {
    try {
      const { wasm_hash, signer, signature, compiler_hash } = req.body;
      if (!wasm_hash || !signer || !signature || !compiler_hash) {
        return res.status(400).json({
          error: "Missing wasm_hash, signer, signature, or compiler_hash",
        });
      }
      if (!verifySourceVerification({ wasm_hash, signer, signature, compiler_hash })) {
        return res.status(400).json({
          error: "Invalid source verification signature",
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
      res.json(rows.filter((row) => verifySourceVerification(row)));
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

  // ── Network metrics (#921) ─────────────────────────────────────
  // GET /api/network/metrics?range=1h|24h|7d
  app.get("/api/network/metrics", async (req, res) => {
    const range = req.query.range || "1h";
    if (!NETWORK_METRIC_RANGES[range]) return res.status(400).json({ error: "range must be 1h, 24h or 7d" });
    try { res.json(await getNetworkMetrics(pool, range)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/ledgers?cursor=&limit= — newest-first ledger listing (#912).
  app.get("/api/ledgers", async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    if (cursor !== null && (!Number.isInteger(cursor) || cursor < 0)) {
      return res.status(400).json({ error: "cursor must be a ledger sequence" });
    }
    try { res.json(await listLedgers(pool, { cursor, limit })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/ledgers/:seq — ledger header, fees, utilization, Soroban txs (#912).
  // Ledgers beyond the indexed tip → 404; older than retention → 200 with
  // status "not_indexed".
  app.get("/api/ledgers/:seq", async (req, res) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 1) return res.status(400).json({ error: "seq must be a positive integer" });
    try {
      const detail = await getLedgerDetail(pool, seq);
      if (detail.status === "future") return res.status(404).json({ error: "ledger_not_found", ledger: seq });
      res.json(detail);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/network/metrics/stream — server-sent latest ledger metrics at ledger cadence.
  app.get("/api/network/metrics/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    let last = null;
    const tick = async () => {
      try {
        const { metrics, recommended, staleness_seconds } = await getNetworkMetrics(pool, "1h");
        const latest = metrics[metrics.length - 1];
        if (latest && latest.ledger !== last) {
          last = latest.ledger;
          res.write(`data: ${JSON.stringify({ metric: latest, recommended, staleness_seconds })}\n\n`);
        }
      } catch { /* keep the stream open; the client shows staleness */ }
    };
    tick();
    const timer = setInterval(tick, 5000);
    req.on("close", () => clearInterval(timer));
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

  // Point-in-time contract storage and per-key temporal history.
  app.get("/api/contracts/:id/state", async (req, res) => {
    const ledger = Number(req.query.ledger);
    if (!Number.isInteger(ledger) || ledger < 0) return res.status(400).json({ error: "ledger must be a non-negative integer" });
    try { res.json(await db.getContractStateAt(req.params.id, ledger, req.query.prefix || null)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/contracts/:id/state/:key/history", async (req, res) => {
    try { res.json(await db.getContractStateHistory(req.params.id, req.params.key)); }
    catch (e) { res.status(500).json({ error: e.message }); }
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

  // GET /api/export/events?format=csv|json&contract=&fn=&type=&wallet=&limit=&schedule=daily|weekly&email=...
  // #528: accepts wallet param to export a single wallet's event history.
  app.get("/api/export/events", async (req, res) => {
    try {
      const format = req.query.format === "json" ? "json" : "csv";
      const limit = Number(req.query.limit) || 10000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        return res.status(422).json({ error: "Invalid limit" });
      }
      const after_seq = Number(req.query.after_seq) || 0;
      if (!Number.isSafeInteger(after_seq) || after_seq < 0) {
        return res.status(422).json({ error: "Invalid after_seq" });
      }
      const wallet = req.query.wallet || undefined;
      const schedule = String(req.query.schedule || req.query.frequency || "").toLowerCase();
      const email = req.query.email ? String(req.query.email).trim() : undefined;
      const rows = await db.getEventsForExport({
        contract: req.query.contract,
        fn: req.query.fn,
        type: req.query.type,
        wallet,
        after_seq,
        limit,
      });

      if (schedule && ["daily", "weekly"].includes(schedule)) {
        if (!email) {
          return res.status(400).json({ error: "email is required when scheduling a recurring export" });
        }
        const csv = rowsToCsv(rows, EVENT_COLUMNS);
        const subject = `${schedule[0].toUpperCase()}${schedule.slice(1)} export for ${wallet || "all events"}`;
        const text = `Your ${schedule} export for ${wallet || "all events"} has been queued.\n\nFilters: contract=${req.query.contract || "all"}, fn=${req.query.fn || "all"}, type=${req.query.type || "all"}, wallet=${wallet || "all"}.\n\nAttachment: ${rows.length} rows exported.\n\nThis message was sent from the Soroban Smart Block Explorer API.`;
        await sendEmail({
          to: email,
          subject,
          html: `<p>Your ${schedule} export is scheduled.</p><p>Filters: ...</p><pre>${String(csv).slice(0, 2000)}</pre>`,
          text,
        });
        return res.status(202).json({
          scheduled: true,
          frequency: schedule,
          email,
          wallet,
          rows: rows.length,
          format,
        });
      }

      if (format === "json") {
        const filename = wallet ? `wallet-${wallet}-events.json` : "events.json";
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", "application/json");
        return res.json(data);
      }
      const filename = wallet ? `wallet-${wallet}-events.csv` : "events.csv";
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "text/csv");
      return res.send(rowsToCsv(data, EVENT_COLUMNS));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Asynchronous query jobs (#906) ──────────────────────────────────────────
  // Heavy exports run as background jobs: submit → poll → download via a
  // short-lived signed URL. Jobs belong to the submitting API key.
  const requireJobKey = (req, res) => {
    const keyId = req.rateContext?.keyId;
    if (!keyId) res.status(401).json({ error: "An API key is required for query jobs" });
    return keyId;
  };
  const loadOwnJob = async (req, res) => {
    const keyId = requireJobKey(req, res);
    if (!keyId) return null;
    const job = await db.getQueryJob(req.params.id).catch(() => null);
    if (!job || job.api_key_id !== keyId) {
      res.status(404).json({ error: "Job not found" });
      return null;
    }
    return job;
  };

  app.post("/api/jobs", async (req, res) => {
    const keyId = requireJobKey(req, res);
    if (!keyId) return;
    const error = validateJobRequest(req.body);
    if (error) return res.status(400).json({ error });
    try {
      const { job, created } = await submitJob({
        apiKeyId: keyId,
        tier: req.rateContext.tier,
        type: req.body.type,
        params: req.body.params ?? {},
        format: req.body.format ?? "ndjson",
        idempotencyKey: req.get("Idempotency-Key") || undefined,
      });
      res.status(created ? 202 : 200).location(`/api/jobs/${job.id}`).json(jobView(job));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  app.get("/api/jobs/:id", async (req, res) => {
    const job = await loadOwnJob(req, res);
    if (job) res.json(jobView(job));
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    const job = await loadOwnJob(req, res);
    if (job) res.json(jobView(await cancelJob(job.id)));
  });

  app.get("/api/jobs/:id/result", async (req, res) => {
    const job = await loadOwnJob(req, res);
    if (!job) return;
    if (job.status !== "succeeded" || !job.result_path) {
      return res.status(409).json({ error: `Job is ${job.status}; no result available`, status: job.status });
    }
    res.json({ ...signedResultUrl(job.id), partial: job.partial, rows: Number(job.rows_written) });
  });

  // Signed-URL download: the signature is the credential, but the owning key
  // must still be valid, so revoking a key makes its results inaccessible.
  app.get("/api/jobs/:id/download", async (req, res) => {
    if (!verifyResultUrl(req.params.id, req.query.expires, req.query.sig)) {
      return res.status(403).json({ error: "Invalid or expired download URL" });
    }
    const job = await db.getQueryJob(req.params.id).catch(() => null);
    if (!job || job.status !== "succeeded" || !job.result_path || !fs.existsSync(job.result_path)) {
      return res.status(404).json({ error: "Result not found" });
    }
    if (!(await db.isApiKeyActive(job.api_key_id))) {
      return res.status(403).json({ error: "The API key that owns this job is no longer active" });
    }
    const csv = job.format === "csv";
    res.setHeader("Content-Type", csv ? "text/csv" : "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="${job.id}.${csv ? "csv" : "ndjson"}"`);
    if (job.partial) res.setHeader("X-Result-Partial", "true");
    fs.createReadStream(job.result_path).pipe(res);
  });

  // GET /api/export/contracts?format=csv|json
  app.get("/api/export/contracts", async (req, res) => {
    try {
      const format = req.query.format === "json" ? "json" : "csv";
      const limit = Number(req.query.limit) || 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        return res.status(422).json({ error: "Invalid limit" });
      }
      const rows = await db.getContractsForExport({ after: req.query.after || undefined, limit });
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      if (hasMore) {
        const last = data.at(-1);
        res.setHeader("X-Next-Cursor", Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url"));
      }
      if (format === "json") {
        res.setHeader("Content-Disposition", 'attachment; filename="contracts.json"');
        res.setHeader("Content-Type", "application/json");
        return res.json(data);
      }
      res.setHeader("Content-Disposition", 'attachment; filename="contracts.csv"');
      res.setHeader("Content-Type", "text/csv");
      return res.send(rowsToCsv(data, CONTRACT_COLUMNS));
    } catch (e) {
      if (e.message === "Invalid contracts cursor") return res.status(422).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Certified Report & Deterministic Signed PDF Endpoints (Issue #805) ────

  // GET /api/reports/event/:seq?format=pdf|json
  app.get("/api/reports/event/:seq", async (req, res) => {
    try {
      const seq = Number(req.params.seq);
      const ev = await db.getEvent(seq);
      if (!ev) {
        return res.status(404).json({ error: `Event sequence ${seq} not found` });
      }

      const result = generateEventReportPdf(ev);

      if (req.query.format === "json") {
        return res.json({
          canonicalData: result.canonicalData,
          verificationHash: result.verificationHash,
          signature: result.signature,
          permalink: result.permalink,
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="event-${seq}-report.pdf"`);
      res.setHeader("X-Report-Hash", result.verificationHash);
      res.setHeader("X-Report-Signature", result.signature);
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.send(result.buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reports/contract/:id?format=pdf|json
  app.get("/api/reports/contract/:id", async (req, res) => {
    try {
      const contractId = req.params.id;
      const contract = await db.getContractMeta(contractId);
      if (!contract) {
        return res.status(404).json({ error: `Contract ${contractId} not found` });
      }

      const result = generateContractReportPdf(contract);

      if (req.query.format === "json") {
        return res.json({
          canonicalData: result.canonicalData,
          verificationHash: result.verificationHash,
          signature: result.signature,
          permalink: result.permalink,
        });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="contract-${contractId}-report.pdf"`);
      res.setHeader("X-Report-Hash", result.verificationHash);
      res.setHeader("X-Report-Signature", result.signature);
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.send(result.buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reports/batch
  app.post("/api/reports/batch", async (req, res) => {
    try {
      const { seqs = [], contract } = req.body || {};
      let events = [];

      if (Array.isArray(seqs) && seqs.length > 0) {
        const bounded = seqs.slice(0, 100);
        for (const s of bounded) {
          const ev = await db.getEvent(Number(s));
          if (ev) events.push(ev);
        }
      } else if (contract) {
        events = await db.getEventsForExport({ contract, limit: 100 });
      }

      if (events.length === 0) {
        return res.status(400).json({ error: "No matching events found for batch report" });
      }

      const result = generateBatchEventsReportPdf(events);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="batch-events-report.pdf"');
      res.setHeader("X-Report-Hash", result.verificationHash);
      res.setHeader("X-Report-Signature", result.signature);
      return res.send(result.buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reports/verify
  app.post("/api/reports/verify", (req, res) => {
    try {
      const { data, hash, signature } = req.body || {};
      if (!data || !hash) {
        return res.status(400).json({ error: "Missing required 'data' or 'hash' fields" });
      }
      const outcome = verifyReport(data, hash, signature);
      return res.json(outcome);
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
  attachEventStreamRoutes(app);
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

      // Dispatch to this server over loopback; never trust the client-supplied
      // Host header as the target (that would be an SSRF vector).
      const base = `http://127.0.0.1:${req.socket.localPort}`;
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
            if (typeof subPath !== "string" || !subPath.startsWith("/") || subPath.startsWith("//")) {
              return { status: 400, body: { error: "path must be a relative API path" } };
            }
            const r = await safeFetch(base + subPath, { ...init, allowPrivate: true, allowHttp: true });
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
      const result = await (await import("./batch.js")).simulateBatch(calls, sourceAccount, networkPassphrase);
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
        { cpuInsns: 0, memBytes: 0, fee: 0 },
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

  // Every route must declare its scopes (#901) — fail fast on a missing entry.
  assertRoutesDeclareScopes(app);

  // ── Start HTTP + WebSocket server ───────────────────────────────────────────
  const server = http.createServer(app);
  if (!runningUnderTest) {
    attachCollabServer(server, pool);
    attachWebSocketServer(server);
  }

  server.on("close", () => logger.info("[api] server closed"));

  // During test runs we avoid calling `listen()` to prevent port conflicts
  // and background handles that outlive the Jest environment. Tests will
  // use the returned `app` or server object directly via supertest.
  if (runningUnderTest) {
    return app;
  }

  server.listen(PORT, () => logger.info(`API listening on :${PORT}`));
  return server;
}

// `startApi` is the name used by src/index.js and the test suite; `createApi`
// is kept for callers that pass { logDestination, dbOverride }. They are aliases.
export { createApi as startApi };
