/**
 * TTL Extension Parser Tests — Protocol 26
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  parseTTLHostFunction,
  parseTTLExtension,
  extractTTLModifications,
  formatTTLExtension,
  calculateRentPaid,
  parseTTLFromTxMeta,
} from "../src/ttlExtensionParser.js";

test("parseTTLHostFunction returns null for unsupported operations", () => {
  assert.equal(parseTTLHostFunction(null), null);
  assert.equal(parseTTLHostFunction({ function_name: "other_function", args: {} }), null);
});

test("parseTTLHostFunction parses Protocol 26 extend_contract_instance_ttl", () => {
  const result = parseTTLHostFunction({
    function_name: "extend_contract_instance_ttl",
    args: { extend_to: 500000, min_extension: 17280, max_extension: 34560 },
  });

  assert.deepEqual(result, {
    fn_name: "extend_contract_instance_ttl",
    extend_to: 500000,
    min_extension: 17280,
    max_extension: 34560,
  });
});

test("parseTTLHostFunction parses generic extend_ttl alias", () => {
  const result = parseTTLHostFunction({
    function_name: "extend_ttl",
    args: { extend_to: 400000, min_extension: 5000, max_extension: 10000 },
  });

  assert.deepEqual(result, {
    fn_name: "extend_ttl",
    extend_to: 400000,
    min_extension: 5000,
    max_extension: 10000,
  });
});

test("parseTTLHostFunction parses legacy extendContractCode operation", () => {
  const result = parseTTLHostFunction({
    type: "extendContractCode",
    codeHash: "HASH123",
    extendTo: 150000,
  });

  assert.deepEqual(result, {
    fn_name: "extend_contract_code_ttl",
    extend_to: 150000,
    min_extension: null,
    max_extension: null,
  });
});

test("parseTTLExtension returns null for invalid input", () => {
  assert.equal(parseTTLExtension(null), null);
});

test("extractTTLModifications extracts TTL extensions from a transaction", () => {
  const tx = {
    ledger: 50000,
    hash: "TXHASH123",
    timestamp: 1690000000000,
    operations: [
      {
        hostFunction: {
          function_name: "extend_contract_code_ttl",
          args: { extend_to: 500000, min_extension: 17280, max_extension: 34560 },
        },
      },
    ],
  };

  const results = extractTTLModifications(tx);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    fn_name: "extend_contract_code_ttl",
    extend_to: 500000,
    min_extension: 17280,
    max_extension: 34560,
    ledger: 50000,
    tx_hash: "TXHASH123",
    timestamp: 1690000000000,
  });
});

test("extractTTLModifications supports multiple TTL records", () => {
  const tx = {
    ledger: 60000,
    hash: "TXHASH456",
    operations: [
      {
        hostFunction: {
          function_name: "extend_contract_instance_ttl",
          args: { extend_to: 500000, min_extension: 17280, max_extension: 34560 },
        },
      },
      {
        hostFunction: {
          function_name: "extend_contract_code_ttl",
          args: { extend_to: 510000, min_extension: 17280, max_extension: 34560 },
        },
      },
    ],
  };

  const results = extractTTLModifications(tx);
  assert.equal(results.length, 2);
  assert.equal(results[0].fn_name, "extend_contract_instance_ttl");
  assert.equal(results[1].fn_name, "extend_contract_code_ttl");
});

test("formatTTLExtension generates a readable label", () => {
  const result = formatTTLExtension({
    fn_name: "extend_contract_instance_ttl",
    extend_to: 500000,
    min_extension: 17280,
    max_extension: 34560,
  });

  assert.equal(result, "Extended contract instance TTL to ledger 500000 requested +17280 max +34560");
});

test("calculateRentPaid converts XLM to stroops", () => {
  assert.equal(calculateRentPaid({ costXlm: 0.5 }), 5_000_000);
});

test("calculateRentPaid returns zero when no cost is present", () => {
  assert.equal(calculateRentPaid({}), 0);
});

// Closes #421 — parseTTLFromTxMeta correctly detects TTL bump ops in txMeta

describe("parseTTLFromTxMeta — ttl_extended field", () => {
  test("returns ttl_extended: true for extend_contract_instance_ttl op in txMeta", () => {
    const txMeta = {
      operations: [
        {
          function_name: "extend_contract_instance_ttl",
          args: { extend_to: 500000, min_extension: 17280, max_extension: 34560 },
        },
      ],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.ttl_extended, true);
  });

  test("returns ttl_extended: true for extend_contract_code_ttl op in txMeta", () => {
    const txMeta = {
      operations: [
        {
          function_name: "extend_contract_code_ttl",
          args: { extend_to: 600000, min_extension: 8640, max_extension: 17280 },
        },
      ],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.ttl_extended, true);
  });

  test("includes parsed fn_name and extend_to in the result", () => {
    const txMeta = {
      operations: [
        {
          function_name: "extend_contract_instance_ttl",
          args: { extend_to: 500000, min_extension: 17280, max_extension: 34560 },
        },
      ],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.fn_name, "extend_contract_instance_ttl");
    assert.equal(result.extend_to, 500000);
  });

  test("returns ttl_extended: true for bumpFootprintExpiration op type", () => {
    const txMeta = {
      operations: [{ type: "bumpFootprintExpiration" }],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.ttl_extended, true);
  });

  test("returns ttl_extended: true via nested hostFunction", () => {
    const txMeta = {
      operations: [
        {
          hostFunction: {
            function_name: "extend_ttl",
            args: { extend_to: 400000, min_extension: 5000, max_extension: 10000 },
          },
        },
      ],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.ttl_extended, true);
  });

  test("returns ttl_extended: false when txMeta has no bump op", () => {
    const txMeta = {
      operations: [
        { type: "payment" },
        { type: "createAccount" },
      ],
    };
    const result = parseTTLFromTxMeta(txMeta);
    assert.equal(result.ttl_extended, false);
  });

  test("returns ttl_extended: false for empty operations array", () => {
    const result = parseTTLFromTxMeta({ operations: [] });
    assert.equal(result.ttl_extended, false);
  });

  test("returns ttl_extended: false for null txMeta", () => {
    const result = parseTTLFromTxMeta(null);
    assert.equal(result.ttl_extended, false);
  });

  test("returns ttl_extended: false for undefined txMeta", () => {
    const result = parseTTLFromTxMeta(undefined);
    assert.equal(result.ttl_extended, false);
  });
});
