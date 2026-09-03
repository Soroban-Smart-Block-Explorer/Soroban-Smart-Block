# Incident Response Runbook

This guide covers diagnostic and remediation steps for the five named production failure scenarios in the Soroban Smart Block Explorer. Each scenario includes detection methods, diagnostic commands, and step-by-step recovery procedures.

**Quick reference:** All scenarios affect the health status reported by `GET /api/health`.

---

## Scenario 1: Indexer Falls Behind Chain Tip

### Detection

The indexer is considered unhealthy when it lags >120 seconds behind the chain tip (see health.js:updateIndexerStatus).

**Detection methods:**
- **Endpoint:** `GET /api/health` — check `indexer.lagSeconds`
  ```bash
  curl http://localhost:3001/api/health | jq '.indexer.lagSeconds'
  # Returns lag in seconds; >120 = unhealthy
  ```
- **Log pattern:** Search indexer logs for:
  ```
  [indexer] Lag detected
  # or look for absence of recent event processing logs
  ```
- **Metrics:** Prometheus gauge `indexer_lag_seconds` (if exposed via `/api/metrics`)

### Diagnosis

1. **Confirm the lag:**
   ```bash
   curl http://localhost:3001/api/health | jq '.indexer | {healthy, lagSeconds, lastSync, lastLedger}'
   ```
   Expected healthy output: `lagSeconds` < 120, `healthy: true`

2. **Check indexer daemon status:**
   ```bash
   # If running as a process/container
   ps aux | grep node | grep indexer
   
   # Check logs for errors (last 50 lines)
   tail -50 indexer.log | grep -E 'ERROR|error|panic'
   ```

3. **Verify RPC connectivity:**
   ```bash
   # Check if RPC pool is available
   curl http://localhost:3001/api/health | jq '.rpc_nodes'
   # Should show healthy nodes in the pool
   ```

4. **Check database:**
   ```bash
   psql $DATABASE_URL -c "SELECT 1;" 
   # Should return: rows 1 — if connection fails, DB is down
   ```

5. **Inspect the lag source:**
   - If `lagSeconds` is growing: indexer is processing events slower than new ledgers close
   - If `lagSeconds` is stable: indexer may be stuck waiting on RPC or database

### Remediation

**If RPC is unavailable:**
1. Check RPC node pool configuration in `.env`: verify `SOROBAN_RPC_URLS` or `SOROBAN_RPC_URL` is correct
2. Verify network connectivity: `curl -I https://soroban-testnet.stellar.org` (or your RPC URL)
3. If all nodes are down: wait for RPC recovery; indexer will resume automatically

**If database is slow/unavailable:**
1. Check database connection pool:
   ```bash
   psql $DATABASE_URL -c "SELECT datname, numbackends FROM pg_stat_database WHERE datname = current_database();"
   # Compare `numbackends` against `DB_POOL_MAX` in config (default 20)
   # If near max, see Scenario 5 (connection pool exhaustion)
   ```
2. Check for slow queries:
   ```bash
   psql $DATABASE_URL -c "SELECT pid, usename, query, query_start FROM pg_stat_activity WHERE state = 'active' ORDER BY query_start;"
   ```
3. If queries are slow, rebuild indexes or check disk space:
   ```bash
   psql $DATABASE_URL -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) FROM pg_tables ORDER BY pg_total_relation_size DESC LIMIT 5;"
   ```

**If indexer process crashed:**
1. Restart the indexer daemon:
   ```bash
   # If running as a service
   systemctl restart soroban-explorer-indexer
   
   # If running in Docker
   docker restart soroban-explorer-indexer
   
   # If running manually
   npm start  # from indexer/ directory
   ```
2. Monitor logs for recovery:
   ```bash
   tail -f indexer.log | grep -E 'ledger|sync|lag'
   # Should see logs like: "[indexer] Synced to ledger 12345678"
   ```
3. Once restarted, indexer will resume from the last cursor stored in the database

**If indexer is stuck processing events slowly:**
1. Check for decode errors backing up in the DLQ (see Scenario 3)
2. Check if a single transaction is taking too long:
   ```bash
   # Look for repeated log lines for the same tx_hash
   tail -100 indexer.log | grep 'tx_hash' | sort | uniq -c | sort -rn | head -5
   ```
