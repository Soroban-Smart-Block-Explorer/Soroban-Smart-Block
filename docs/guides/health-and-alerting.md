# Health Checks & Alerting

> **For on-call engineers and operations teams.**  
> This guide explains how the Soroban Smart Block Explorer health and alert systems work, and how to configure them.

---

## Quick Start

### Health Check Endpoints

The indexer exposes three health endpoints:

| Endpoint | Purpose | HTTP Status |
|----------|---------|-------------|
| `GET /api/health` | Comprehensive status + all dependencies | 200 (healthy/degraded) or 503 (unhealthy) |
| `GET /api/health/live` | Liveness probe (is process alive?) | Always 200 |
| `GET /api/health/ready` | Readiness probe (accept traffic?) | 200 or 503 |

### Enable Slack Alerts

Set in your indexer `.env` or deployment:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
```

### Enable PagerDuty Alerts

```bash
PAGERDUTY_ROUTING_KEY=YOUR_ROUTING_KEY_HERE
```

---

## Understanding the Health Endpoint

### Comprehensive Health Check: `GET /api/health`

**Response Schema:**

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "timestamp": "2026-07-28T08:25:50.874Z",
  "activeAlerts": [
    {
      "condition": "INDEXER_DOWN",
      "firedAt": "2026-07-28T08:20:10.000Z",
      "durationMs": 340874
    }
  ],
  "dependencies": {
    "database": {
      "status": "healthy" | "unhealthy",
      "responseTime": 3,
      "connections": {
        "total": 10,
        "idle": 8,
        "active": 2,
        "waiting": 0
      }
    },
    "indexer": {
      "status": "healthy" | "unhealthy",
      "lastLedger": 1234567,
      "lagSeconds": 5,
      "lastSyncAgo": 3
    },
    "cache": {
      "status": "healthy" | "unhealthy" | "disabled",
      "responseTime": 1
    }
  }
}
```

**HTTP Status Codes:**

- **200 OK** — Service is `healthy` or `degraded` (can handle traffic)
- **503 Service Unavailable** — Service is `unhealthy` (critical dependencies down)

**Status Levels:**

- **`healthy`** — All critical dependencies operational. Safe to route traffic.
- **`degraded`** — Critical dependencies (database, indexer) are up, but optional systems (cache, workers) may be impaired. Service can handle traffic but with reduced functionality.
- **`unhealthy`** — One or more critical dependencies have failed (e.g., database unreachable, indexer stalled). Do not route traffic.

### Liveness Probe: `GET /api/health/live`

```json
{
  "status": "alive",
  "timestamp": "2026-07-28T08:25:50.874Z"
}
```

**Always returns 200** as long as the HTTP server is running. Use this to detect if the process has crashed.

**Kubernetes usage:**

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  periodSeconds: 10
  failureThreshold: 3
```

### Readiness Probe: `GET /api/health/ready`

```json
{
  "status": "ready" | "not_ready",
  "timestamp": "2026-07-28T08:25:50.874Z",
  "reason": "Critical dependencies unhealthy"
}
```

**Returns 200 if status is `healthy` or `degraded`, 503 if `unhealthy`.**

Use this for load balancer and service-mesh traffic routing:

```yaml
readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  periodSeconds: 5
  failureThreshold: 2
