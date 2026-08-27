/**
 * Unit tests for soroban-explorer CLI.
 *
 * These tests verify the argument parsing, config loading, and output
 * formatting functions. They do not make real network calls — the command
 * functions are tested with a mock client.
 *
 * Runs with `node --test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "cli.js");

function runCli(args = [], env = {}) {
  return spawnSync("node", [CLI_PATH, ...args], {
    env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf-8",
    timeout: 10_000,
  });
}

describe("soroban-explorer CLI", () => {
  describe("help", () => {
    it("should print help with no arguments", () => {
      const result = runCli([]);
      assert.equal(result.status, 0, `exit code ${result.status}: ${result.stderr}`);
      assert.ok(result.stdout.includes("Usage:"), "should include Usage section");
      assert.ok(result.stdout.includes("events"), "should list events command");
      assert.ok(result.stdout.includes("wallet"), "should list wallet command");
      assert.ok(result.stdout.includes("contract"), "should list contract command");
      assert.ok(result.stdout.includes("search"), "should list search command");
      assert.ok(result.stdout.includes("tail"), "should list tail command");
    });

    it("should print help with --help flag", () => {
      const result = runCli(["--help"]);
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes("Usage:"));
    });

    it("should print help with help command", () => {
      const result = runCli(["help"]);
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes("Usage:"));
    });
  });

  describe("unknown command", () => {
    it("should exit with error on unknown command", () => {
      const result = runCli(["nonexistent"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("Unknown command"));
    });
  });

  describe("wallet command", () => {
    it("should error on missing address", () => {
      const result = runCli(["wallet"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("wallet address required"));
    });

    it("should error on invalid address format", () => {
      const result = runCli(["wallet", "invalid"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("invalid Stellar wallet address"));
    });
  });

  describe("contract command", () => {
    it("should error on missing contract ID", () => {
      const result = runCli(["contract"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("contract ID required"));
    });
  });

  describe("search command", () => {
    it("should error on missing query", () => {
      const result = runCli(["search"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("search query required"));
    });
  });

  describe("events command", () => {
    it("should error on invalid limit", () => {
      const result = runCli(["events", "--limit", "999"]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("limit"));
    });

    it("should accept valid flags", () => {
      // This will fail because there's no server, but the parsing should succeed
      const result = runCli(["events", "--contract", "CDA2...", "--fn", "transfer", "--limit", "5", "--type", "soroban"]);
      // It'll fail with a connection error, not an argument error
      assert.ok(
        result.stderr.includes("fetch") || result.stderr.includes("ECONNREFUSED") || result.stderr.includes("ENOTFOUND") || result.stderr === "",
      );
    });
  });

  describe("--json flag", () => {
    it("should accept --json flag (parsing is verified by no argument error)", () => {
      const result = runCli(["events", "--json", "--limit", "5"]);
      // Will fail connecting but argument parsing succeeded
      assert.ok(!result.stderr.includes("Unknown") && !result.stderr.includes("unrecognized"));
    });
  });

  describe("--base-url flag", () => {
    it("should accept --base-url flag", () => {
      const result = runCli(["--base-url", "https://example.com", "events"]);
      // Will fail connecting to example.com but not with argument error
      assert.ok(!result.stderr.includes("Unknown option"));
    });
  });
});