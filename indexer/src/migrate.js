/**
 * Zero-downtime migration runner.
 *
 * Reads all *.sql files from indexer/migrations/ ordered by filename prefix,
 * skips migrations already recorded in schema_migrations, and runs only the
 * pending ones — each inside its own transaction so a failure is atomic.
 */
import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

// `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block (and
// Postgres rejects it if it isn't the sole statement in its query message —
// the simple query protocol treats multiple ;-separated statements as one
// implicit transaction). Migrations that use it are split into individual
// statements and run outside BEGIN/COMMIT, each as its own query.
const CONCURRENTLY_RE = /\bCONCURRENTLY\b/i;

function splitStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run all pending migrations against the provided pg pool.
 * @param {import('pg').Pool} pool
 */
export async function runMigrations(pool) {
  // Ensure the tracking table exists (bootstraps itself on first run)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");

    if (CONCURRENTLY_RE.test(sql)) {
      // No transaction wrapper — each statement commits (or fails) on its
      // own. Statements use IF NOT EXISTS so a re-run after a partial
      // failure is safe.
      try {
        for (const statement of splitStatements(sql)) {
          await pool.query(statement);
        }
        await pool.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file],
        );
        console.log(`[migrations] applied ${file} (non-transactional)`);
        ran++;
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      console.log(`[migrations] applied ${file}`);
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  if (ran === 0) console.log("[migrations] schema up to date");
  return ran;
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// `node src/migrate.js` applies all pending migrations against DATABASE_URL and
// exits 0 on success / 1 on failure. Used by the CI migration check (see #425).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runMigrations(pool);
    process.exitCode = 0;
  } catch (err) {
    console.error(`[migrations] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