```

---

## The 8 Alert Conditions

The alert manager monitors eight conditions and fires notifications when triggered. All active alerts are listed in the `/api/health` response.

### 1. INDEXER_DOWN (Critical)

**Fired when:** Indexer has not successfully polled the Soroban RPC within the configured stall threshold (default: 30 seconds).

**What it means:** The main indexer polling loop has stalled. Events are not being fetched or processed.

**Common causes:**
- Indexer process crashed
- RPC node is overloaded or unreachable
- Database is stuck on a query
- Network connectivity issue

**Resolution:**
1. Check indexer logs: `docker logs <indexer-container>`
2. Check RPC node status and rate limits
3. Restart the indexer service if stalled
4. Check database connection and query performance

**Configuration:**

```bash
ALERT_INDEXER_STALL_MS=30000  # Fire alert if no poll in 30 seconds (default)
```

---

### 2. LEDGER_GAP (Warning)

**Fired when:** The indexer detects a gap of consecutive missing ledgers exceeding the threshold (default: 100 ledgers).

**What it means:** Events may be missing from a range of ledgers. This can indicate network issues, RPC failures during a specific time window, or a synchronization problem.

**Common causes:**
- Temporary RPC outage
- Ledger fetch failure
- Database write performance degradation

**Resolution:**
1. Check RPC node logs and status
2. Verify network connectivity to RPC
3. Check database disk space and query performance
4. Resync affected ledger range if necessary

**Configuration:**

```bash
ALERT_GAP_THRESHOLD=100  # Fire alert if gap > 100 ledgers (default)
```

---

### 3. DB_FAILURE (Critical)

**Fired when:** Database connection fails (PostgreSQL is unreachable or authentication fails).

**What it means:** The indexer cannot write events or read from the database. The service is unable to operate.

**Common causes:**
- PostgreSQL server down
- Network connectivity to database lost
- Invalid connection string or credentials
- Connection pool exhausted
- Database disk full

**Resolution:**
1. Verify PostgreSQL is running: `pg_isready -h <host> -p 5432`
2. Check `DATABASE_URL` environment variable
3. Check PostgreSQL logs and disk space
4. Verify credentials and network connectivity
5. Increase connection pool size if needed

**Configuration:**

```bash
DATABASE_URL=postgres://user:password@localhost:5432/soroban_explorer
```

---

### 4. RESOURCE_CONSTRAINT (Warning)

**Fired when:** The indexer process heap usage exceeds the configured limit (default: 1024 MB).

**What it means:** The indexer is consuming a lot of memory and may be approaching out-of-memory conditions.

**Common causes:**
- Memory leak in indexer code
- Unusual spike in event volume
- Large events not being garbage-collected
- Cache growing unbounded

**Resolution:**
1. Check memory usage: `top` or `ps aux`
2. Look for memory leaks in indexer logs
3. Reduce event batch size if needed
4. Restart the indexer if memory is not being released
5. Scale horizontally (add more indexer instances)

**Configuration:**

```bash
ALERT_MAX_HEAP_MB=1024  # Fire alert if heap > 1024 MB (default)
```

---

### 5. ALL_RPC_DOWN (Critical)

**Fired when:** All configured Soroban RPC providers are unreachable or unhealthy.

**What it means:** The indexer cannot reach any RPC endpoint. Ledger data cannot be fetched and indexing has stopped.

**Common causes:**
- RPC providers experiencing outage
- Network connectivity issue to all RPC endpoints
- Firewall/proxy misconfiguration
- Rate limits hit on all providers
- Invalid RPC URL configuration

**Resolution:**
1. Check RPC provider status pages
2. Test RPC connectivity: `curl https://soroban-testnet.stellar.org/health`
3. Verify `SOROBAN_RPC_URL` configuration
4. Check network connectivity and firewall rules
5. Verify rate limit headers and add backoff if needed

**Configuration:**

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_RPC_BACKUP_URLS=https://backup-rpc1.example.com,https://backup-rpc2.example.com
```

---

### 6. LOW_THROUGHPUT (Warning)

**Fired when:** The event indexing rate falls below the configured minimum (default: 5 events/minute).

**What it means:** The indexer is processing events slower than expected. This may indicate a bottleneck (database, RPC, or indexer performance).

**Common causes:**
- RPC is returning events slowly
- Database writes are slow
- High CPU usage on indexer
- Large/complex events taking longer to decode

**Resolution:**
1. Check RPC response times
2. Analyze database query performance (check slow query logs)
3. Look for CPU spikes on indexer
4. Check event size distribution (are some events unusually large?)
5. Consider scaling horizontally

**Configuration:**

```bash
ALERT_MIN_THROUGHPUT=5  # Fire alert if < 5 events/minute (default)
```

---

### 7. DLQ_THRESHOLD (Warning)

**Fired when:** The dead-letter queue (DLQ) of unresolved failed events exceeds the configured limit (default: 1000 entries).

**What it means:** Events are failing to process and are accumulating in the dead-letter queue. These events are not being indexed and may be lost if not addressed.

**Common causes:**
- Decoding errors (malformed XDR, unknown ABI)
- Database errors on event write
- Type mismatches between contract ABI and actual events
- Incomplete or outdated ABI registry

**Resolution:**
1. Review DLQ entries: `SELECT * FROM dead_letter_queue LIMIT 10`
2. Identify common failure patterns
3. Update contract ABIs if needed
4. Fix decoding logic if required
5. Manually resolve or discard entries as needed

**Configuration:**

```bash
ALERT_DLQ_MAX_SIZE=1000  # Fire alert if DLQ > 1000 entries (default)
```

---

### 8. REORG_DETECTED (Critical)

**Fired when:** A chain reorganization is detected (ledger hash mismatch at a previously indexed ledger).

**What it means:** The Stellar network experienced a rollback. Previously indexed events at a certain ledger may have been invalidated by the reorg.

**Common causes:**
- Validator network reorganization
- Slottime gap or protocol issue
- Rare network fork

**Resolution:**
1. Verify ledger hash: `curl https://soroban-testnet.stellar.org/ledgers/<ledger-num>`
2. Compare stored hash with actual hash
3. Log the reorg for audit purposes
4. Re-index affected ledger range if necessary
5. Notify monitoring team and users

