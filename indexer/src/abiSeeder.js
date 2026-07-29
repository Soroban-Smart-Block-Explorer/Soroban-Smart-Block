/**
 * abiSeeder.js
 *
 * Seeds the built-in StellarSwap (#552) and Blend (#553) ABI definitions into
 * the contracts table on startup, so the registry UI and decoder both see
 * them immediately without waiting on githubAbiSync's cron.
 *
 * Each ABI file's `contractId` is a schema-valid placeholder — the real
 * deployed instance is supplied via config (STELLARSWAP_CONTRACT_ID /
 * BLEND_CONTRACT_ID) and substitutes it at seed time. Seeding for a protocol
 * is skipped entirely when its contract ID isn't configured.
 */
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import { db } from "./db.js";

const ABIS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "abis");

const BUILTIN_ABIS = [
  { file: "stellarswap.json", configKey: "STELLARSWAP_CONTRACT_ID" },
  { file: "blend.json", configKey: "BLEND_CONTRACT_ID" },
];

export async function seedBuiltinAbis() {
  let seeded = 0;
  let skipped = 0;
  for (const { file, configKey } of BUILTIN_ABIS) {
    const contractId = config[configKey];
    if (!contractId) {
      continue; // not configured for this deployment
    }

    try {
      const existing = await db.getContractMeta(contractId);
      if (existing) {
        skipped++;
        continue; // already registered
      }

      const raw = await readFile(path.join(ABIS_DIR, file), "utf8");
      const meta = JSON.parse(raw);

      await db.upsertContractMeta({
        id: contractId,
        name: meta.name,
        description: meta.description ?? null,
        functions: meta.functions ?? [],
        registered_by: "builtin-seed",
      });

      seeded++;
      console.log(`[abi-seed] registered ${meta.name} (${contractId})`);
    } catch (err) {
      console.error(`[abi-seed] failed to seed ${file}:`, err.message);
    }
  }
  return { seeded, skipped };
}
