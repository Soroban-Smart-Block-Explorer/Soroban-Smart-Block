import { logger } from "./logger.js";
/**
 * githubAbiSync.js
 *
 * Periodically fetches verified contract ABI definitions from a public GitHub
 * repository and upserts them into the local contracts table.
 *
 * Expected repo layout:
 *   <ABI_REPO_OWNER>/<ABI_REPO_NAME>/
 *     contracts/
 *       <contract-id>.json   ← one file per contract
 *
 * Each JSON file must contain:
 *   { "id": "C...", "name": "...", "description": "...", "functions": [...] }
 */

/* global fetch */
import cron from "node-cron";
import { db } from "./db.js";

const GITHUB_API = "https://api.github.com";
const ABI_REPO = process.env.ABI_REPO || "Soroban-Smart-Block-Explorer/verified-abis";
const ABI_PATH = process.env.ABI_PATH || "contracts";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
// Default: run every 10 minutes
const SYNC_CRON = process.env.ABI_SYNC_CRON || "*/10 * * * *";

function githubHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(url) {
  const res = await fetch(url, { headers: githubHeaders() });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const waitMs = reset ? Number(reset) * 1000 - Date.now() : 60_000;
    logger.warn(`[abi-sync] GitHub rate-limited. Retrying after ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
    return ghFetch(url);
  }

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function syncAbis() {
  const [owner, repo] = ABI_REPO.split("/");
  const dirUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${ABI_PATH}`;

  let entries;
  try {
    entries = await ghFetch(dirUrl);
  } catch (err) {
    logger.error("[abi-sync] Failed to list ABI directory:", err.message);
    return;
  }

  const jsonFiles = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));

  let added = 0,
    updated = 0,
    errors = 0;

  for (const file of jsonFiles) {
    try {
      const raw = await ghFetch(file.download_url);
      const meta = typeof raw === "string" ? JSON.parse(raw) : raw;

      if (!meta.id || !meta.name) {
        logger.warn(`[abi-sync] Skipping ${file.name}: missing id or name`);
        continue;
      }

      const existing = await db.getContractMeta(meta.id);
      await db.upsertContractMeta({
        id: meta.id,
        name: meta.name,
        description: meta.description ?? null,
        functions: meta.functions ?? [],
        registered_by: "github-sync",
      });

      existing ? updated++ : added++;
    } catch (err) {
      logger.error(`[abi-sync] Error processing ${file.name}:`, err.message);
      errors++;
    }
  }

  logger.info(`[abi-sync] Sync complete — added: ${added}, updated: ${updated}, errors: ${errors}`);
}

export function startAbiSync() {
  logger.info(`[abi-sync] Scheduling ABI sync (${SYNC_CRON}) from ${ABI_REPO}/${ABI_PATH}`);
  // Run once immediately on startup, then on schedule
  syncAbis();
  cron.schedule(SYNC_CRON, syncAbis);
}
