/**
 * Issue #209 — Redis-Based Leader Election
 *
 * Uses Redis SET NX EX (atomic compare-and-set) to implement distributed
 * leader election across multiple indexer instances.
 *
 * Only the leader processes ledgers; standbys monitor health and attempt to
 * acquire the lease when the leader fails to renew within LEASE_TTL_S seconds.
 * Failover completes within ELECTION_POLL_MS (default 5 seconds).
 */

import { createClient } from "redis";
import config from "./config.js";

const REDIS_URL = config.REDIS_URL || "redis://localhost:6379";
const LEADER_KEY = process.env.LEADER_ELECTION_KEY || config.LEADER_ELECTION_KEY;
const LEASE_TTL_S = config.LEADER_LEASE_TTL_S;
const RENEW_INTERVAL_MS = config.LEADER_RENEW_INTERVAL_MS;
const ELECTION_POLL_MS = config.LEADER_ELECTION_POLL_MS;

let _client = null;
let _instanceId = null;
let _isLeader = false;
let _renewTimer = null;
let _electionTimer = null;

/**
 * Return a stable identifier for this process instance.
 * Format: "<pid>-<startup-timestamp>"
 *
 * @returns {string}
 */
export function getInstanceId() {
  if (!_instanceId) {
    _instanceId = `${process.pid}-${Date.now()}`;
  }
  return _instanceId;
}

async function getClient() {
  if (!_client) {
    _client = createClient({ url: REDIS_URL });
    _client.on("error", (err) => console.error("[leaderElection] Redis error:", err.message));
    await _client.connect();
  }
  return _client;
}

/**
 * Attempt to acquire the leader lease using SET NX EX.
 *
 * @returns {Promise<boolean>} true if this instance became leader
 */
export async function tryAcquireLock() {
  const client = await getClient();
  const id = getInstanceId();
  const result = await client.set(LEADER_KEY, id, { NX: true, EX: LEASE_TTL_S });
  if (result === "OK") {
    _isLeader = true;
    console.log(`[leaderElection] instance ${id} acquired leadership`);
    return true;
  }
  return false;
}

/**
 * Renew the leader lease before it expires.
 * Returns false and clears leader state if leadership was stolen.
 *
 * @returns {Promise<boolean>}
 */
export async function renewLock() {
  if (!_isLeader) return false;
  const client = await getClient();
  const id = getInstanceId();
  const current = await client.get(LEADER_KEY);
  if (current !== id) {
    _isLeader = false;
    console.warn(`[leaderElection] lost leadership — current leader is ${current}`);
    return false;
  }
  await client.expire(LEADER_KEY, LEASE_TTL_S);
  return true;
}

/**
 * Explicitly release the leader lease (e.g. on graceful shutdown).
 */
export async function releaseLock() {
  if (!_isLeader) return;
  const client = await getClient();
  const id = getInstanceId();
  const current = await client.get(LEADER_KEY);
  if (current === id) {
    await client.del(LEADER_KEY);
    console.log(`[leaderElection] instance ${id} released leadership`);
  }
  _isLeader = false;
}

/** @returns {boolean} true if this instance currently holds the leader lease */
export function isLeader() {
  return _isLeader;
}

/**
 * Start the election and renewal loops.
 *
 * - Leader: renews the lease every RENEW_INTERVAL_MS.
 * - Standby: polls for an available lease every ELECTION_POLL_MS.
 *
 * @param {{ onBecomeLeader?: Function, onLoseLeadership?: Function }} callbacks
 */
export function start({ onBecomeLeader, onLoseLeadership } = {}) {
  _renewTimer = setInterval(async () => {
    if (!_isLeader) return;
    const renewed = await renewLock().catch((err) => {
      console.error("[leaderElection] renew error:", err.message);
      return false;
    });
    if (!renewed && _isLeader) {
      _isLeader = false;
      onLoseLeadership?.();
    }
  }, RENEW_INTERVAL_MS);

  _electionTimer = setInterval(async () => {
    if (_isLeader) return;
    const won = await tryAcquireLock().catch((err) => {
      console.error("[leaderElection] election poll error:", err.message);
      return false;
    });
    if (won) onBecomeLeader?.();
  }, ELECTION_POLL_MS);
}

/**
 * Stop the election loop, release the lease, and disconnect from Redis.
 */
export async function stop() {
  clearInterval(_renewTimer);
  clearInterval(_electionTimer);
  _renewTimer = null;
  _electionTimer = null;
  await releaseLock().catch(() => {});
  if (_client) {
    await _client.disconnect().catch(() => {});
    _client = null;
  }
}