3. If a specific transaction is stuck: you may need to skip it manually (advanced; requires admin access to move DLQ pointer)

---

## Scenario 2: RPC Node Pool Fully Unhealthy

### Detection

All Soroban RPC nodes in the pool are unhealthy (lagging, timing out, or unreachable).

**Detection methods:**
- **Endpoint:** `GET /api/health` — check `rpc_nodes`
  ```bash
  curl http://localhost:3001/api/health | jq '.rpc_nodes'
  # Should show at least one node with healthy=true; if all healthy=false, pool is down
  ```
- **Log pattern:** Search indexer logs for:
  ```
  [rpcMultiNode] No healthy nodes available
  # or repeated RPC timeout/connection errors
  ```
- **Metrics:** Prometheus gauge `rpc_pool_healthy_nodes` (if exposed)

### Diagnosis

1. **Check the pool status:**
   ```bash
   curl http://localhost:3001/api/health | jq '.rpc_nodes[] | {url, healthy, latestLedger}'
   ```
   Expected: at least one node with `healthy: true`

2. **Test RPC nodes directly:**
   ```bash
   # For each RPC URL, test connectivity
   curl -I https://soroban-testnet.stellar.org/soroban/rpc
   # or
   curl -I $(grep SOROBAN_RPC_URL indexer/.env | cut -d'=' -f2)
   ```

3. **Check node lag:**
   ```bash
   # Query each RPC node to see its latest ledger
   # This requires direct RPC access; example using Stellar JS SDK:
   const rpc = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
   rpc.getLatestLedger().then(l => console.log('Latest ledger:', l.sequence));
   ```

4. **Check for network connectivity issues:**
   ```bash
   # From the indexer container/host
   ping soroban-testnet.stellar.org
   traceroute soroban-testnet.stellar.org
   ```

### Remediation

**If a single node is unhealthy but others are healthy:**
1. RPC pool's automatic failover will handle this — no manual action needed
2. Monitor logs to confirm failover is working:
   ```bash
   tail -f indexer.log | grep "rpcMultiNode"
   ```

**If all nodes are unhealthy (network outage, RPC down for maintenance):**
1. Verify RPC status:
   - Check the Stellar status page: https://status.stellar.org
   - Check your cloud provider's status dashboard
2. Wait for RPC recovery — indexer will automatically resume
3. Monitor lag and DLQ to see if backlog builds up during outage:
   ```bash
   curl http://localhost:3001/api/health | jq '{lagSeconds: .indexer.lagSeconds, dlqDepth: .dlq_depth}'
   ```

**If RPC configuration is incorrect:**
1. Verify `SOROBAN_RPC_URL` or `SOROBAN_RPC_URLS` in `indexer/.env`:
   ```bash
   grep SOROBAN_RPC indexer/.env
   ```
2. Correct the URL and restart the indexer:
   ```bash
   systemctl restart soroban-explorer-indexer
   # or
   docker restart soroban-explorer-indexer
   ```

---

## Scenario 3: Dead Letter Queue Backing Up

### Detection

The dead_letter_queue table has a large number of unresolved entries, indicating failed event indexing is not being resolved.

**Detection methods:**
- **Endpoint:** `GET /api/health` — check `dlq_depth`
  ```bash
  curl http://localhost:3001/api/health | jq '.dlq_depth'
  # Normal: 0-10 entries; alarming: >100 unresolved entries
  ```
- **SQL query:**
  ```bash
  psql $DATABASE_URL -c "SELECT COUNT(*) as unresolved FROM dead_letter_queue WHERE resolved = FALSE;"
  ```
- **Log pattern:** Search for:
  ```
  [dlq] entry id=NNN failed
  [dlq] entry id=NNN (retries exhausted)
  ```
- **Metrics:** Prometheus gauge `dlq_depth` (if exposed)

### Diagnosis

1. **Check current DLQ depth:**
   ```bash
   psql $DATABASE_URL -c "SELECT resolved, COUNT(*) FROM dead_letter_queue GROUP BY resolved;"
   # Shows breakdown: resolved=true vs. false
   ```

