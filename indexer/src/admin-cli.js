#!/usr/bin/env node
/**
 * Admin CLI — Command-line interface for admin API operations
 *
 * Wraps common admin tasks (key management, integrity checks) without
 * requiring hand-crafted curl commands and bearer tokens.
 *
 * Usage:
 *   npm run admin -- keys list
 *   npm run admin -- keys create --name "my-key" --tier pro
 *   npm run admin -- keys rotate <key-id>
 *   npm run admin -- integrity-check
 *
 * Requires ADMIN_SECRET environment variable (set in indexer/.env).
 */

import "dotenv/config";
import http from "http";

const ADMIN_URL = process.env.ADMIN_URL || "http://localhost:3001";
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error("ERROR: ADMIN_SECRET environment variable is not set.");
  console.error("Set it in indexer/.env or export it before running this CLI.");
  process.exit(1);
}

// ── HTTP request helper ──────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ADMIN_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname + url.search,
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET}`,
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Commands ───────────────────────────────────────────────────────────────

async function listKeys() {
  console.log("» Fetching API keys…");
  const result = await request("GET", "/api/admin/api-keys");

  if (result.status !== 200) {
    console.error(`ERROR: ${result.data?.error || "Request failed"}`);
    process.exit(1);
  }

  const { data, total, page, limit } = result.data;
  console.log(`\nFound ${total} API keys (page ${page}/${Math.ceil(total / limit)}):\n`);

  if (!data || data.length === 0) {
    console.log("  (no keys)");
    return;
  }

  for (const key of data) {
    const tier = key.tier || "N/A";
    const revoked = key.revoked ? " [REVOKED]" : "";
    const usage = key.usage_count ? ` (used ${key.usage_count}x)` : "";
    console.log(`  ${key.id}: ${key.name} (${tier})${revoked}${usage}`);
    if (key.expires_at) {
      console.log(`    Expires: ${key.expires_at}`);
    }
  }
}

async function createKey(args) {
  const name = args[0];
  if (!name) {
    console.error("ERROR: Key name is required.");
    console.error("Usage: npm run admin -- keys create <name> [--tier pro] [--rate-limit 1000]");
    process.exit(1);
  }

  const tier = args.includes("--tier") ? args[args.indexOf("--tier") + 1] : "free";
  const rateLimit = args.includes("--rate-limit") ? parseInt(args[args.indexOf("--rate-limit") + 1]) : undefined;

  const body = { name, tier };
  if (rateLimit) body.rate_limit = rateLimit;

  console.log(`» Creating API key: ${name} (tier: ${tier})…`);
  const result = await request("POST", "/api/admin/api-keys", body);

  if (result.status !== 201) {
    console.error(`ERROR: ${result.data?.error || "Request failed"}`);
    process.exit(1);
  }

  const key = result.data;
  console.log("\n✓ API key created successfully!");
  console.log(`\n  ID:      ${key.id}`);
  console.log(`  Key:     ${key.raw_key}`);
  console.log(`  Tier:    ${key.tier}`);
  console.log("\n⚠️  SAVE THIS KEY NOW — it will not be shown again!\n");
}

async function rotateKey(keyId) {
  if (!keyId) {
    console.error("ERROR: Key ID is required.");
    console.error("Usage: npm run admin -- keys rotate <key-id>");
    process.exit(1);
  }

  console.log(`» Rotating key ${keyId}…`);
  const result = await request("POST", `/api/admin/api-keys/${keyId}/rotate`);

  if (result.status !== 200) {
    console.error(`ERROR: ${result.data?.error || "Request failed"}`);
    process.exit(1);
  }

  const key = result.data;
  console.log("\n✓ API key rotated successfully!");
  console.log(`\n  ID:       ${key.id}`);
  console.log(`  New Key:  ${key.raw_key}`);
  console.log("\n⚠️  SAVE THIS KEY NOW — the old one is revoked!\n");
}

async function runIntegrityCheck() {
  console.log("» Running integrity checks…");
  const result = await request("GET", "/api/admin/integrity");

  if (result.status !== 200) {
    console.error(`ERROR: ${result.data?.error || "Request failed"}`);
    process.exit(1);
  }

  if (result.data.ok) {
    console.log("\n✓ All integrity checks passed!\n");
    return;
  }

  console.log("\n✗ Integrity check failures:\n");
  for (const failure of result.data.failed) {
    console.log(`  ${failure.check}:`);
    console.log(`    ${JSON.stringify(failure.details, null, 2)}`);
  }
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Admin CLI — common admin tasks");
    console.log("\nUsage:");
    console.log("  npm run admin -- keys list");
    console.log("  npm run admin -- keys create <name> [--tier pro] [--rate-limit 1000]");
    console.log("  npm run admin -- keys rotate <key-id>");
    console.log("  npm run admin -- integrity-check");
    process.exit(0);
  }

  const [command, subcommand, ...rest] = args;

  try {
    if (command === "keys") {
      if (subcommand === "list") {
        await listKeys();
      } else if (subcommand === "create") {
        await createKey(rest);
      } else if (subcommand === "rotate") {
        await rotateKey(rest[0]);
      } else {
        console.error(`ERROR: Unknown keys subcommand: ${subcommand}`);
        process.exit(1);
      }
    } else if (command === "integrity-check") {
      await runIntegrityCheck();
    } else {
      console.error(`ERROR: Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
