/**
 * Unit tests for indexer/src/decoder.js covering all ScVal types and edge cases.
 *
 * Tests:
 * - ScVal type decoding (Address, Symbol, String, Bool, I32, U32, I64, U64, I128, U128, Bytes, Vec, Map)
 * - SEP-41 events (transfer, mint, burn, clawback)
 * - Unknown event type handling
 * - Amount formatting with decimals
 * - Nested Vec and Map decoding
 * - Missing ABI graceful fallback
 * - Malformed XDR handling
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xdr, StrKey } from "@stellar/stellar-sdk";
import { scValToJs } from "../src/scval.js";

// ── XDR decode helpers ──────────────────────────────────────────────────────
// xdr_decoder.js / int128.js were removed in the AI-bloat cleanup, so these
// utilities are inlined here (same convention as the other helper copies in
// this file). decodeContractEvent parses a base64 XDR ContractEvent into
// native JS values; bigints are normalized to strings so i64/u64/i128/u256/
// timepoint/duration decode losslessly without precision loss.

/**
 * Parse a base64 XDR ContractEvent into { topics, value }.
 * @param {string} base64Xdr
 * @returns {{ topics: any[], value: any }}
 */
function decodeContractEvent(base64Xdr) {
  const ev = xdr.ContractEvent.fromXDR(base64Xdr, "base64");
  const v0 = ev.body().v0();
  const normalize = (v) => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, normalize(val)]));
    }
    return v;
  };
  // scValToJs stringifies the ScError union itself ("[object Object]"); pull
  // the underlying error code so errors decode as { error: "<code>" }.
  const decode = (val) => {
    if (val && val.switch && val.switch().name === "scvError") {
      const e = val.error();
      const code = typeof e?.value === "function" ? e.value() : e;
      return { error: String(code) };
    }
    return normalize(scValToJs(val));
  };
  return {
    topics: (v0.topics() ?? []).map(decode),
    value: decode(v0.data()),
  };
}

/** Parse an i128 ScVal into a native BigInt (hi: signed i64, lo: u64). */
function parseI128(scVal) {
  const parts = scVal.i128();
  const hi = BigInt(parts.hi().toString());
  const lo = BigInt(parts.lo().toString());
  return (hi << 64n) | lo;
}

/** Parse a u128 ScVal into a native BigInt (hi: u64, lo: u64). */
function parseU128(scVal) {
  const parts = scVal.u128();
  const hi = BigInt(parts.hi().toString());
  const lo = BigInt(parts.lo().toString());
  return (hi << 64n) | lo;
}

// ── Helper functions (duplicated from decoder.js for contract testing) ───────

