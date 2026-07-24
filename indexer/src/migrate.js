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
