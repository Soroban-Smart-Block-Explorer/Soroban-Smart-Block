#!/usr/bin/env node

/**
 * soroban-explorer — CLI tool for querying the Soroban Smart Block Explorer.
 *
 * Zero-dependency CLI. Uses only Node.js built-ins (http/https, fs, os, path).
 * Works immediately with `npx soroban-explorer` — no install needed beyond Node 18+.
 *
 * Usage:
 *   npx soroban-explorer events [--contract <id>] [--fn <name>] [--limit N]
 *   npx soroban-explorer wallet <address>
 *   npx soroban-explorer contract <id>
 *   npx soroban-explorer search <query>
 *   npx soroban-explorer tail [--contract <id>]
 */

import http from "http";
import https from "https";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// ── package.json version ──────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let VERSION = "0.1.0";
try {
  const pkgJson = JSON.parse(await fs.readFile(path.join(__dirname, "..", "package.json"), "utf-8"));
  VERSION = pkgJson.version;
} catch { /* use default */ }

// ── Help text ────────────────────────────────────────────────────────────
const HELP = `soroban-explorer v${VERSION}

Usage:
  soroban-explorer <command> [options]

Commands:
  events     List recent events (supports --contract, --fn, --limit, --type)
  wallet     Show events involving a wallet address
  contract   Show contract metadata and registered functions
  search     Search across contracts, events, and wallets
  tail       Stream live events to the terminal
  help       Show this help

Global options:
  --base-url <url>   Explorer API base URL (default: http://localhost:3001)
  --api-key <key>    API key for authenticated endpoints
  --json             Output machine-readable NDJSON instead of a table

Config file:
  ~/.soroban-explorer.json  for persistent base URL and API key

Examples:
  soroban-explorer events --contract CDA2... --limit 5
  soroban-explorer wallet GABCD...
  soroban-explorer contract CDA2...
  soroban-explorer search "swap"
  soroban-explorer tail --contract CDA2...
  soroban-explorer events --json --limit 10`;

// ── ANSI color helpers ───────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

// ── Argument parser ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 2;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      flags.json = true;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
      i++;
    } else if (
      (arg === "--base-url" || arg === "--api-key" || arg === "--contract" ||
       arg === "--fn" || arg === "--limit" || arg === "--type") &&
      i + 1 < argv.length
    ) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
      i += 2;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...vals] = arg.slice(2).split("=");
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[camelKey] = vals.join("=");
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { positional, flags };
}