2. **Inspect recent failures:**
   ```bash
   psql $DATABASE_URL -c "SELECT id, contract_id, error_message, retry_count, max_retries, created_at FROM dead_letter_queue WHERE resolved = FALSE ORDER BY created_at DESC LIMIT 10;"
   # Look at error_message to understand why events are failing
   ```

3. **Check if failures are transient or permanent:**
   ```bash
   psql $DATABASE_URL -c "SELECT error_message, COUNT(*) FROM dead_letter_queue WHERE resolved = FALSE GROUP BY error_message ORDER BY COUNT(*) DESC;"
   # Transient errors (timeout, rate-limit) may auto-retry
   # Permanent errors (validation, decode) need manual intervention or code fix
   ```

4. **Access the admin DLQ API:**
   ```bash
   # List unresolved DLQ entries
   curl http://localhost:3001/api/admin/dlq?page=1&limit=25
   
   # Get specific entry details
   curl http://localhost:3001/api/admin/dlq/NNN
   ```

### Remediation

**If failures are transient (timeout, rate-limit, network errors):**
1. DLQ has automatic retry with exponential backoff — these should auto-resolve
2. Monitor next_retry_at to see when retry will occur:
   ```bash
   psql $DATABASE_URL -c "SELECT id, next_retry_at, error_message FROM dead_letter_queue WHERE resolved = FALSE ORDER BY next_retry_at ASC LIMIT 5;"
   ```
3. If backing up is severe, manually trigger retry via admin API:
   ```bash
   # Retry a specific entry
   curl -X POST http://localhost:3001/api/admin/dlq/NNN/retry -H "X-API-Key: $ADMIN_KEY"
   
   # This will attempt to re-decode and re-index the event
   ```

**If failures are permanent (validation errors, decode errors):**
1. Inspect the raw event in the DLQ entry:
   ```bash
   psql $DATABASE_URL -c "SELECT raw_event FROM dead_letter_queue WHERE id = NNN \G"
   # Will show the event JSON
   ```
2. Determine if the error is a code bug (e.g., new event type not handled):
   - If code bug: fix the decoder/validator in indexer/src/, rebuild, and redeploy
   - If bad event data: mark as resolved (data loss, but prevents queue backup):
     ```bash
     curl -X POST http://localhost:3001/api/admin/dlq/NNN/resolve -H "X-API-Key: $ADMIN_KEY"
     ```

**If DLQ is still backing up after remediation:**
1. Check if DLQ automatic retry cron is running:
   ```bash
   ps aux | grep -i dlq
   # or check logs for: "[dlq] Retry cycle completed"
   ```
2. Verify database has capacity:
   ```bash
   psql $DATABASE_URL -c "SELECT pg_database_size(current_database());"
   # If near disk limit, clean up old resolved DLQ entries:
   psql $DATABASE_URL -c "DELETE FROM dead_letter_queue WHERE resolved = TRUE AND updated_at < NOW() - INTERVAL '30 days';"
   ```

---

## Scenario 4: Audit Log Partition Creation Failing

### Detection

The audit log partition for the current month does not exist, causing all audit log INSERTs to fail.

**Detection methods:**
- **API logs:** Search for errors like:
  ```
  [auditLogger] Batch INSERT failed: relation "api_audit_log_2024_08" does not exist
  ```
- **Log pattern:** Repeated "no partition of relation" errors
- **SQL query:**
  ```bash
  psql $DATABASE_URL -c "SELECT inhrelname FROM pg_inherits WHERE inhparent = 'api_audit_log'::regclass ORDER BY inhrelname;"
  # Should show partitions for at least the current and next month
  # Example: api_audit_log_2024_08, api_audit_log_2024_09
  ```

### Diagnosis

1. **Check which partitions exist:**
   ```bash
   psql $DATABASE_URL -c "SELECT partition_name FROM information_schema.table_constraints WHERE table_name = 'api_audit_log';" 
   # or simpler:
   psql $DATABASE_URL -c "SELECT inhrelname FROM pg_inherits WHERE inhparent = 'api_audit_log'::regclass;"
   ```

