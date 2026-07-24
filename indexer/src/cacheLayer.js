/**
 * Multi-Tier Cache Layer
 *
 * L1: LRU in-process (per-instance, sub-millisecond)
 * L2: Redis (shared across instances, < 5ms)
 * L3: HTTP Cache-Control headers (CDN/browser edge)
 *
 * Features:
 * - Per-key-type TTL configuration with L3 Cache-Control directives
 * - XFetch stampede protection (probabilistic early expiration)
 * - Cache analytics: hit rates, latency, invalidations, stampede events
 * - Redis Pub/Sub for cross-instance L1 invalidation
 * - ETag generation for HTTP conditional requests (304 Not Modified)
 * - Delta-based partial cache updates (reduces invalidation bandwidth)
 */

import crypto from "crypto";
import config from "./config.js";

// ── TTL configuration by cache type ──────────────────────────────────────────
// l1/l2 in seconds; l3 is the Cache-Control header string for CDN/browser.
const TTL_CONFIG = {
  events_list: { l1: 5, l2: 30, l3: "public, max-age=30, stale-while-revalidate=300" },
  events_single: { l1: 10, l2: 60, l3: "private, max-age=60" },
  contracts_list: { l1: 30, l2: 300, l3: "public, max-age=300, stale-if-error=86400" },
  contracts_single: { l1: 60, l2: 900, l3: "public, max-age=300, stale-if-error=86400" },
  search: { l1: 0, l2: 10, l3: "no-cache, no-store" },
  stats: { l1: 60, l2: 300, l3: "public, max-age=300" },
  default: { l1: 30, l2: 60, l3: "public, max-age=60" },
};

export function getTTL(type) {
  return TTL_CONFIG[type] ?? TTL_CONFIG.default;
}

// ── L1: LRU in-memory cache ───────────────────────────────────────────────────

const L1_MAX = config.CACHE_L1_MAX;
// XFetch tuning: higher beta = more aggressive early recomputes
const XFETCH_BETA = config.CACHE_XFETCH_BETA;

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    // Map preserves insertion order; we re-insert on access to track recency.
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      return null;
    }
    // Move to end = most recently used
    this._map.delete(key);
    this._map.set(key, entry);
    return entry;
  }

  set(key, value, ttlMs, computeMs = 0) {
    this._map.delete(key);
    if (this._map.size >= this.maxSize) {
      // Evict the LRU entry (first in Map iteration order)
      this._map.delete(this._map.keys().next().value);
    }
    this._map.set(key, { value, expiresAt: Date.now() + ttlMs, computeMs });
  }

  delete(key) {
    this._map.delete(key);
  }

  deletePattern(pattern) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;
    for (const key of this._map.keys()) {
      if (prefix ? key.startsWith(prefix) : key === pattern) {
        this._map.delete(key);
      }
    }
  }

  size() {
    return this._map.size;
  }

  keys() {
    return [...this._map.keys()];
  }

  sizeByPattern() {
    const counts = {};
    for (const key of this._map.keys()) {
      const parts = key.split(":");
      const prefix = parts.slice(0, 2).join(":") + ":*";
      counts[prefix] = (counts[prefix] || 0) + 1;
    }
    return counts;
  }
}

const _l1 = new LRUCache(L1_MAX);

// XFetch: return true if entry should be recomputed early to prevent a stampede.
// Algorithm: recompute if now − β·computeMs·ln(rand) ≥ expiresAt
function _shouldXFetch(entry) {
  if (!entry.computeMs || entry.computeMs < 1) return false;
  return Date.now() - XFETCH_BETA * entry.computeMs * Math.log(Math.random()) >= entry.expiresAt;
}

// Keys currently being recomputed (prevents multiple concurrent recomputes).
const _recomputing = new Set();

// ── L2: Redis ─────────────────────────────────────────────────────────────────

let _redis = null;
let _redisSub = null;
const INVALIDATION_CHANNEL = "cache:invalidate";
const _instanceId = process.env.INSTANCE_ID || `inst-${Math.random().toString(36).slice(2, 8)}`;

