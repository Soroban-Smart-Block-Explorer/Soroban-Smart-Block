import request from "supertest";

// Issue #550 — GET /api/assets and GET /api/assets/:issuer/:code, backed by
// the `assets` table (migration 015) populated as classic asset transfers are
// decoded (see decoder.js's classicAssetLabel). Response shape:
// { code, issuer, name, decimals, logo_url, home_domain }.

const DB_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");

const ISSUER = "GA22K667OGPC3R32NRJTNQG4KWT2OFGHNNGZ2JQMSIGLT7AFHVIOMJ43";

describe("GET /api/assets/:issuer/:code (issue #550)", () => {
  let server;

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM assets WHERE issuer = $1", [ISSUER]);
    server = startApi();
  });

  afterAll(async () => {
    await db.query("DELETE FROM assets WHERE issuer = $1", [ISSUER]);
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns 404 when the asset has never been resolved", async () => {
    const res = await request(server).get(`/api/assets/${ISSUER}/GHOST`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns the asset metadata once it has been indexed", async () => {
    await db.upsertAsset({
      code: "USDC",
      issuer: ISSUER,
      name: "USDC",
      domain: "centre.io",
      logo_url: "https://centre.io/logo.png",
      decimals: 7,
    });

    const res = await request(server).get(`/api/assets/${ISSUER}/USDC`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: "USDC",
      issuer: ISSUER,
      name: "USDC",
      decimals: 7,
      logo_url: "https://centre.io/logo.png",
      home_domain: "centre.io",
    });
  });
});

describe("GET /api/assets (issue #550)", () => {
  let server;
  const issuer = "GB" + "L".repeat(54);
  const codes = ["AAA1", "AAA2", "AAA3"];

  beforeAll(async () => {
    await db.init();
    await db.query("DELETE FROM assets WHERE issuer = $1", [issuer]);
    for (const code of codes) {
      await db.upsertAsset({ code, issuer, name: code, domain: null, logo_url: null, decimals: 7 });
    }
    server = startApi();
  });

  afterAll(async () => {
    await db.query("DELETE FROM assets WHERE issuer = $1", [issuer]);
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns a paginated list with a cursor for the next page", async () => {
    const first = await request(server).get("/api/assets").query({ limit: 2 });
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.data)).toBe(true);
    expect(first.body.data.length).toBeLessThanOrEqual(2);

    if (first.body.next_cursor !== null) {
      const second = await request(server).get("/api/assets").query({ limit: 2, after: first.body.next_cursor });
      expect(second.status).toBe(200);
      // no overlap between pages
      const firstIds = new Set(first.body.data.map((a) => `${a.code}:${a.issuer}`));
      for (const asset of second.body.data) {
        expect(firstIds.has(`${asset.code}:${asset.issuer}`)).toBe(false);
      }
    }
  });

  it("rejects an invalid limit", async () => {
    const res = await request(server).get("/api/assets").query({ limit: 0 });
    expect(res.status).toBe(422);
  });
});