**Configuration:**

```bash
# No configuration for reorg detection; fires automatically when mismatch detected
```

---

## Alert Notification Channels

### Slack Notifications

Alerts are sent to a Slack webhook channel with severity emoji:

- **:red_circle: Critical** — INDEXER_DOWN, DB_FAILURE, ALL_RPC_DOWN, REORG_DETECTED
- **:warning: Warning** — LEDGER_GAP, RESOURCE_CONSTRAINT, LOW_THROUGHPUT, DLQ_THRESHOLD

**Setup:**

1. Create a Slack Incoming Webhook:
   - Go to [api.slack.com/apps](https://api.slack.com/apps) → Create App → From scratch
   - Choose your workspace, app name (e.g., "Soroban Indexer Alerts")
   - Go to "Incoming Webhooks" → Add New Webhook to Workspace
   - Select the channel (e.g., `#indexer-alerts`)
   - Copy the webhook URL

2. Set the environment variable:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
```

3. Test:

```bash
curl -X POST \
  -H 'Content-type: application/json' \
  --data '{"text":"Test alert from indexer"}' \
  $SLACK_WEBHOOK_URL
```

**Example alert message:**

```
:red_circle: *[INDEXER_DOWN]* No successful poll in 30000ms
```

### PagerDuty Notifications

Critical alerts can trigger PagerDuty incidents for on-call engineers.

**Setup:**

1. In PagerDuty:
   - Go to Integrations → Event Intelligence
   - Create a new routing rule for Soroban Indexer
   - Get the **Routing Key** (different from service key)

2. Set the environment variable:

```bash
PAGERDUTY_ROUTING_KEY=YOUR_ROUTING_KEY_HERE
```

3. PagerDuty alert payload:

```json
{
  "routing_key": "YOUR_ROUTING_KEY",
  "event_action": "trigger",
  "dedup_key": "INDEXER_DOWN",
  "payload": {
    "summary": "[soroban-indexer] INDEXER_DOWN: No successful poll in 30000ms",
    "source": "soroban-indexer",
    "severity": "critical"
  }
}
```

**Severity mapping:**

- `critical` → PagerDuty `critical` severity (page immediately)
- `warning` → PagerDuty `warning` severity (create ticket)

---

## Resolving Alerts

### Automatic Resolution

Alerts are automatically resolved when the underlying condition is fixed:

- **INDEXER_DOWN** → Resolved when indexer polls successfully
- **LEDGER_GAP** → Resolved when gap is filled
- **DB_FAILURE** → Resolved when database connection restored
- **RESOURCE_CONSTRAINT** → Resolved when heap usage drops below limit
- **ALL_RPC_DOWN** → Resolved when at least one RPC becomes healthy
- **LOW_THROUGHPUT** → Resolved when throughput exceeds minimum
- **DLQ_THRESHOLD** → Resolved when DLQ size drops below threshold
- **REORG_DETECTED** → Resolved after manual verification

### Manual Resolution

You can manually resolve an alert via the admin API:

```bash
POST /api/admin/alerts/:condition/resolve
X-API-Key: <api-key>
```

**Example:**

```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  http://localhost:3001/api/admin/alerts/INDEXER_DOWN/resolve
```

**Response:**

```json
{
  "message": "Alert condition resolved",
  "condition": "INDEXER_DOWN"
}
```

---

## Monitoring Setup Examples

### Docker Compose

```yaml
services:
  indexer:
    image: soroban-indexer:latest
    ports:
      - "3001:3001"
    environment:
      SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL}
      PAGERDUTY_ROUTING_KEY: ${PAGERDUTY_ROUTING_KEY}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/health/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
