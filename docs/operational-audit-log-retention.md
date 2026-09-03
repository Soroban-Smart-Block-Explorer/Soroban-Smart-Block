# Audit Log Partition Retention Policy

## Overview

The API audit log (`api_audit_log` table) uses PostgreSQL partitioning to manage historical data efficiently. **Audit log records are automatically deleted 90 days after they are created** as part of a monthly maintenance cron job. This document explains what this retention window means operationally and how it affects compliance, backup, and recovery workflows.

## Retention Window

**Default retention period: 90 days** (hardcoded in `indexer/src/audit/auditLogger.js:268`)

Partitions (monthly tables covering a calendar month) are dropped on the **1st of each month at 01:00 UTC** via the `startAuditPartitionCron()` function. Specifically:

- The cron job runs at: `0 1 1 * *` (01:00 UTC on the 1st day of every month)
- It lists all existing partitions by querying `pg_inherits`
- For each partition whose month is earlier than 90 days ago, it executes `DROP TABLE`
- Data within dropped partitions is **permanently deleted** from the database

### Example

If today is **August 30, 2026**, the retention cutoff is **May 31, 2026** (90 days ago). On September 1, 2026 at 01:00 UTC, any partition covering April 2026 or earlier will be dropped:

- April 2026 partition: deleted ✗
- May 2026 partition: deleted ✗
- June 2026 partition: retained ✓
- July 2026 partition: retained ✓
- August 2026 partition: retained ✓

## What "Dropping a Partition" Means

Dropping a partition is a PostgreSQL operation that **permanently deletes all rows** stored in that partition table. There is no archive step and no automatic backup export — the data is gone from the live database. If audit logs older than 90 days are needed later for compliance or forensic investigation, they will not be available unless:

1. **Database backups exist** covering the time period you need (operator's responsibility)
2. **External audit log export** was performed before the partition was dropped

This is a critical distinction for compliance workflows.

## Operational Implications

### Who needs to care

- **Compliance officers** — audit logs older than 90 days will not be queryable via the API
- **Security teams** — forensic investigation of incidents older than 90 days must rely on database backups, not live tables
- **Operators** — if you have regulatory retention requirements longer than 90 days, you must export audit logs before they age out
- **API consumers** — tools that poll the audit log API for historical data will not see events older than 90 days

### Compliance & Regulatory Considerations

If your jurisdiction or contract requires audit log retention longer than 90 days (e.g., 1 year, 7 years), you **must implement automated export** before the data is deleted. Example workflow:

1. **Daily export** — Run a scheduled job that exports the previous day's audit logs to cold storage (S3, GCS, archive database)
2. **Query archived logs** — Maintain a separate query interface for archived audit data
3. **Retention policy** — Document your archive retention policy and verify it meets legal requirements

The 90-day live retention window is designed for **operational ease and database performance**, not compliance. If you need longer retention, plan accordingly.

## Configuration

The 90-day retention window is **hardcoded** in the source code and cannot be configured via environment variables. To change it, you would need to:

1. Modify the constant in `indexer/src/audit/auditLogger.js:268`
2. Redeploy the indexer

Contact the maintainers if you need a different retention period.

## Verification

To check how many days of audit data currently exist in the database:

```sql
-- Find the oldest and newest audit log entries
SELECT 
  MIN(timestamp) AS oldest_entry,
  MAX(timestamp) AS newest_entry,
  ROUND((EXTRACT(EPOCH FROM (NOW() - MIN(timestamp))) / 86400)::numeric, 1) AS days_old
FROM api_audit_log;
```

To see which partitions exist:

```sql
-- List all partitions of api_audit_log
SELECT c.relname AS partition_name
FROM pg_inherits i
JOIN pg_class p ON p.oid = i.inhparent
JOIN pg_class c ON c.oid = i.inhrelid
WHERE p.relname = 'api_audit_log'
ORDER BY c.relname DESC;
```

## See Also

- `indexer/src/audit/auditLogger.js` — implementation of `startAuditPartitionCron()` and partition management
- `docs/guides/health-and-alerting.md` — audit log querying via the admin API (`GET /api/admin/audit-log`)