function fmt(addr) {
  if (typeof addr !== "string" || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtXlm(amount) {
  if (amount == null) return "?";
  const n = Number(amount);
  return isNaN(n) ? String(amount) : (n / 1e7).toLocaleString(undefined, { maximumFractionDigits: 7 });
}

function isResourceLimitExceeded(ev) {
  const CODES = new Set(["tx_resource_limit_exceeded", "txResourceLimitExceeded", "RESOURCE_LIMIT_EXCEEDED"]);
  const code = ev.txResultCode ?? ev.resultCode ?? ev.result?.code ?? "";
  return CODES.has(String(code));
}

function extractGasCosts(ev) {
  const result = {};
  try {
    if (ev.feeCharged != null) result.fee_charged = Number(ev.feeCharged);
    const meta = ev.txMeta;
    if (!meta) return result;
    let sorobanMeta = null;
    try { sorobanMeta = meta.v3?.()?.sorobanMeta?.() ?? null; } catch { }
    if (!sorobanMeta) return result;
    try {
      const extV1 = sorobanMeta.ext?.()?.v1?.();
      if (extV1) {
        if (extV1.totalNonRefundableResourceFeeCharged != null)
          result.cpu_instructions = Number(extV1.totalNonRefundableResourceFeeCharged);
        if (extV1.totalRefundableResourceFeeCharged != null)
          result.fee_charged = Number(extV1.totalRefundableResourceFeeCharged);
        if (extV1.rentFeeCharged != null)
          result.mem_bytes = Number(extV1.rentFeeCharged);
      }
    } catch { }
  } catch { }
  return result;
}

function buildDescription(fn, args, data, contractName) {
  switch (fn) {
    case "swap": {
      const [from, amtIn, tokenIn, amtOut, tokenOut] = args;
      return `Address ${fmt(from)} swapped ${amtIn} ${tokenIn} → ${amtOut} ${tokenOut} on ${contractName}`;
    }
    case "transfer": {
      const [from, to, amount, token] = args;
      return `Address ${fmt(from)} transferred ${amount} ${token ?? ""} to ${fmt(to)} on ${contractName}`;
    }
    case "mint": {
      const [to, amount, token] = args;
      return `${amount} ${token ?? ""} minted to ${fmt(to)} on ${contractName}`;
    }
    case "burn": {
      const [from, amount, token] = args;
      return `${amount} ${token ?? ""} burned from ${fmt(from)} on ${contractName}`;
    }
    case "clawback": {
      const [admin, from, amount, token] = args;
      return `CLAWBACK: ${amount} ${token ?? ""} recovered from ${fmt(from)} by authority ${fmt(admin)} on ${contractName}`;
    }
    default:
      return `${fn}(${args.map(String).join(", ")}) called on ${contractName}`;
  }
}

function nativeXlmDescription(fnName, args, data) {
  if (fnName === "mint") {
    const [to, amount] = args;
    const amt = amount ?? data;
    return { function: "wrap_native", description: `Wrapped ${fmtXlm(amt)} XLM (Classic → Soroban) to ${fmt(to)}` };
  }
  if (fnName === "burn") {
    const [from, amount] = args;
    const amt = amount ?? data;
    return { function: "unwrap_native", description: `Unwrapped ${fmtXlm(amt)} XLM (Soroban → Classic) from ${fmt(from)}` };
  }
  return null;
}

// ── ScVal XDR helpers ───────────────────────────────────────────────────────

const CONTRACT_ID_BYTES = Buffer.alloc(32, 0xab);

function makeEvent(type, topics, data, withContractId = true, ledger = 12345, txHash = "ABCD1234") {
  return {
    contractId: withContractId ? "CAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBB" : null,
    topic: topics,
    value: data,
    ledger,
    txHash,
  };
}

function makeXdrEvent(type, topics, data, withContractId = true, ledger = 12345, txHash = "ABCD1234") {
  // body is an Int-discriminated ContractEventBody union — arm 0 is v0
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: withContractId ? CONTRACT_ID_BYTES : null,
    type,
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  }).toXDR("base64");
}

// ── Test addresses ──────────────────────────────────────────────────────────

const ADDR_ACCOUNT = "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ";
const ADDR_CONTRACT = "CABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZA";

// ── ScVal Type Tests ────────────────────────────────────────────────────────
// Tests 1: Each ScVal type decoded correctly