```

### Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: soroban-indexer
spec:
  containers:
  - name: indexer
    image: soroban-indexer:latest
    ports:
    - containerPort: 3001
    env:
    - name: SLACK_WEBHOOK_URL
      valueFrom:
        secretKeyRef:
          name: indexer-alerts
          key: slack-webhook-url
    - name: PAGERDUTY_ROUTING_KEY
      valueFrom:
        secretKeyRef:
          name: indexer-alerts
          key: pagerduty-routing-key
    
    livenessProbe:
      httpGet:
        path: /health/live
        port: 3001
      initialDelaySeconds: 30
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
    
    readinessProbe:
      httpGet:
        path: /api/health/ready
        port: 3001
      initialDelaySeconds: 10
      periodSeconds: 5
      timeoutSeconds: 3
      failureThreshold: 2
```

### Prometheus Monitoring

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'soroban-indexer'
    static_configs:
      - targets: ['indexer:3001']
    metrics_path: '/metrics'

  - job_name: 'soroban-indexer-health'
    metrics_path: '/api/health'
    scrape_interval: 30s
    static_configs:
      - targets: ['indexer:3001']
```

---

## Troubleshooting

### Check Current Health Status

```bash
curl http://localhost:3001/api/health | jq
```

### Check Active Alerts

```bash
curl http://localhost:3001/api/health | jq '.activeAlerts'
```

### Indexer stuck in unhealthy state

1. Check logs: `docker logs <container>`
2. Verify database connectivity: `psql $DATABASE_URL -c "SELECT 1"`
3. Verify RPC connectivity: `curl $SOROBAN_RPC_URL/health`
4. Restart the service: `docker restart <container>`

### Alert notifications not sending

1. Verify `SLACK_WEBHOOK_URL` is set and valid
2. Test webhook: `curl -X POST $SLACK_WEBHOOK_URL --data '{"text":"Test"}'`
3. Check indexer logs for webhook errors: `grep -i "slack\|pagerduty" logs`
4. Verify network access from indexer to Slack/PagerDuty APIs

### Too many false alerts

Adjust thresholds in `.env`:

```bash
ALERT_INDEXER_STALL_MS=60000        # Increase if RPC is slow
ALERT_GAP_THRESHOLD=200             # Increase if transient gaps are normal
ALERT_MIN_THROUGHPUT=1              # Lower for slower networks
ALERT_MAX_HEAP_MB=2048              # Increase for memory-intensive workloads
```

---

## Configuration Reference

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `SLACK_WEBHOOK_URL` | (empty) | Slack incoming webhook for alerts |
| `PAGERDUTY_ROUTING_KEY` | (empty) | PagerDuty routing key for critical alerts |
| `ALERT_INDEXER_STALL_MS` | 30000 | Milliseconds without a poll to fire INDEXER_DOWN |
| `ALERT_GAP_THRESHOLD` | 100 | Ledger gap size to fire LEDGER_GAP alert |
| `ALERT_DLQ_MAX_SIZE` | 1000 | Dead-letter queue size to fire DLQ_THRESHOLD |
| `ALERT_MIN_THROUGHPUT` | 5 | Min events/minute to fire LOW_THROUGHPUT |
| `ALERT_MAX_HEAP_MB` | 1024 | Max heap usage (MB) to fire RESOURCE_CONSTRAINT |

---

## Summary

- **Use `/api/health`** for comprehensive status of all systems
- **Use `/api/health/live`** for Kubernetes liveness probes
- **Use `/api/health/ready`** for load balancer and traffic routing
- **Set `SLACK_WEBHOOK_URL`** to get alerts in Slack
- **Set `PAGERDUTY_ROUTING_KEY`** to page on-call for critical issues
- **Monitor the 8 alert conditions** and adjust thresholds to reduce false positives
- **Refer to the troubleshooting section** when alerts fire
