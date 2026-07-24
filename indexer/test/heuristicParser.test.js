import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessType, parseHeuristic, heuristicParser } from "../src/heuristicParser.js";

// 64-char hex hash
const HASH = "a".repeat(64);

describe("guessType", () => {
  it("identifies a Stellar account address", () => {
    // Any 56-char G-address should match
    const addr = "G" + "A".repeat(55);
    const r = guessType(addr);
    assert.equal(r.type, "Address");
    assert.equal(r.confidence, "likely");
    assert.equal(r.value, addr);
  });

  it("identifies a Stellar contract address", () => {
    const addr = "C" + "A".repeat(55);
    const r = guessType(addr);
    assert.equal(r.type, "ContractId");
    assert.equal(r.confidence, "likely");
  });

  it("identifies a 64-char hex hash", () => {
    const r = guessType(HASH);
    assert.equal(r.type, "Hash");
    assert.equal(r.confidence, "likely");
  });

  it("identifies a bigint as Amount", () => {
    const r = guessType(1000000n);
    assert.equal(r.type, "Amount");
    assert.equal(r.confidence, "possible");
  });

  it("identifies a number as Amount", () => {
    const r = guessType(9876543);
    assert.equal(r.type, "Amount");
    assert.equal(r.confidence, "possible");
  });

  it("identifies an all-caps token symbol", () => {
    const r = guessType("USDC");
    assert.equal(r.type, "Symbol");
    assert.equal(r.confidence, "possible");
  });

  it("identifies a boolean", () => {
    assert.equal(guessType(true).type, "Boolean");
    assert.equal(guessType(false).type, "Boolean");
  });

  it("returns Unknown for unrecognised strings", () => {
    const r = guessType("some random text 123");
    assert.equal(r.type, "Unknown");
  });
});

describe("parseHeuristic", () => {
  it("returns one entry per param with 1-based indexes", () => {
    const addr = "G" + "A".repeat(55);
    const results = parseHeuristic([addr, 100n, "USDC"]);
    assert.equal(results.length, 3);
    assert.equal(results[0].index, 1);
    assert.equal(results[1].index, 2);
    assert.equal(results[2].index, 3);
  });

  it("preserves raw value as string", () => {
    const addr = "G" + "A".repeat(55);
    const results = parseHeuristic([addr]);
    assert.equal(results[0].raw, addr);
    assert.equal(results[0].value, addr);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseHeuristic([]), []);
  });

  it("correctly tags mixed params", () => {
    const addr    = "G" + "A".repeat(55);
    const cid     = "C" + "A".repeat(55);
    const results = parseHeuristic([addr, cid, 500n, "XLM", HASH]);

    assert.equal(results[0].type, "Address");
    assert.equal(results[1].type, "ContractId");
    assert.equal(results[2].type, "Amount");
    assert.equal(results[3].type, "Symbol");
    assert.equal(results[4].type, "Hash");
  });
});

// Closes #420 — heuristicParser(ev) must never return null, undefined, or ''
describe("heuristicParser — non-null fallback for unknown function names", () => {
  const ADDR = "G" + "A".repeat(55);

  it('returns a non-empty string for unknown function "foo_bar"', () => {
    const ev = { function: "foo_bar", raw_topics: ["foo_bar", ADDR] };
    const result = heuristicParser(ev);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0, "must not be empty string");
    assert.notEqual(result, null);
    assert.notEqual(result, undefined);
  });

  it('returns a non-empty string for unknown function "do_something_custom"', () => {
    const ev = { function: "do_something_custom", raw_topics: ["do_something_custom", ADDR, "100"] };
    const result = heuristicParser(ev);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it('returns a non-empty string for unknown function "process_v2"', () => {
    const ev = { function: "process_v2", raw_topics: ["process_v2"] };
    const result = heuristicParser(ev);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("returns a non-empty string when function field is missing", () => {
    const ev = { raw_topics: [] };
    const result = heuristicParser(ev);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("returns a non-empty string for null input", () => {
    const result = heuristicParser(null);
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("description includes the function name when provided", () => {
    const ev = { function: "stake_tokens", raw_topics: ["stake_tokens"] };
    const result = heuristicParser(ev);
    assert.ok(result.includes("stake_tokens"), `expected "stake_tokens" in "${result}"`);
  });
});