// ── Config loader ────────────────────────────────────────────────────────
async function loadConfig() {
  const configPath = path.join(os.homedir(), ".soroban-explorer.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── HTTP client (zero-dependency, uses built-in http/https) ───────────────

/**
 * Make an HTTP request to the explorer API.
 * @param {string} baseUrl
 * @param {string} apiPath  - e.g. "/events?contract=CDA2...&limit=5"
 * @param {string} [apiKey]
 * @returns {Promise<object>}
 */
function apiRequest(baseUrl, apiPath, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl.replace(/\/+$/, "") + "/api" + apiPath);
    const mod = url.protocol === "https:" ? https : http;
    const headers = { Accept: "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;

    const req = mod.request(
      url,
      { method: "GET", headers, timeout: 30_000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
          } else {
            let message;
            try {
              message = JSON.parse(body).error || body;
            } catch {
              message = body || `HTTP ${res.statusCode}`;
            }
            reject(new Error(message));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

// ── Output helpers ─────────────────────────────���─────────────────────────

function tableColored(headers, rows) {
  // Calculate column widths
  const widths = headers.map((h, i) => {
    let max = String(h).length;
    for (const row of rows) {
      const val = row[i] != null ? String(row[i]) : "";
      max = Math.max(max, val.length);
    }
    return max + 2;
  });

  const pad = (val, w) => {
    const s = val != null ? String(val) : "";
    return s + " ".repeat(Math.max(0, w - s.length));
  };

  const hr = "─".repeat(widths.reduce((a, b) => a + b, 0) + widths.length - 1);

  let out = "";
  out += DIM + hr + RESET + "\n";
  out += BOLD + CYAN + headers.map((h, i) => pad(h, widths[i])).join(" ") + RESET + "\n";
  out += DIM + hr + RESET + "\n";

  for (const row of rows) {
    out += row.map((val, i) => {
      const s = val != null ? String(val) : "";
      if (headers[i] === "CONTRACT" && s.length > 20) {
        return DIM + pad(s.slice(0, 18) + "…", widths[i]) + RESET;
      }
      if (headers[i] === "FUNCTION") {
        return GREEN + pad(s, widths[i]) + RESET;
      }
      return pad(s, widths[i]);
    }).join(" ") + "\n";
  }

  out += DIM + hr + RESET + "\n";
  return out;
}

function outputJSON(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      process.stdout.write(JSON.stringify(item) + "\n");
    }
  } else {
    process.stdout.write(JSON.stringify(data) + "\n");
  }
}

// ── Command implementations ──────────────────────────────────────────────

async function cmdEvents(baseUrl, apiKey, flags) {
  const limit = flags.limit ? Number(flags.limit) : 10;
  if (isNaN(limit) || limit < 1 || limit > 200) {
    console.error("Error: --limit must be between 1 and 200");
    process.exit(1);
  }

  const q = new URLSearchParams();
  if (flags.contract) q.set("contract", flags.contract);
  if (flags.fn) q.set("fn", flags.fn);
  if (flags.type) q.set("type", flags.type);
  q.set("limit", String(limit));

  const result = await apiRequest(baseUrl, `/events?${q}`, apiKey);

  if (flags.json) {
    outputJSON(result.data);
    return;
  }

  if (!result.data || !result.data.length) {
    console.log("No events found.");
    return;
  }

  const headers = ["SEQ", "CONTRACT", "FUNCTION", "LEDGER", "DESCRIPTION"];
  const rows = result.data.map((ev) => [
    String(ev.seq),
    ev.contract_id || "(classic)",
    ev.function || "—",
    String(ev.ledger),
    (ev.description || "").slice(0, 60) + ((ev.description || "").length > 60 ? "…" : ""),
  ]);

  console.log(tableColored(headers, rows));
  if (result.next_cursor) {
    console.log(`Next cursor: ${result.next_cursor}`);
  }
}

async function cmdWallet(baseUrl, apiKey, flags, positional) {
  const address = positional[1];
  if (!address) {
    console.error("Error: wallet address required. Usage: soroban-explorer wallet <address>");
    process.exit(1);
  }

  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    console.error("Error: invalid Stellar wallet address format (must start with G, 56 chars)");
    process.exit(1);
  }

  const result = await apiRequest(baseUrl, `/wallet/${address}`, apiKey);

  if (flags.json) {
    outputJSON(result.events);
    return;
  }

  console.log(`Wallet: ${address}`);
  console.log(`Events: ${result.events ? result.events.length : 0}`);

  if (!result.events || !result.events.length) return;

  const headers = ["SEQ", "CONTRACT", "FUNCTION", "LEDGER", "DESCRIPTION"];
  const rows = result.events.map((ev) => [
    String(ev.seq),
    ev.contract_id || "(classic)",
    ev.function || "—",
    String(ev.ledger),
    (ev.description || "").slice(0, 60) + ((ev.description || "").length > 60 ? "…" : ""),
  ]);

  console.log(tableColored(headers, rows));
}

async function cmdContract(baseUrl, apiKey, flags, positional) {
  const id = positional[1];
  if (!id) {
    console.error("Error: contract ID required. Usage: soroban-explorer contract <id>");
    process.exit(1);
  }

  const meta = await apiRequest(baseUrl, `/contracts/${id}`, apiKey);

  if (flags.json) {
    outputJSON(meta);
    return;
  }

  console.log(`${BOLD}${CYAN}${meta.name || "Unnamed Contract"}${RESET}`);
  console.log(`${DIM}ID: ${meta.id}${RESET}`);
  if (meta.description) console.log(meta.description);
  console.log("");

  if (meta.functions && meta.functions.length) {
    console.log(`${BOLD}Functions (${meta.functions.length}):${RESET}`);
    const headers = ["NAME", "DESCRIPTION"];
    const rows = meta.functions.map((fn) => [
      GREEN + fn.name + RESET,
      (fn.description || "").slice(0, 70) + ((fn.description || "").length > 70 ? "…" : ""),
    ]);
    console.log(tableColored(headers, rows));
  }
}

async function cmdSearch(baseUrl, apiKey, flags, positional) {
  const query = positional[1];
  if (!query) {
    console.error("Error: search query required. Usage: soroban-explorer search <query>");
    process.exit(1);
  }

  const q = new URLSearchParams();
  q.set("q", query);
  q.set("limit", "10");
  const result = await apiRequest(baseUrl, `/search?${q}`, apiKey);

  if (flags.json) {
    outputJSON(result);
    return;
  }

  console.log(`${BOLD}Results for "${query}":${RESET}\n`);

  if (result.contracts && result.contracts.length) {
    console.log(`${CYAN}Contracts (${result.contracts.length}):${RESET}`);
    for (const c of result.contracts) {
      console.log(`  ${c.id}  ${c.name || ""}  (${c.event_count || 0} events)`);
    }
    console.log("");
  }

  if (result.events && result.events.length) {
    console.log(`${CYAN}Events (${result.events.length}):${RESET}`);
    const headers = ["SEQ", "CONTRACT", "FUNCTION", "LEDGER"];
    const rows = result.events.map((ev) => [
      String(ev.seq),
      (ev.contract_id || "").slice(0, 20),
      ev.function || "—",
      String(ev.ledger),
    ]);
    console.log(tableColored(headers, rows));
  }

  if (result.wallets && result.wallets.length) {
    console.log(`\n${CYAN}Wallets (${result.wallets.length}):${RESET}`);
    for (const w of result.wallets) {
      console.log(`  ${w.address}  (${w.event_count || 0} events)`);
    }
  }

  if (
    (!result.contracts || !result.contracts.length) &&
    (!result.events || !result.events.length) &&
    (!result.wallets || !result.wallets.length)
  ) {
    console.log("No results found.");
  }
}

async function cmdTail(baseUrl, apiKey, flags) {
  console.log(`${BOLD}Listening for live events${RESET} ${DIM}(Ctrl+C to stop)${RESET}`);
  if (flags.contract) console.log(`Filter: contract = ${flags.contract}`);

  // Seed the cursor with the latest event seq so we only show new arrivals
  let lastSeq = 0;
  try {
    const q = new URLSearchParams();
    if (flags.contract) q.set("contract", flags.contract);
    q.set("limit", "1");
    const seed = await apiRequest(baseUrl, `/events?${q}`, apiKey);
    if (seed.data && seed.data.length > 0) {
      lastSeq = seed.data[0].seq;
    }
  } catch {
    // Start from 0 if seed fails
  }

  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const q = new URLSearchParams();
        if (flags.contract) q.set("contract", flags.contract);
        q.set("limit", "10");
        const result = await apiRequest(baseUrl, `/events?${q}`, apiKey);

        const newEvents = [];
        for (const ev of result.data || []) {
          if (ev.seq > lastSeq) {
            newEvents.push(ev);
            lastSeq = Math.max(lastSeq, ev.seq);
          }
        }

        // Print in chronological order (oldest first)
        for (const ev of newEvents.reverse()) {
          const ts = new Date().toISOString().slice(11, 19);
          const contract = (ev.contract_id || "").slice(0, 12);
          const fn = ev.function || "—";
          const desc = (ev.description || "").slice(0, 80);
          console.log(
            `${DIM}${ts}${RESET} ${YELLOW}${contract.padEnd(12)}${RESET} ${GREEN}${fn.padEnd(20)}${RESET} ${desc}`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (e) {
        if (running) {
          console.error(`${DIM}Poll error: ${e.message}${RESET}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  process.on("SIGINT", () => {
    running = false;
    console.log(`\n${DIM}Stopped.${RESET}`);
    process.exit(0);
  });

  await poll();
}

// ── Main ──��──────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv);

  if (flags.help || positional[0] === "help" || !positional[0]) {
    console.log(HELP);
    process.exit(0);
  }

  const command = positional[0];

  // Load config
  const config = await loadConfig();
  const baseUrl =
    flags.baseUrl ||
    config.baseUrl ||
    process.env.SOROBAN_EXPLORER_URL ||
    "http://localhost:3001";
  const apiKey =
    flags.apiKey || config.apiKey || process.env.SOROBAN_EXPLORER_API_KEY || undefined;

  try {
    switch (command) {
      case "events":
        await cmdEvents(baseUrl, apiKey, flags);
        break;
      case "wallet":
        await cmdWallet(baseUrl, apiKey, flags, positional);
        break;
      case "contract":
        await cmdContract(baseUrl, apiKey, flags, positional);
        break;
      case "search":
        await cmdSearch(baseUrl, apiKey, flags, positional);
        break;
      case "tail":
        await cmdTail(baseUrl, apiKey, flags);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();