async function _getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = await import("redis");
    _redis = createClient({ url });
    _redis.on("error", (err) => console.warn("[cache:l2] error:", err.message));
    await _redis.connect();
    console.log("[cache:l2] connected:", url);
    _setupPubSub(url).catch((e) => console.warn("[cache:pubsub] setup failed:", e.message));
    
    // Register Redis client for health checks
    try {
      const { setRedisClient } = await import("./health.js");
      setRedisClient(_redis);
    } catch {
      // Health module may not be available yet
    }
  } catch (err) {
    console.warn("[cache:l2] unavailable, using L1 only:", err.message);
    _redis = null;
  }
  return _redis;
}

async function _setupPubSub(url) {
  const { createClient } = await import("redis");
  _redisSub = createClient({ url });
  _redisSub.on("error", (err) => console.warn("[cache:pubsub] error:", err.message));
  await _redisSub.connect();
  await _redisSub.subscribe(INVALIDATION_CHANNEL, (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.origin === _instanceId) return; // skip own messages
      if (msg.pattern) {
        _l1.deletePattern(msg.pattern);
      } else if (Array.isArray(msg.keys)) {
        msg.keys.forEach((k) => _l1.delete(k));
      }
      _pushAnalyticsEvent(_analytics.invalidations, {
        timestamp: Date.now(),
        ...msg,
        via: "pubsub",
      });
    } catch {
      /* malformed invalidation message — ignore */
    }
  });
  console.log("[cache:pubsub] subscribed to", INVALIDATION_CHANNEL);
}

// ── Analytics ─────────────────────────────────────────────────────────────────

const _analytics = {
  startTime: Date.now(),
  l1: { hits: 0, misses: 0 },
  l2: { hits: 0, misses: 0 },
  invalidations: [], // ring buffer, max 200
  stampedeEvents: [], // ring buffer, max 200
  cachedLatency: [], // ring buffer, max 1000 (ms samples)
  uncachedLatency: [], // ring buffer, max 1000 (ms samples)
  byEndpoint: {}, // cacheType → { hits, misses }
  keyAccess: {}, // key → count
};

function _pushAnalyticsEvent(arr, event, max = 200) {
  arr.push(event);
  if (arr.length > max) arr.shift();
}

function _recordHit(layer, cacheType, key) {
  _analytics[layer].hits++;
  if (cacheType) {
    _analytics.byEndpoint[cacheType] ??= { hits: 0, misses: 0 };
    _analytics.byEndpoint[cacheType].hits++;
  }
  if (key) _analytics.keyAccess[key] = (_analytics.keyAccess[key] || 0) + 1;
}

function _recordMiss(layer, cacheType) {
  _analytics[layer].misses++;
  if (cacheType) {
    _analytics.byEndpoint[cacheType] ??= { hits: 0, misses: 0 };
    _analytics.byEndpoint[cacheType].misses++;
  }
}

function _avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function _ratePerMin(events) {
  const cutoff = Date.now() - 60_000;
  return events.filter((e) => e.timestamp > cutoff).length;
}

// ── Internal: get with full metadata ─────────────────────────────────────────

async function _getWithMeta(key, cacheType) {
  // L1 check
  const l1Entry = _l1.get(key);
  if (l1Entry) {
    if (_shouldXFetch(l1Entry)) {
      // Signal XFetch: caller may recompute, but we return stale value for now
      _pushAnalyticsEvent(_analytics.stampedeEvents, {
        timestamp: Date.now(),
        key,
      });
      _recordHit("l1", cacheType, key);
      return { value: l1Entry.value, layer: "l1", xfetch: true };
    }
    _recordHit("l1", cacheType, key);
    return { value: l1Entry.value, layer: "l1", xfetch: false };
  }
  _recordMiss("l1", cacheType);

  // L2 check
  const redis = await _getRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const wrapped = JSON.parse(raw);
        // Support both wrapped format { __v, __computeMs, __type } and plain values
        const value = wrapped.__v !== undefined ? wrapped.__v : wrapped;
        const computeMs = wrapped.__computeMs ?? 0;
        const ttlType = wrapped.__type ?? cacheType ?? "default";
        const ttl = getTTL(ttlType);
        if (ttl.l1 > 0) {
          _l1.set(key, value, ttl.l1 * 1000, computeMs);
        }
        _recordHit("l2", cacheType, key);
        return { value, layer: "l2", xfetch: false };
      }
    } catch (err) {
      console.warn("[cache:l2] get error:", err.message);
    }
  }
  _recordMiss("l2", cacheType);
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a cached value (L1 first, then L2).
 * Returns the value or null on miss.
 * Backwards-compatible with the old metadataCache.js signature.
 */