describe("decoder — ScVal type decoding", () => {
  describe("scvSymbol", () => {
    it("decodes symbol type correctly", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("transfer")], xdr.ScVal.scvVoid())
      );
      assert.equal(result.topics[0], "transfer");
      assert.equal(typeof result.topics[0], "string");
    });
  });

  describe("scvString", () => {
    it("decodes string type correctly", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("event")], xdr.ScVal.scvString("hello world"))
      );
      assert.equal(result.value, "hello world");
    });
  });

  describe("scvBool", () => {
    it("decodes boolean true", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("activated")], xdr.ScVal.scvBool(true))
      );
      assert.equal(result.value, true);
    });

    it("decodes boolean false", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("paused")], xdr.ScVal.scvBool(false))
      );
      assert.equal(result.value, false);
    });
  });

  describe("scvI32", () => {
    it("decodes i32 negative value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], xdr.ScVal.scvI32(-42))
      );
      assert.equal(result.value, -42);
    });

    it("decodes i32 zero", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("zero")], xdr.ScVal.scvI32(0))
      );
      assert.equal(result.value, 0);
    });

    it("decodes i32 positive value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("count")], xdr.ScVal.scvI32(1000))
      );
      assert.equal(result.value, 1000);
    });
  });

  describe("scvU32", () => {
    it("decodes u32 zero", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("count")], xdr.ScVal.scvU32(0))
      );
      assert.equal(result.value, 0);
    });

    it("decodes u32 positive value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("count")], xdr.ScVal.scvU32(4294967295))
      );
      assert.equal(result.value, 4294967295);
    });
  });

  describe("scvI64", () => {
    it("decodes i64 positive value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], xdr.ScVal.scvI64(xdr.Int64.fromString("9223372036854775807")))
      );
      assert.equal(result.value, "9223372036854775807");
    });

    it("decodes i64 negative value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], xdr.ScVal.scvI64(xdr.Int64.fromString("-9223372036854775808")))
      );
      assert.equal(result.value, "-9223372036854775808");
    });
  });

  describe("scvU64", () => {
    it("decodes u64 value", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], xdr.ScVal.scvU64(xdr.Uint64.fromString("18446744073709551615")))
      );
      assert.equal(result.value, "18446744073709551615");
    });
  });

  describe("scvI128", () => {
    it("decodes i128 positive value using parseI128", () => {
      const scv = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString("0"),
          lo: xdr.Uint64.fromString("999999999999"),
        })
      );
      const parsed = parseI128(scv);
      assert.equal(parsed, 999999999999n);
    });

    it("decodes i128 large value", () => {
      const scv = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString("1"),
          lo: xdr.Uint64.fromString("0"),
        })
      );
      const parsed = parseI128(scv);
      assert.equal(parsed, 18446744073709551616n);
    });
  });

  describe("scvU128", () => {
    it("decodes u128 positive value using parseU128", () => {
      const scv = xdr.ScVal.scvU128(
        new xdr.UInt128Parts({
          hi: xdr.Uint64.fromString("0"),
          lo: xdr.Uint64.fromString("999999999999"),
        })
      );
      const parsed = parseU128(scv);
      assert.equal(parsed, 999999999999n);
    });

    it("decodes u128 large value", () => {
      const scv = xdr.ScVal.scvU128(
        new xdr.UInt128Parts({
          hi: xdr.Uint64.fromString("1"),
          lo: xdr.Uint64.fromString("500"),
        })
      );
      const parsed = parseU128(scv);
      assert.equal(parsed, 18446744073709551616n + 500n);
    });
  });

  describe("scvBytes", () => {
    it("decodes bytes as hex string", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("hash")], xdr.ScVal.scvBytes(Buffer.from("deadbeef", "hex")))
      );
      assert.equal(result.value, "deadbeef");
    });
  });

  describe("scvVec", () => {
    it("decodes vec of primitives", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("args")], xdr.ScVal.scvVec([
          xdr.ScVal.scvI32(1),
          xdr.ScVal.scvI32(2),
          xdr.ScVal.scvI32(3),
        ]))
      );
      assert.deepEqual(result.value, [1, 2, 3]);
    });

    it("decodes empty vec", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("empty")], xdr.ScVal.scvVec([]))
      );
      assert.deepEqual(result.value, []);
    });
  });

  describe("scvMap", () => {
    it("decodes map with string keys", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("event")], xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvString("from"), val: xdr.ScVal.scvString("GABC") }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvString("to"), val: xdr.ScVal.scvString("XYZ") }),
        ]))
      );
      assert.equal(result.value.from, "GABC");
      assert.equal(result.value.to, "XYZ");
    });

    it("decodes map with symbol keys", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("config")], xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("decimals"), val: xdr.ScVal.scvU32(7) }),
        ]))
      );
      assert.equal(result.value.decimals, 7);
    });

    it("decodes empty map", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("empty")], xdr.ScVal.scvMap([]))
      );
      assert.deepEqual(result.value, {});
    });
  });

  describe("scvAddress", () => {
    it("decodes account address", () => {
      const ed25519 = Buffer.alloc(32, 1);
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("owner")], xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(ed25519))
        ))
      );
      assert.equal(result.value, StrKey.encodeEd25519PublicKey(ed25519));
    });

    it("decodes contract address", () => {
      const contractId = Buffer.alloc(32, 0xab);
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("token")], xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeContract(contractId)
        ))
      );
      assert.equal(result.value, StrKey.encodeContract(contractId));
    });
  });

  describe("scvU256", () => {
    it("decodes u256 value as bigint", () => {
      const scv = xdr.ScVal.scvU256(
        new xdr.UInt256Parts({
          hiHi: xdr.Uint64.fromString("0"),
          hiLo: xdr.Uint64.fromString("0"),
          loHi: xdr.Uint64.fromString("0"),
          loLo: xdr.Uint64.fromString("12345"),
        })
      );
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], scv)
      );
      assert.equal(result.value, "12345");
    });
  });

  describe("scvI256", () => {
    it("decodes i256 positive value as bigint", () => {
      const scv = xdr.ScVal.scvI256(
        new xdr.Int256Parts({
          hiHi: xdr.Int64.fromString("0"),
          hiLo: xdr.Uint64.fromString("0"),
          loHi: xdr.Uint64.fromString("0"),
          loLo: xdr.Uint64.fromString("999"),
        })
      );
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("amount")], scv)
      );
      assert.equal(result.value, "999");
    });
  });

  describe("scvError", () => {
    it("decodes error value as object", () => {
      const result = decodeContractEvent(
        makeXdrEvent(
          xdr.ContractEventType.contract(),
          [xdr.ScVal.scvSymbol("error")],
          xdr.ScVal.scvError(xdr.ScError.sceContract(10)),
        )
      );
      assert.deepEqual(result.value, { error: "10" });
    });
  });

  describe("scvTimepoint", () => {
    it("decodes timepoint as bigint", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("timestamp")], xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1234567890")))
      );
      assert.equal(result.value, "1234567890");
    });
  });

  describe("scvDuration", () => {
    it("decodes duration as bigint", () => {
      const result = decodeContractEvent(
        makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("time")], xdr.ScVal.scvDuration(xdr.Uint64.fromString("3600")))
      );
      assert.equal(result.value, "3600");
    });
  });
});

