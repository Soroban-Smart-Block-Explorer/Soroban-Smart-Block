// Issue #557: on startup, indexer/src/abis/*.json are auto-registered into the
// contracts table when their contract ID isn't already present, and left
// untouched when it is.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const { db } = await import("../../src/db.js");
const { seedBuiltinAbis } = await import("../../src/abiSeeder.js");

const STELLARSWAP_ID = "CBPTPOUUYZGYANHS3R2HWXSEYD34ND65G6VOMP2EZ73XVL5LGRVCV3YN";
const BLEND_ID = "CCCUGABBMNVF6IRDXAW5KFGHGIR2VWXE2W4ICA2V3VGHROUX45O54P2V";

describe("seedBuiltinAbis (issue #557)", () => {
  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM contracts WHERE id = ANY($1)", [[STELLARSWAP_ID, BLEND_ID]]);
  });

  afterAll(async () => {
    await db.query("DELETE FROM contracts WHERE id = ANY($1)", [[STELLARSWAP_ID, BLEND_ID]]);
  });

  it("seeds the StellarSwap and Blend built-in ABIs on a fresh database", async () => {
    const result = await seedBuiltinAbis();
    expect(result.seeded).toBeGreaterThanOrEqual(2);

    const swap = await db.getContractMeta(STELLARSWAP_ID);
    expect(swap).not.toBeNull();
    expect(swap.name).toBe("StellarSwap");
    expect(swap.protocol_type).toBe("dex");
    expect(swap.registered_by).toBe("builtin-seed");

    const blend = await db.getContractMeta(BLEND_ID);
    expect(blend).not.toBeNull();
    expect(blend.name).toBe("Blend");
    expect(blend.protocol_type).toBe("lending");
  });

  it("does not overwrite a contract ID that is already registered", async () => {
    await db.upsertContractMeta({
      id: STELLARSWAP_ID,
      name: "Custom Override",
      description: "registered before the seeder ran",
      functions: [],
    });

    const result = await seedBuiltinAbis();
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(2);

    // The seeder must not have called upsertContractMeta for this ID at all —
    // both the overridden name and the empty functions array survive untouched.
    const meta = await db.getContractMeta(STELLARSWAP_ID);
    expect(meta.name).toBe("Custom Override");
    expect(meta.functions).toEqual([]);
  });
});
