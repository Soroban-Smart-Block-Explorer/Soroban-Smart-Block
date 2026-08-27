import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xdr, StrKey } from "@stellar/stellar-sdk";
import { scValToJs, scValToJsTyped, buildTypeIndex } from "../src/scval.js";

// ── scValToJs Tests ────────────────────────────────────────────────────────

describe("scValToJs - ScVal type conversion", () => {
  it("handles null scval", () => {
    assert.equal(scValToJs(null), null);
  });

  it("handles undefined scval", () => {
    assert.equal(scValToJs(undefined), null);
  });

  it("handles scvVoid", () => {
    const scv = xdr.ScVal.scvVoid();
    assert.equal(scValToJs(scv), null);
  });

  it("handles scvError", () => {
    const scv = xdr.ScVal.scvError(1);
    assert.deepEqual(scValToJs(scv), { error: "1" });
  });

  it("handles scvU32", () => {
    const scv = xdr.ScVal.scvU32(42);
    assert.equal(scValToJs(scv), 42);
  });

  it("handles scvI32", () => {
    const scv = xdr.ScVal.scvI32(-42);
    assert.equal(scValToJs(scv), -42);
  });

  it("handles scvU64 as BigInt", () => {
    const scv = xdr.ScVal.scvU64(xdr.Uint64.fromString("18446744073709551615"));
    assert.equal(scValToJs(scv), 18446744073709551615n);
  });

  it("handles scvI64 as BigInt", () => {
    const scv = xdr.ScVal.scvI64(xdr.Int64.fromString("-9223372036854775808"));
    assert.equal(scValToJs(scv), -9223372036854775808n);
  });

  it("handles scvTimepoint as BigInt", () => {
    const scv = xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1000"));
    assert.equal(scValToJs(scv), 1000n);
  });

  it("handles scvDuration as BigInt", () => {
    const scv = xdr.ScVal.scvDuration(xdr.Uint64.fromString("500"));
    assert.equal(scValToJs(scv), 500n);
  });

  it("handles scvU128 as BigInt", () => {
    const scv = xdr.ScVal.scvU128(
      new xdr.UInt128Parts({
        hi: xdr.Uint64.fromString("0"),
        lo: xdr.Uint64.fromString("12345"),
      })
    );
    assert.equal(scValToJs(scv), 12345n);
  });

  it("handles scvI128 as BigInt", () => {
    const scv = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString("0"),
        lo: xdr.Uint64.fromString("12345"),
      })
    );
    assert.equal(scValToJs(scv), 12345n);
  });

  it("handles scvU256 as BigInt", () => {
    const scv = xdr.ScVal.scvU256(
      new xdr.UInt256Parts({
        hiHi: xdr.Uint64.fromString("0"),
        hiLo: xdr.Uint64.fromString("0"),
        loHi: xdr.Uint64.fromString("0"),
        loLo: xdr.Uint64.fromString("999"),
      })
    );
    assert.equal(scValToJs(scv), 999n);
  });

  it("handles scvI256 as BigInt", () => {
    const scv = xdr.ScVal.scvI256(
      new xdr.Int256Parts({
        hiHi: xdr.Int64.fromString("0"),
        hiLo: xdr.Uint64.fromString("0"),
        loHi: xdr.Uint64.fromString("0"),
        loLo: xdr.Uint64.fromString("999"),
      })
    );
    assert.equal(scValToJs(scv), 999n);
  });

  it("handles scvBytes as hex string", () => {
    const scv = xdr.ScVal.scvBytes(Buffer.from("hello", "utf8"));
    assert.equal(scValToJs(scv), "68656c6c6f");
  });

  it("handles scvString", () => {
    const scv = xdr.ScVal.scvString("test string");
    assert.equal(scValToJs(scv), "test string");
  });

  it("handles scvSymbol", () => {
    const scv = xdr.ScVal.scvSymbol("test_symbol");
    assert.equal(scValToJs(scv), "test_symbol");
  });

  it("handles scvVec of primitives", () => {
    const scv = xdr.ScVal.scvVec([
      xdr.ScVal.scvI32(1),
      xdr.ScVal.scvBool(true),
    ]);
    assert.deepEqual(scValToJs(scv), [1, true]);
  });

  it("handles scvMap", () => {
    const scv = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("key1"),
        val: xdr.ScVal.scvString("value1"),
      }),
    ]);
    assert.deepEqual(scValToJs(scv), { key1: "value1" });
  });

  it("handles scvAddress - account", () => {
    const ed25519 = Buffer.alloc(32, 0xaa);
    const scv = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(ed25519))
    );
    const expected = StrKey.encodeEd25519PublicKey(ed25519);
    assert.equal(scValToJs(scv), expected);
  });

  it("handles scvAddress - contract", () => {
    const contractId = Buffer.alloc(32, 0xbb);
    const scv = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeContract(contractId)
    );
    const expected = StrKey.encodeContract(contractId);
    assert.equal(scValToJs(scv), expected);
  });

  it("handles scvLedgerKeyContractInstance", () => {
    const scv = xdr.ScVal.scvLedgerKeyContractInstance();
    assert.deepEqual(scValToJs(scv), { type: "ledgerKeyContractInstance" });
  });

  it("handles scvLedgerKeyNonce", () => {
    const scv = xdr.ScVal.scvLedgerKeyNonce(
      new xdr.ScNonceKey({ nonce: xdr.Uint64.fromString("123") })
    );
    assert.deepEqual(scValToJs(scv), { type: "ledgerKeyNonce", nonce: 123n });
  });

  it("handles scvContractInstance", () => {
    const scv = xdr.ScVal.scvContractInstance();
    assert.deepEqual(scValToJs(scv), { type: "contractInstance" });
  });

  it("handles fallback for unknown types", () => {
    const scv = { switch: () => ({ name: "unknownType" }), toString: () => "fallback" };
    assert.equal(scValToJs(scv), "fallback");
  });
});