2. **Check the audit partition cron status:**
   ```bash
   # Look for the cron job in logs
   tail -100 indexer.log | grep -i partition
   # Expected: "[auditLogger] Partition creation cron started"
   ```

3. **Verify the current system date:**
   ```bash
   date +%Y_%m
   # Expected format: 2024_08 (year_month)
   ```

4. **Check if the partition creation query is correct:**
   ```bash
   # Try to create the current month's partition manually
   psql $DATABASE_URL -c "CREATE TABLE IF NOT EXISTS api_audit_log_2024_08 PARTITION OF api_audit_log FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');"
   ```

### Remediation

**If the partition doesn't exist:**
1. Create it manually using the correct date range:
   ```bash
   psql $DATABASE_URL << EOF
   CREATE TABLE IF NOT EXISTS api_audit_log_$(date +%Y_%m) 
   PARTITION OF api_audit_log 
   FOR VALUES FROM ('$(date +%Y-%m)-01') TO ('$(date -d "+1 month" +%Y-%m)-01');
   EOF
   ```

2. Also create the next month's partition to prevent partition-missing errors on month boundary:
   ```bash
   NEXT_MONTH=$(date -d "+1 month" +%Y_%m)
   NEXT_MONTH_START=$(date -d "+1 month" +%Y-%m)-01
   MONTH_AFTER=$(date -d "+2 months" +%Y-%m)-01
   
   psql $DATABASE_URL -c "CREATE TABLE IF NOT EXISTS api_audit_log_${NEXT_MONTH} PARTITION OF api_audit_log FOR VALUES FROM ('${NEXT_MONTH_START}') TO ('${MONTH_AFTER}');"
   ```

3. Verify partitions were created:
   ```bash
   psql $DATABASE_URL -c "SELECT inhrelname FROM pg_inherits WHERE inhparent = 'api_audit_log'::regclass ORDER BY inhrelname DESC LIMIT 3;"
   ```

**If partitions exist but INSERTs are still failing:**
1. Check if audit logger is attempting to use the wrong partition name:
   ```bash
   tail -50 indexer.log | grep -E "api_audit_log|partition"
   ```

2. Restart the indexer to pick up the new partitions:
   ```bash
   systemctl restart soroban-explorer-indexer
   # or
   docker restart soroban-explorer-indexer
   ```

**If the cron job is not creating partitions automatically:**
1. Verify the cron job is running:
   ```bash
   # Check if startAuditPartitionCron was called in index.js
   grep -n "startAuditPartitionCron" indexer/src/index.js
   # Should be called during startup
   ```

2. Check the cron configuration:
   ```bash
   # In audit/auditLogger.js, the cron expression for monthly creation is:
   # '0 0 1 * *' (first day of each month at 00:00 UTC)
   grep -A2 "cron.schedule" indexer/src/audit/auditLogger.js
   ```

3. If cron is configured but not running, restart the indexer

---

## Scenario 5: Database Connection Pool Exhaustion

### Detection

The database connection pool has reached its maximum size, causing new queries to block or timeout waiting for a connection.

**Detection methods:**
- **Endpoint:** `GET /api/health` — may return 503 if database is unhealthy
  ```bash
  curl -i http://localhost:3001/api/health
  # Status 503 with message: "database unhealthy"
  ```
- **API timeouts:** Requests hang or return timeout errors
- **Log pattern:** Search for:
  ```
  Error: connect ETIMEDOUT
  Error: getaddrinfo ENOTFOUND postgres
  Error: Client is closed
  Error: connect timeout expired
  ```
- **SQL query:**
  ```bash
  psql $DATABASE_URL -c "SELECT datname, numbackends, (SELECT setting FROM pg_settings WHERE name = 'max_connections') as max_connections FROM pg_stat_database WHERE datname = current_database();"
  # Compare numbackends against DB_POOL_MAX (config, default 20)
  ```

### Diagnosis

1. **Check active connections:**
   ```bash
   psql $DATABASE_URL -c "SELECT pid, usename, state, query FROM pg_stat_activity;"
   # Shows all connections; look for idle or stuck queries
   ```

