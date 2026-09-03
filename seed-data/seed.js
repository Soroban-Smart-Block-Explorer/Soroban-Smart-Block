/**
 * Safe seed-data loader.
 *
 * Reads seed-data.fixture.json (populated with REAL testnet data by a maintainer)
 * and loads contracts and events into the local dev database.
 *
 * This script reuses the indexer's real database insertion methods (upsertEvent,
 * upsertContractMeta) to ensure the seed data matches the live schema exactly.
 *
 * Usage:
 *   cd seed-data && node seed.js
 *   (DATABASE_URL must be set in environment or indexer/.env)
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";

// Import the real database module from indexer
const __dir = path.dirname(fileURLToPath(import.meta.url));
const indexerDir = path.resolve(__dir, "../indexer");

// Dynamically import db.js from indexer
const { db } = await import(path.resolve(indexerDir, "src/db.js"));

const FIXTURE_PATH = path.resolve(__dir, "seed-data.fixture.json");

async function loadFixture() {
  const content = await readFile(FIXTURE_PATH, "utf-8");
  const fixture = JSON.parse(content);

  // Skip the __INSTRUCTIONS__ key if present
  const { __INSTRUCTIONS__, contracts = [], events = [] } = fixture;

  if (__INSTRUCTIONS__) {
    console.log(`[seed] Note: ${__INSTRUCTIONS__}`);
  }

  return { contracts, events };
}

async function seed() {
  try {
    console.log("[seed] Loading fixture from seed-data.fixture.json…");
    const { contracts, events } = await loadFixture();

    console.log(`[seed] Found ${contracts.length} contracts and ${events.length} events.`);

    if (contracts.length === 0 && events.length === 0) {
      console.log(
        "[seed] Fixture is empty. See seed-data/README.md for instructions on populating it with real testnet data.",
      );
      process.exitCode = 0;
      return;
    }

    // Insert contracts using the real upsertContractMeta method
    console.log("[seed] Inserting contracts…");
    for (const contract of contracts) {
      try {
        await db.upsertContractMeta(contract);
        console.log(`[seed]   ✓ ${contract.id} (${contract.name})`);
      } catch (err) {
        console.error(`[seed] ERROR inserting contract ${contract.id}: ${err.message}`);
        throw err;
      }
    }

    // Insert events using the real upsertEvent method
    console.log("[seed] Inserting events…");
    for (const event of events) {
      try {
        await db.upsertEvent(event);
      } catch (err) {
        console.error(
          `[seed] ERROR inserting event (contract: ${event.contract_id}, ledger: ${event.ledger}): ${err.message}`,
        );
        throw err;
      }
    }
    console.log(`[seed]   ✓ ${events.length} events inserted`);

    console.log("[seed] Seed complete ✓");
    process.exitCode = 0;
  } catch (err) {
    console.error(`[seed] Fatal error: ${err.message}`);
    process.exitCode = 1;
  }
}

// Auto-run if invoked directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seed();
}

export { seed };
