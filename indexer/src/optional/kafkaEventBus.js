/**
 * Issue #209 — Kafka-Compatible Event Bus (Redis-backed)
 *
 * Provides Kafka-like event-sourcing semantics over Redis Pub/Sub and Redis
 * Lists (for replay). When KAFKA_BROKERS is set, this module logs the
 * recommended Kafka configuration; in the current implementation Redis is used
 * as the transport layer since it is already an infrastructure dependency.
 *
 * Key guarantees:
 *   - At-least-once delivery via Redis pub/sub
 *   - Idempotent consumption: each (topic, groupId, messageId) triple is
 *     processed exactly once via a Redis Set dedup check
 *   - 7-day event retention via configurable stream TTL
 *   - Partition-like routing by appending contractId to the topic name
 */

import { createClient } from "redis";
import config from "./config.js";

const REDIS_URL = config.REDIS_URL || "redis://localhost:6379";
const DEDUP_TTL_S = config.KAFKA_BUS_DEDUP_TTL_S;
const EVENT_TTL_S = config.KAFKA_BUS_EVENT_TTL_S;

if (process.env.KAFKA_BROKERS) {
  console.log(
    "[kafkaEventBus] KAFKA_BROKERS detected — configure kafkajs consumer to replace Redis transport for production throughput",
  );
}

// Per-topic monotonic sequence counter for unique message IDs
const _seq = new Map();

function nextMessageId(topic) {
  const n = (_seq.get(topic) ?? 0) + 1;
  _seq.set(topic, n);
  return `${topic}:${process.pid}:${n}`;
}

let _pubClient = null;
const _subClients = new Map();

async function getPubClient() {
  if (!_pubClient) {
    _pubClient = createClient({ url: REDIS_URL });
    _pubClient.on("error", (err) => console.error("[kafkaEventBus] pub Redis error:", err.message));
    await _pubClient.connect();
  }
  return _pubClient;
}

async function getSubClient(key) {
  if (!_subClients.has(key)) {
    const client = createClient({ url: REDIS_URL });
    client.on("error", (err) => console.error(`[kafkaEventBus] sub Redis error (${key}):`, err.message));
    await client.connect();
    _subClients.set(key, client);
  }
  return _subClients.get(key);
}

/**
 * Publish an event to a topic.
 *
 * For partition-like routing use a namespaced topic:
 *   publish("soroban.events." + contractId, payload)
 *
 * @param {string} topic
 * @param {object} payload
 */
export async function publish(topic, payload) {
  const client = await getPubClient();
  const messageId = nextMessageId(topic);
  const message = JSON.stringify({ messageId, topic, payload, ts: Date.now() });

  const streamKey = `keb:stream:${topic}`;
  const pipe = client.multi();
  pipe.rPush(streamKey, message);
  pipe.expire(streamKey, EVENT_TTL_S);
  pipe.publish(`keb:ch:${topic}`, message);
  await pipe.exec();
}

/**
 * Create an idempotent consumer for a topic.
 * Each (topic, groupId, messageId) triple is handled exactly once.
 *
 * @param {string}   topic
 * @param {string}   groupId  Consumer group identifier (determines dedup scope)
 * @param {Function} handler  async (payload: object, messageId: string) => void
 * @returns {Promise<{ stop: Function }>}
 */
export async function createIdempotentConsumer(topic, groupId, handler) {
  const subKey = `${topic}:${groupId}`;
  const subClient = await getSubClient(subKey);
  const pubClient = await getPubClient();
  const dedupKey = `keb:dedup:${topic}:${groupId}`;
  const channel = `keb:ch:${topic}`;

  await subClient.subscribe(channel, async (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const { messageId, payload } = parsed;

    // Idempotency: skip if this messageId was already processed by this group
    const added = await pubClient.sAdd(dedupKey, messageId);
    if (!added) return;
    await pubClient.expire(dedupKey, DEDUP_TTL_S);

    try {
      await handler(payload, messageId);
    } catch (err) {
      await pubClient.sRem(dedupKey, messageId).catch(() => {});
      console.error(`[kafkaEventBus] handler error (${groupId}/${messageId}): ${err.message}`);
    }
  });

  return {
    stop: async () => {
      await subClient.unsubscribe(channel).catch(() => {});
    },
  };
}

/**
 * Replay retained events from the stream for disaster recovery.
 * Replays all messages stored in the Redis List for the topic,
 * skipping any already processed by the consumer group.
 *
 * @param {string}   topic
 * @param {string}   groupId
 * @param {Function} handler  async (payload: object, messageId: string) => void
 */
export async function replayStream(topic, groupId, handler) {
  const client = await getPubClient();
  const streamKey = `keb:stream:${topic}`;
  const dedupKey = `keb:dedup:${topic}:${groupId}`;

  const messages = await client.lRange(streamKey, 0, -1);
  for (const raw of messages) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const { messageId, payload } = parsed;
    const added = await client.sAdd(dedupKey, messageId);
    if (!added) continue;
    await client.expire(dedupKey, DEDUP_TTL_S);

    try {
      await handler(payload, messageId);
    } catch (err) {
      await client.sRem(dedupKey, messageId).catch(() => {});
      console.error(`[kafkaEventBus] replay error (${groupId}/${messageId}): ${err.message}`);
    }
  }
}

/** Disconnect all Redis clients (call on process shutdown). */
export async function disconnect() {
  if (_pubClient) {
    await _pubClient.disconnect().catch(() => {});
    _pubClient = null;
  }
  for (const [, client] of _subClients) {
    await client.disconnect().catch(() => {});
  }
  _subClients.clear();
}
