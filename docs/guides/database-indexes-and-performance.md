# Database Indexes and Performance Optimization

This guide documents the process for identifying and adding database indexes to improve query performance based on real production query patterns.

## Index Review Process

When authoring a new migration or reviewing a query identified as slow, follow these steps to systematically evaluate whether an index would improve performance:

### 1. Capture Real Query Performance Data

Run `EXPLAIN ANALYZE` against the query on a production-representative data volume:

```sql
EXPLAIN ANALYZE
SELECT ... FROM events WHERE ...
```

Capture the complete output including:
- Actual row counts at each node
- Actual execution time (both planning and total)
- The full query plan tree showing how the optimizer chose to execute the query

**Important:** Use production-representative data volume. A query that performs well on a small test dataset may be slow on production traffic. Test against either:
- A recent production backup restored to a staging environment
- A synthetic dataset matching expected production volume and cardinality

### 2. Identify Sequential Scans That Would Benefit from Indexing

Look at the `EXPLAIN ANALYZE` output for sequential table scans on large tables with WHERE clauses:

```
Seq Scan on events  (cost=0.00..5000.00 rows=1000 width=200)
  Filter: contract_id = '...'
```

Sequential scans are necessary for unindexed queries and may be the bottleneck if:
- The table is large (millions of rows)
- The query filters on a column without an index
- The filter is selective (matches a small subset of rows)

Index scans are faster when:
```
Index Scan using idx_events_contract_id on events  (cost=0.00..100.00 rows=100 width=200)
  Index Cond: contract_id = '...'
```

### 3. Propose the Index

For each identified bottleneck, create a migration that adds the index:

```javascript
// indexer/migrations/NNN_add_index_for_X.js
exports.up = async (pgm) => {
  pgm.createIndex('table_name', 'column_name');
};

exports.down = async (pgm) => {
  pgm.dropIndex('table_name', 'column_name');
};
```

For compound indexes (WHERE clauses on multiple columns):
```javascript
pgm.createIndex('events', ['contract_id', 'function']);
```

### 4. Verify the Index Improves Performance

After the index is added, re-run `EXPLAIN ANALYZE` on the same query:

```sql
EXPLAIN ANALYZE
SELECT ... FROM events WHERE ...
```

Compare before/after:
- **Does the plan now use the new index?** Look for "Index Scan" or "Index Cond" mentioning the index.
- **Did execution time decrease?** Compare actual execution times.
- **Did node costs decrease?** Look at the cost estimates.

**Confirm the improvement is significant** (e.g., 10–100x faster) before considering the index complete.

### 5. Monitor Index Overhead

Indexes are not free. Each index adds:
- **Write overhead**: Every INSERT, UPDATE, or DELETE on indexed columns must update the index
- **Storage cost**: The index takes disk space

Check that:
- The query frequency justifies the write overhead (high-traffic queries, not rare ones)
- Multiple similar indexes don't exist (avoid redundant indexes)

## High-Traffic Query Categories to Prioritize

Once production traffic begins, these three query patterns should be the primary focus for index review:

### Event Search
Queries filtering events by contract ID, function name, ledger range, or caller address.

Examples:
- `SELECT * FROM events WHERE contract_id = ?` — frequently used on contract detail pages
- `SELECT * FROM events WHERE contract_id = ? AND function = ?` — filtered event list
- `SELECT * FROM events WHERE ledger >= ? AND ledger <= ?` — ledger range queries

### Wallet History
Queries retrieving transaction and operation history for a specific wallet address.

Examples:
- `SELECT * FROM events WHERE caller_address = ?` — user transaction history
- `SELECT * FROM ... WHERE recipient = ?` — incoming transfers
- Multi-table joins fetching balances and recent activity

### Contract Statistics
Aggregate queries computing contract metrics and activity summaries.

Examples:
- `SELECT COUNT(*) FROM events WHERE contract_id = ? GROUP BY function` — function call counts
- `SELECT SUM(...) FROM events WHERE contract_id = ?` — volume calculations
- Time-series queries for contract activity trends

## Adding Indexes in Production

**Caution:** Adding an index in production requires careful planning:

1. **Take a lock-free snapshot** of query plans before the migration
2. **Run the migration during low-traffic windows** if possible
3. **Monitor query performance** immediately after the migration
4. **Be prepared to roll back** if the index causes unexpected performance issues (e.g., planner misuse or high write overhead)

The migration framework in this repo supports rollback via the `down` function, allowing safe experimentation.

## References

- [PostgreSQL EXPLAIN Documentation](https://www.postgresql.org/docs/current/sql-explain.html)
- [PostgreSQL Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