// ── scValToJsTyped Tests ───────────────────────────────────────────────────

describe("scValToJsTyped - Type-aware ScVal conversion", () => {
  it("returns plain value when typeHint is null", () => {
    const scv = xdr.ScVal.scvI32(42);
    assert.equal(scValToJsTyped(scv, null, new Map()), 42);
  });

  it("returns plain value when typeIndex is empty", () => {
    const scv = xdr.ScVal.scvI32(42);
    assert.equal(scValToJsTyped(scv, "SomeType", new Map()), 42);
  });

  it("decodes struct from scvMap", () => {
    const scv = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("field1"),
        val: xdr.ScVal.scvString("value1"),
      }),
    ]);
    const typeIndex = new Map([
      ["TestStruct", { kind: "struct", fields: [{ name: "field1", type: "String" }] }],
    ]);
    const result = scValToJsTyped(scv, "TestStruct", typeIndex);
    assert.deepEqual(result, { field1: "value1" });
  });

  it("decodes struct tuple from scvVec", () => {
    const scv = xdr.ScVal.scvVec([xdr.ScVal.scvString("value1")]);
    const typeIndex = new Map([
      ["TestTuple", { kind: "struct", fields: [{ name: "field1", type: "String" }] }],
    ]);
    const result = scValToJsTyped(scv, "TestTuple", typeIndex);
    assert.deepEqual(result, { field1: "value1" });
  });

  it("decodes enum from scvU32", () => {
    const scv = xdr.ScVal.scvU32(1);
    const typeIndex = new Map([
      ["TestEnum", { kind: "enum", cases: [{ name: "VariantA", value: 1 }] }],
    ]);
    const result = scValToJsTyped(scv, "TestEnum", typeIndex);
    assert.deepEqual(result, { _type: "TestEnum", variant: "VariantA", value: 1 });
  });

  it("decodes enum with unknown discriminant", () => {
    const scv = xdr.ScVal.scvU32(99);
    const typeIndex = new Map([
      ["TestEnum", { kind: "enum", cases: [{ name: "VariantA", value: 1 }] }],
    ]);
    const result = scValToJsTyped(scv, "TestEnum", typeIndex);
    assert.deepEqual(result, { _type: "TestEnum", variant: "Unknown(99)", value: 99 });
  });

  it("decodes union from scvVec", () => {
    const scv = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("SomeVariant"),
      xdr.ScVal.scvU32(42),
    ]);
    const typeIndex = new Map([
      ["TestUnion", { kind: "union", cases: [{ name: "SomeVariant", types: ["u32"] }] }],
    ]);
    const result = scValToJsTyped(scv, "TestUnion", typeIndex);
    assert.deepEqual(result, { _type: "TestUnion", variant: "SomeVariant", data: 42 });
  });

  it("decodes void union variant", () => {
    const scv = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("VoidVariant")]);
    const typeIndex = new Map([
      ["TestUnion", { kind: "union", cases: [{ name: "VoidVariant", types: [] }] }],
    ]);
    const result = scValToJsTyped(scv, "TestUnion", typeIndex);
    assert.deepEqual(result, { _type: "TestUnion", variant: "VoidVariant" });
  });

  it("decodes union from bare symbol", () => {
    const scv = xdr.ScVal.scvSymbol("JustSymbol");
    const typeIndex = new Map([
      ["TestUnion", { kind: "union", cases: [{ name: "JustSymbol" }] }],
    ]);
    const result = scValToJsTyped(scv, "TestUnion", typeIndex);
    assert.deepEqual(result, { _type: "TestUnion", variant: "JustSymbol" });
  });

  it("decodes error_enum from scvU32", () => {
    const scv = xdr.ScVal.scvU32(2);
    const typeIndex = new Map([
      ["TestError", { kind: "error_enum", cases: [{ name: "NotFound", value: 2 }] }],
    ]);
    const result = scValToJsTyped(scv, "TestError", typeIndex);
    assert.deepEqual(result, { _type: "TestError", error: "NotFound", code: 2 });
  });
});

// ── buildTypeIndex Tests ───────────────────────────────────────────────────

describe("buildTypeIndex", () => {
  it("builds map from types array", () => {
    const types = [
      { name: "StructA", kind: "struct" },
      { name: "EnumB", kind: "enum" },
    ];
    const index = buildTypeIndex(types);
    assert.ok(index instanceof Map);
    assert.equal(index.size, 2);
    assert.equal(index.get("StructA").kind, "struct");
    assert.equal(index.get("EnumB").kind, "enum");
  });

  it("handles null types array", () => {
    const index = buildTypeIndex(null);
    assert.equal(index.size, 0);
  });

  it("ignores entries without name", () => {
    const types = [{ kind: "struct" }, { name: "OnlyNamed" }];
    const index = buildTypeIndex(types);
    assert.equal(index.size, 1);
    assert.equal(index.get("OnlyNamed").name, "OnlyNamed");
  });
});