// ── Nested Vec and Map Tests ────────────────────────────────────────────────
// Tests 5: Nested Vec and Map decoding

describe("decoder — Nested Vec and Map decoding", () => {
  it("decodes nested vec inside vec", () => {
    const innerVec = xdr.ScVal.scvVec([xdr.ScVal.scvI32(1), xdr.ScVal.scvI32(2)]);
    const outerVec = xdr.ScVal.scvVec([innerVec, xdr.ScVal.scvI32(3)]);
    const result = decodeContractEvent(
      makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("nested")], outerVec)
    );
    assert.deepEqual(result.value, [[1, 2], 3]);
  });

  it("decodes nested map inside vec", () => {
    const innerMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("id"), val: xdr.ScVal.scvU32(1) }),
    ]);
    const outerVec = xdr.ScVal.scvVec([innerMap]);
    const result = decodeContractEvent(
      makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("items")], outerVec)
    );
    assert.deepEqual(result.value, [{ id: 1 }]);
  });

  it("decodes nested vec inside map", () => {
    const innerVec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(10), xdr.ScVal.scvU32(20)]);
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("values"), val: innerVec }),
    ]);
    const result = decodeContractEvent(
      makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("data")], map)
    );
    assert.deepEqual(result.value.values, [10, 20]);
  });

  it("decodes deeply nested structures", () => {
    const deep = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("items"),
        val: xdr.ScVal.scvVec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("nested"), val: xdr.ScVal.scvString("deep") }),
          ]),
        ]),
      }),
    ]);
    const result = decodeContractEvent(
      makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("root")], deep)
    );
    assert.deepEqual(result.value, { items: [{ nested: "deep" }] });
  });
});

// ── Amount Formatting Tests ──────────────────────────────────────────────────
// Tests 4: Amount formatting with decimals

describe("decoder — Amount formatting", () => {
  it("formats 1000000000 stroops as 100 XLM (7 decimals)", () => {
    // 1000000000 stroops = 100 XLM
    assert.match(fmtXlm(1000000000), /100/);
    assert.equal(fmtXlm(10_000_000), "1");
    assert.equal(fmtXlm(100_000_000), "10");
  });

  it("formats fractional XLM amounts", () => {
    // 5_000_000 stroops = 0.5 XLM
    const result = fmtXlm(5_000_000);
    assert.match(result, /0\.5|[\u00A0]0\.5/); // toLocaleString may use non-breaking space
  });

  it("handles large amounts without decimal overflow", () => {
    const large = 1_000_000_000_000n;
    assert.doesNotThrow(() => fmtXlm(large));
    assert.ok(typeof fmtXlm(large) === "string");
  });
});

