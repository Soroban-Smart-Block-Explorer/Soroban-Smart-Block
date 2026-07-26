import { describe, it, expect } from "vitest";
import { isMuxedAddress, muxedId, resolveMuxed } from "../src/utils/strkey";

// Known-valid muxed test vector (SEP-23): MA... encodes base account
// GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ with ID
// 9223372036854775808.
const MUXED_ADDRESS = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const BASE_ADDRESS = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const ID = "9223372036854775808";

describe("strkey utils — muxed address support (issue #531)", () => {
  it("resolves a valid muxed address to its base G... account", () => {
    expect(resolveMuxed(MUXED_ADDRESS)).toBe(BASE_ADDRESS);
  });

  it("extracts the numeric multiplexing ID from a muxed address", () => {
    expect(muxedId(MUXED_ADDRESS)).toBe(ID);
  });

  it("returns null for a non-muxed (G...) address", () => {
    expect(resolveMuxed(BASE_ADDRESS)).toBeNull();
    expect(muxedId(BASE_ADDRESS)).toBeNull();
  });

  it("returns null for a malformed muxed-looking address", () => {
    const malformed = "M" + "A".repeat(67);
    expect(isMuxedAddress(malformed)).toBe(true);
    expect(resolveMuxed(malformed)).toBeNull();
    expect(muxedId(malformed)).toBeNull();
  });
});