2. **Check pool configuration:**
   ```bash
   grep "DB_POOL_MAX\|db.*pool" indexer/.env indexer/src/db.js
   # Default is typically 20 connections
   ```

3. **Identify long-running queries:**
   ```bash
   psql $DATABASE_URL -c "SELECT pid, usename, query_start, NOW() - query_start as duration, query FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;"
   # Long-running queries hold connections; terminate if safe
   ```

4. **Check for idle connections:**
   ```bash
   psql $DATABASE_URL -c "SELECT datname, state, COUNT(*) FROM pg_stat_activity GROUP BY datname, state ORDER BY COUNT(*) DESC;"
   # Idle connections should be auto-closed by the pool; if many, may indicate leak
   ```

### Remediation

**If a specific query is stuck (consuming a connection):**
1. Identify the stuck PID and terminate it:
   ```bash
   STUCK_PID=<pid from above query>
   psql $DATABASE_URL -c "SELECT pg_terminate_backend(${STUCK_PID});"
   ```
2. Monitor if that connection is quickly re-acquired (normal) or remains stuck (indicates further issues)

**If pool is exhausted due to normal load:**
1. Increase the pool size in `indexer/.env`:
   ```bash
   # Default is 20; increase to 30-50 depending on expected load
   echo "DB_POOL_MAX=40" >> indexer/.env
   ```
2. Restart the indexer:
   ```bash
   systemctl restart soroban-explorer-indexer
   # or
   docker restart soroban-explorer-indexer
   ```

**If pool is exhausted due to connection leak (connections not being released):**
1. Check indexer logs for unclosed database queries:
   ```bash
   grep -i "query\|database" indexer.log | grep -i "error\|fail" | tail -20
   ```
2. If a code path is leaking connections (not calling .release() on pool clients):
   - This is a code bug requiring a fix in indexer/src/db.js
   - Deploy the fix and restart
3. As a temporary workaround, restart the indexer to reset the pool:
   ```bash
   systemctl restart soroban-explorer-indexer
   ```

**If you need to inspect the connection pool state programmatically:**
1. Query the pool metrics (if metrics are exposed):
   ```bash
   curl http://localhost:3001/api/metrics | grep db_pool
   # Should show pool size, available connections, idle connections
   ```

---

## Cross-Scenario Diagnostics

### All Scenarios: Verify Health Status

```bash
curl http://localhost:3001/api/health | jq '.' | less
# Shows:
# - indexer.healthy, indexer.lagSeconds, indexer.lastSync
# - database.healthy
# - redis.healthy (if configured)
# - dlq_depth
# - active_alerts
```

### All Scenarios: Check Active Alerts

```bash
curl http://localhost:3001/api/health | jq '.active_alerts'
# May show details about which dependency is unhealthy
```

### All Scenarios: Verify Indexer Process

```bash
# Check if daemon is running
systemctl status soroban-explorer-indexer
# or
docker ps | grep soroban-explorer

# Check recent logs
journalctl -u soroban-explorer-indexer -n 100 -f
# or
tail -f indexer.log
```

### All Scenarios: Escalation Path

1. **Check /api/health** — confirms which dependency is down
2. **Check logs** — grep for ERROR or the specific scenario keyword
3. **Manual diagnosis** — run the scenario-specific commands above
4. **Fix** — remediate according to the scenario procedure
5. **Verify** — re-run health check and monitor lag/DLQ

---

## Recovery Checklist

After resolving any scenario, verify recovery with:

```bash
# 1. Health endpoint returns 200
curl -I http://localhost:3001/api/health

# 2. Indexer is syncing (lag is decreasing)
curl http://localhost:3001/api/health | jq '.indexer | {lagSeconds, healthy, lastSync}'

# 3. API is responding
curl http://localhost:3001/api/events?limit=1 | jq '.data | length'

# 4. WebSocket is available
# (requires a WebSocket client to fully test; simple: curl ws://localhost:3001/ws should upgrade)

# 5. DLQ is not backing up
curl http://localhost:3001/api/health | jq '.dlq_depth'
```

---

## See Also

- [System Architecture](../architecture.md) — understand data flow for context during diagnosis
- [Health & Alerting Guide](health-and-alerting.md) — detailed health check configuration and alert setup