export async function cacheGet(key, cacheType) {
  const hit = await _getWithMeta(key, cacheType);
  return hit ? hit.value : null;
}

/**
 * Store a value in L1 and L2.
 * @param {string} key
 * @param {any}    value
 * @param {string|number} [ttlOrType]  cache type string OR TTL seconds (for backwards compat)
 * @param {number} [computeMs]         time taken to compute (enables XFetch)
 */
export async function cacheSet(key, value, ttlOrType = "default", computeMs = 0) {
  let l1Ttl, l2Ttl, type;
  if (typeof ttlOrType === "number") {
    // Backwards-compat: treat as seconds for both layers
    l1Ttl = ttlOrType;
    l2Ttl = ttlOrType;
    type = "default";
  } else {
    const cfg = getTTL(ttlOrType);
    l1Ttl = cfg.l1;
    l2Ttl = cfg.l2;
    type = ttlOrType;
  }

  if (l1Ttl > 0) {
    _l1.set(key, value, l1Ttl * 1000, computeMs);
  }

  const redis = await _getRedis();
  if (redis && l2Ttl > 0) {
    try {
      const wrapped = { __v: value, __computeMs: computeMs, __type: type };
      await redis.set(key, JSON.stringify(wrapped), { EX: l2Ttl });
    } catch (err) {
      console.warn("[cache:l2] set error:", err.message);
    }
  }
}

/**
 * Invalidate a single key.
 * Publishes to Pub/Sub so other instances evict their L1.
 */
export async function cacheDel(key) {
  await cacheInvalidate(key);
}

/**
 * Invalidate by exact key or glob pattern (e.g. "events:list:*").
 * Scans & deletes matching keys in Redis and publishes cross-instance eviction.
 */
export async function cacheInvalidate(keyOrPattern) {
  const isPattern = keyOrPattern.includes("*");
  if (isPattern) {
    _l1.deletePattern(keyOrPattern);
  } else {
    _l1.delete(keyOrPattern);
  }

  const redis = await _getRedis();
  if (redis) {
    try {
      const deletedKeys = [];
      if (isPattern) {
        let cursor = 0;
        do {
          const reply = await redis.scan(cursor, {
            MATCH: keyOrPattern,
            COUNT: 100,
          });
          cursor = reply.cursor;
          if (reply.keys.length) {
            await redis.del(reply.keys);
            deletedKeys.push(...reply.keys);
          }
        } while (cursor !== 0);
      } else {
        await redis.del(keyOrPattern);
        deletedKeys.push(keyOrPattern);
      }

      // Publish for cross-instance L1 eviction via Pub/Sub
      await redis.publish(
        INVALIDATION_CHANNEL,
        JSON.stringify({
          type: "invalidate",
          pattern: isPattern ? keyOrPattern : undefined,
          keys: deletedKeys,
          timestamp: Date.now(),
          origin: _instanceId,
        }),
      );
    } catch (err) {
      console.warn("[cache:invalidate] error:", err.message);
    }
  }

  _pushAnalyticsEvent(_analytics.invalidations, {
    timestamp: Date.now(),
    key: keyOrPattern,
  });
}

/**
 * Cache-aside with XFetch stampede protection.
 * If the cached entry is nearing expiry, one request recomputes early
 * while others continue to receive the cached value.
 */
export async function cacheAside(key, loader, ttlOrType = "default") {
  const hit = await _getWithMeta(key, typeof ttlOrType === "string" ? ttlOrType : "default");

  if (hit && !hit.xfetch) return hit.value;

  // XFetch early recompute: only one concurrent recompute per key
  if (hit?.xfetch && _recomputing.has(key)) return hit.value;
  if (hit?.xfetch) _recomputing.add(key);

  try {
    const start = Date.now();
    const value = await loader();
    const computeMs = Date.now() - start;
    if (value !== null && value !== undefined) {
      await cacheSet(key, value, ttlOrType, computeMs);
    }
    return value;
  } finally {
    _recomputing.delete(key);
  }
}

