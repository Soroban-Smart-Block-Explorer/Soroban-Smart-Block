import request from "supertest";

// Issue #810: GET /api/tokens/:contractId/nfts/analytics returns collection-level
// NFT analytics — mint volume over time and a unique-holder-count trend —
// derived from already-indexed NFT mint/transfer events.

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.API_KEY = "test-api-key";
process.env.VERIFY_ABI = "false";

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

describe("GET /api/tokens/:contractId/nfts/analytics (issue #810)", () => {
  let server;
  const contractId = "CNFT810ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN";

  // 56-char strkey addresses using the base32 alphabet [A-Z2-7]
  const addr = (seed) => `G${seed.repeat(55)}`;
  const M1 = addr("A");
  const M2 = addr("B");
  const M3 = addr("C");
  const M4 = addr("D");
  const M5 = addr("E");
  const C1 = addr("F");
  const T1 = addr("H");
  const T2 = addr("I");
  const N1 = addr("L");
  const O1 = addr("J");
  const O2 = addr("K");

  const insert = async (rows) => {
    for (const [functionName, ledger, txHash, description, rawTopics, createdAt] of rows) {
      await db.query(
        `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [contractId, functionName, ledger, txHash, description, JSON.stringify(rawTopics), createdAt],
      );
    }
  };

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM events WHERE contract_id = $1", [contractId]);

    const now = Date.now();
    const day = 86_400_000;
    const today = new Date(now);
    // 5 mints today (M1..M5)
    await insert(
      [M1, M2, M3, M4, M5].map((to, i) => [
        "mint_nft",
        3000 + i,
        `tx_mint_${i}`,
        `${to} minted NFT #${i} on ${contractId}`,
        ["mint_nft", to],
        today,
      ]),
    );
    // 2 creates today (M1 overlaps an existing recipient, C1 is new)
    await insert(
      [M1, C1].map((to, i) => [
        "create",
        3100 + i,
        `tx_create_${i}`,
        `${to} created NFT #${i} on ${contractId}`,
        ["create", to],
        today,
      ]),
    );
    // 3 transfers today (M2 overlaps, T1/T2 are new) — recipient is topics[2]
    await insert(
      [[M2], [T1], [T2]].map(([to], i) => [
        "transfer",
        3200 + i,
        `tx_tfr_${i}`,
        `${M1} transferred NFT #${i} to ${to}`,
        ["transfer", M1, to],
        today,
      ]),
    );
    // N1 mints twice on two different days within the window — must count
    // once toward the cumulative holder curve
    await insert([
      ["mint_nft", 3300, "tx_n1_a", `${N1} minted NFT #100 on ${contractId}`, ["mint_nft", N1], new Date(now - 5 * day)],
      ["mint_nft", 3310, "tx_n1_b", `${N1} minted NFT #101 on ${contractId}`, ["mint_nft", N1], new Date(now - 2 * day)],
    ]);
    // 2 mints outside the 30-day window — count in totals, not in the series
    await insert([
      ["mint_nft", 1000, "tx_old_0", `${O1} minted NFT #200 on ${contractId}`, ["mint_nft", O1], new Date(now - 40 * day)],
      ["mint_nft", 1001, "tx_old_1", `${O2} minted NFT #201 on ${contractId}`, ["mint_nft", O2], new Date(now - 40 * day)],
    ]);

    server = startApi();
  });

  afterAll(async () => {
    await db.query("DELETE FROM events WHERE contract_id = $1", [contractId]);
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns totals and a zero-filled 30-day series for the seeded collection", async () => {
    const res = await request(server).get(`/api/tokens/${contractId}/nfts/analytics`);
    expect(res.status).toBe(200);
    expect(res.body.contract_id).toBe(contractId);
    expect(res.body.days).toBe(30);

    // 5 mint_nft + 2 create + 2 (N1) + 2 old = 11 mints
    expect(res.body.totals.minted).toBe(11);
    expect(res.body.totals.transfers).toBe(3);
    // Distinct recipients all-time: M1..M5, C1, T1, T2, N1, O1, O2 = 11
    expect(res.body.totals.unique_holders).toBe(11);

    // Zero-filled window of exactly 30 days
    expect(res.body.mint_volume).toHaveLength(30);
    expect(res.body.holder_count).toHaveLength(30);

    // In-window mints: 7 today + 2 (N1) = 9; old mints excluded
    const mintSum = res.body.mint_volume.reduce((a, d) => a + d.count, 0);
    expect(mintSum).toBe(9);
    expect(res.body.mint_volume[29].count).toBe(7);

    // Cumulative holder curve ends at the 9 distinct in-window recipients
    // (M1..M5, C1, T1, T2, N1) — N1 counted once despite two mints
    expect(res.body.holder_count[29].count).toBe(9);
    expect(res.body.mint_volume[0].count).toBe(0);
    expect(res.body.holder_count[0].count).toBe(0);
  });

  it("respects a custom days window", async () => {
    // A 7-day window covers today + N1 events (2 and 5 days ago) but not the
    // 40-day-old mints
    const res = await request(server).get(`/api/tokens/${contractId}/nfts/analytics?days=7`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.mint_volume).toHaveLength(7);
    const mintSum = res.body.mint_volume.reduce((a, d) => a + d.count, 0);
    expect(mintSum).toBe(9);
    expect(res.body.mint_volume[6].count).toBe(7);
    expect(res.body.holder_count[6].count).toBe(9);
  });

  it("returns 422 for an invalid days value", async () => {
    const res = await request(server).get(`/api/tokens/${contractId}/nfts/analytics?days=0`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid days");
  });

  it("returns empty analytics for a collection with no events", async () => {
    const res = await request(server).get("/api/tokens/CNOEVENTS810/analytics");
    expect(res.status).toBe(200);
    expect(res.body.totals.minted).toBe(0);
    expect(res.body.totals.transfers).toBe(0);
    expect(res.body.totals.unique_holders).toBe(0);
    expect(res.body.mint_volume).toHaveLength(30);
    expect(res.body.mint_volume.every((d) => d.count === 0)).toBe(true);
    expect(res.body.holder_count.every((d) => d.count === 0)).toBe(true);
  });
});