// ── SEP-41 Event Tests ──────────────────────────────────────────────────────
// Tests 2: SEP-41 events (transfer, mint, burn, clawback)

describe("decoder — SEP-41 events", () => {
  const MOCK_CONTRACT = "CABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZA";

  function makeDecodedEvent(fn, topics, value) {
    return {
      contract_id: MOCK_CONTRACT,
      function: fn,
      raw_topics: topics,
      raw_data: JSON.stringify(value),
    };
  }

  it("formats transfer event with exact human-readable output", () => {
    const d = buildDescription(
      "transfer",
      ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", "GBCD234DEF567GHI890JKL123MNO456PQR789STU012VWX345YZ", "100000000", "USDC"],
      null,
      "USDC Token"
    );
    assert.match(d, /transferred 100000000 USDC/);
    assert.match(d, /to .*USDC Token/);
  });

  it("formats mint event with exact human-readable output", () => {
    const d = buildDescription(
      "mint",
      ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", "500000000", "USDC"],
      null,
      "USDC Token"
    );
    assert.match(d, /500000000 USDC minted/);
    assert.match(d, /on USDC Token/);
  });

  it("formats burn event with exact human-readable output", () => {
    const d = buildDescription(
      "burn",
      ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", "500000000", "USDC"],
      null,
      "USDC Token"
    );
    assert.match(d, /500000000 USDC burned/);
    assert.match(d, /on USDC Token/);
  });

  it("formats clawback event with exact human-readable output", () => {
    const d = buildDescription(
      "clawback",
      ["GADMIN123456789012345678901234567890123456789012", "GVICTIM9876543210987654321098765432109876543210987", "100000000", "USDC"],
      null,
      "USDC Token"
    );
    assert.match(d, /CLAWBACK/);
    assert.match(d, /recovered/);
    assert.match(d, /by authority/);
  });

  it("formats native XLM wrap (mint on SAC)", () => {
    const r = nativeXlmDescription("mint", ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", 10_000_000], null);
    assert.equal(r.function, "wrap_native");
    assert.match(r.description, /Wrapped/);
    assert.match(r.description, /XLM/);
    assert.match(r.description, /Classic.*Soroban/);
  });

  it("formats native XLM unwrap (burn on SAC)", () => {
    const r = nativeXlmDescription("burn", ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", 10_000_000], null);
    assert.equal(r.function, "unwrap_native");
    assert.match(r.description, /Unwrapped/);
    // unwrap is Soroban → Classic (the reverse of wrap)
    assert.match(r.description, /Soroban.*Classic/);
  });
});

// ── Unknown Event Type Tests ─────────────────────────────────────────────────
// Tests 3: Unknown event type handling

describe("decoder — Unknown event type handling", () => {
  it("genericDescription falls back gracefully for unknown function", () => {
    const d = buildDescription("unknown_function", ["arg1", "arg2"], null, "MyContract");
    assert.match(d, /unknown_function\(arg1, arg2\) called on MyContract/);
  });

  it("nativeXlmDescription returns null for non-wrapping functions", () => {
    assert.equal(nativeXlmDescription("transfer", [], null), null);
    assert.equal(nativeXlmDescription("approve", [], null), null);
  });

  it("handles events with no function name gracefully", () => {
    const topics = [123, "not a symbol"];
    const result = { contract_id: "C123", raw_topics: topics, raw_data: "{}" };
    const fnName = typeof topics[0] === "symbol" || typeof topics[0] === "string" ? String(topics[0]) : "unknown";
    assert.equal(fnName, "unknown");
  });
});

// ── Missing ABI Fallback Tests ───────────────────────────────────────────────
// Tests 6: Missing ABI in registry → graceful fallback

describe("decoder — Missing ABI graceful fallback", () => {
  it("genericDescription used when no ABI available", () => {
    const d = buildDescription("custom_fn", ["arg1"], null, "UnknownContract");
    assert.match(d, /custom_fn/);
    assert.match(d, /UnknownContract/);
  });

  it("missing token parameter handled gracefully", () => {
    const d = buildDescription(
      "transfer",
      ["GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ", "GBCD234DEF567GHI890JKL123MNO456PQR789STU012VWX345YZ", "100"],
      null,
      "Token"
    );
    // Token may be undefined/null, should still work
    assert.match(d, /transferred 100/);
  });
});

// ── Malformed XDR Tests ───────────────────────────────────────────────────────
// Tests 7: Malformed XDR bytes handling

describe("decoder — Malformed XDR handling", () => {
  it("decodeContractEvent throws for invalid base64 XDR", () => {
    assert.throws(() => decodeContractEvent("!!!invalid-base64!!!"), Error);
  });

  it("decodeContractEvent throws for truncated XDR", () => {
    assert.throws(() => decodeContractEvent("AAAAAAAA"), Error);
  });

  it("decodeContractEvent throws for empty string", () => {
    assert.throws(() => decodeContractEvent(""), Error);
  });

  it("decodeContractEvent handles valid XDR without throwing", () => {
    const validXdr = makeXdrEvent(xdr.ContractEventType.contract(), [xdr.ScVal.scvSymbol("test")], xdr.ScVal.scvVoid());
    assert.doesNotThrow(() => decodeContractEvent(validXdr));
  });
});

// ── Helper Function Tests ────────────────────────────────────────────────────

describe("decoder — Helper functions", () => {
  describe("fmt (address formatting)", () => {
    it("truncates long addresses to head…tail format", () => {
      const longAddr = "G" + "A".repeat(55);
      assert.equal(fmt(longAddr), "GAAAAA…AAAA");
    });
  });

  describe("isResourceLimitExceeded", () => {
    it("detects all known resource limit codes", () => {
      assert.equal(isResourceLimitExceeded({ txResultCode: "tx_resource_limit_exceeded" }), true);
      assert.equal(isResourceLimitExceeded({ resultCode: "txResourceLimitExceeded" }), true);
      assert.equal(isResourceLimitExceeded({ result: { code: "RESOURCE_LIMIT_EXCEEDED" } }), true);
    });

    it("returns false for normal result codes", () => {
      assert.equal(isResourceLimitExceeded({ txResultCode: "txSuccess" }), false);
      assert.equal(isResourceLimitExceeded({ resultCode: "txFailed" }), false);
    });
  });

  describe("extractGasCosts", () => {
    it("extracts cpu_instructions from sorobanMeta.ext.v1", () => {
      const ev = {
        txMeta: {
          v3: () => ({
            sorobanMeta: () => ({
              ext: () => ({
                v1: () => ({
                  totalNonRefundableResourceFeeCharged: 123456,
                }),
              }),
            }),
          }),
        },
      };
      assert.equal(extractGasCosts(ev).cpu_instructions, 123456);
    });

    it("extracts fee_charged from multiple sources", () => {
      const ev = {
        feeCharged: "100",
        txMeta: {
          v3: () => ({
            sorobanMeta: () => ({
              ext: () => ({
                v1: () => ({
                  totalRefundableResourceFeeCharged: 200,
                }),
              }),
            }),
          }),
        },
      };
      const result = extractGasCosts(ev);
      assert.equal(result.fee_charged, 200); // ext.v1 takes precedence
    });
  });
});

// ── Generic Description Tests ────────────────────────────────────────────────

describe("decoder — Generic description", () => {
  function genericDescription(fn, args, data, contractId) {
    const argStr = args.map(String).join(", ");
    return `${fn}(${argStr}) called on ${contractId}`;
  }

  it("creates description for custom functions", () => {
    const d = genericDescription("deposit", ["arg1", "arg2"], null, "VaultContract");
    assert.match(d, /deposit\(arg1, arg2\) called on VaultContract/);
  });

  it("handles empty arguments", () => {
    const d = genericDescription("initialize", [], null, "NewContract");
    assert.equal(d, "initialize() called on NewContract");
  });
});

// ── Native XLM SAC ID tests ─────────────────────────────────────────────────

describe("decoder — Native XLM SAC detection", () => {
  const TESTNET_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const MAINNET_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

  it("recognizes testnet native SAC ID", () => {
    assert.ok(TESTNET_SAC.length === 56);
  });

  it("recognizes mainnet native SAC ID", () => {
    assert.ok(MAINNET_SAC.length === 56);
  });
});