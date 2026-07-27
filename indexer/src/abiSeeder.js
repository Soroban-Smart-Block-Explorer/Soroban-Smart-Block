/**
 * abiSeeder.js
 *
 * Seeds the built-in ABIs shipped in indexer/src/abis/ (e.g. StellarSwap, Blend)
 * into the contracts table on startup, so the explorer decodes their events out
 * of the box on a fresh database. Existing registrations are never overwritten —
 * only contract IDs not yet present in the DB are seeded (issue #557).
 */
import { readdir, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";

const ABIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "abis");

/**
 * Scans indexer/src/abis/ for *.json ABI files and registers any whose
 * contract ID isn't already in the DB. Safe to call on every startup.
 *
 * @returns {Promise<{ seeded: number, skipped: number }>}
 */
export async function seedBuiltinAbis() {
  let files;
  try {
    files = (await readdir(ABIS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return { seeded: 0, skipped: 0 }; // no abis/ directory — nothing to seed
  }

  let seeded = 0;
  let skipped = 0;

  for (const file of files) {
    try {
      const raw = await readFile(path.join(ABIS_DIR, file), "utf8");
      const meta = JSON.parse(raw);

      if (!meta.id || !meta.name) {
        console.warn(`[startup] Skipping built-in ABI ${file}: missing id or name`);
        continue;
      }

      const existing = await db.getContractMeta(meta.id);
      if (existing) {
        skipped++;
        continue;
      }

      await db.upsertContractMeta({
        id: meta.id,
        name: meta.name,
        description: meta.description ?? null,
        functions: meta.functions ?? [],
        registered_by: "builtin-seed",
      });
      console.log(`[startup] Seeded ABI for ${meta.name} (${meta.id.slice(0, 8)}…)`);
      seeded++;
    } catch (err) {
      console.error(`[startup] Failed to seed built-in ABI ${file}:`, err.message);
    }
  }

  return { seeded, skipped };
}