/**
 * Apply a delta (partial update) to a cached object.
 * Merges `delta` fields into the existing cached value in-place,
 * avoiding a full invalidation + reload cycle.
 */
export async function cacheApplyDelta(key, delta, ttlOrType = "default") {
  const current = await cacheGet(key);
  if (current === null || typeof current !== "object" || Array.isArray(current)) return null;
  const updated = { ...current, ...delta };
  await cacheSet(key, updated, ttlOrType, 0);
  return updated;
}

// ── ETag helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a weak ETag from response data (MD5 of JSON, first 16 hex chars).
 */
export function generateETag(data) {
  const hash = crypto.createHash("md5").update(JSON.stringify(data)).digest("hex").slice(0, 16);
  return `W/"${hash}"`;
}

// ── Latency recording (called by API middleware) ───────────────────────────────

export function recordCachedLatency(ms) {
  _analytics.cachedLatency.push(ms);
  if (_analytics.cachedLatency.length > 1000) _analytics.cachedLatency.shift();
}

export function recordUncachedLatency(ms) {
  _analytics.uncachedLatency.push(ms);
  if (_analytics.uncachedLatency.length > 1000) _analytics.uncachedLatency.shift();
}

// ── Analytics export ──────────────────────────────────────────────────────────

export function getAnalytics() {
  const l1Total = _analytics.l1.hits + _analytics.l1.misses;
  const l2Total = _analytics.l2.hits + _analytics.l2.misses;
  const totalHits = _analytics.l1.hits + _analytics.l2.hits;
  const totalRequests = totalHits + _analytics.l2.misses;

  const topKeys = Object.entries(_analytics.keyAccess)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ key, count }));

  const missRatioByEndpoint = {};
  for (const [type, stats] of Object.entries(_analytics.byEndpoint)) {
    const total = stats.hits + stats.misses;
    missRatioByEndpoint[type] = {
      miss_rate: total ? stats.misses / total : 0,
      hits: stats.hits,
      misses: stats.misses,
    };
  }

  return {
    // 1. Hit rate by layer — data for stacked area chart
    hit_rates: {
      overall: totalRequests ? totalHits / totalRequests : 0,
      l1: l1Total ? _analytics.l1.hits / l1Total : 0,
      l2: l2Total ? _analytics.l2.hits / l2Total : 0,
      counts: { l1: _analytics.l1, l2: _analytics.l2 },
    },
    // 2. Latency improvement — data for comparison bar chart
    latency: {
      cached_avg_ms: _avg(_analytics.cachedLatency),
      uncached_avg_ms: _avg(_analytics.uncachedLatency),
      improvement_factor:
        _avg(_analytics.cachedLatency) && _avg(_analytics.uncachedLatency)
          ? _avg(_analytics.uncachedLatency) / _avg(_analytics.cachedLatency)
          : null,
      recent_cached: _analytics.cachedLatency.slice(-20),
      recent_uncached: _analytics.uncachedLatency.slice(-20),
    },
    // 3. Cache size by key pattern — data for treemap
    size_by_pattern: _l1.sizeByPattern(),
    l1_size: _l1.size(),
    l1_max: L1_MAX,
    // 4. Invalidation rate — data for time series
    invalidations: {
      total: _analytics.invalidations.length,
      rate_per_minute: _ratePerMin(_analytics.invalidations),
      recent: _analytics.invalidations.slice(-20),
    },
    // 5. Top cached keys — data for table
    top_keys: topKeys,
    // 6. Stampede events — data for scatter plot
    stampede_events: {
      total: _analytics.stampedeEvents.length,
      rate_per_minute: _ratePerMin(_analytics.stampedeEvents),
      recent: _analytics.stampedeEvents.slice(-20),
    },
    // 7. Miss ratio by endpoint — data for heat map
    miss_ratio_by_endpoint: missRatioByEndpoint,
    // Meta
    uptime_seconds: Math.floor((Date.now() - _analytics.startTime) / 1000),
    instance_id: _instanceId,
  };
}
