/**
 * Admin auth + optional TOTP second factor (issue #738).
 * Uses a minimal Express app so tests do not require Postgres.
 */
import express from "express";
import request from "supertest";
import { adminAuthMiddleware } from "../../src/admin/adminAuth.js";
import { generateTotp } from "../../src/admin/totp.js";

/** Well-known base32 secret ("Hello!" bytes) used in RFC / library examples. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const ADMIN_TOKEN = "totp-test-admin-secret";

function buildApp() {
  const app = express();
  app.get("/api/admin/ping", adminAuthMiddleware, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("adminAuth TOTP second factor", () => {
  let originalAdminSecret;
  let originalTotpSecret;
  let app;

  beforeAll(() => {
    originalAdminSecret = process.env.ADMIN_SECRET;
    originalTotpSecret = process.env.ADMIN_TOTP_SECRET;
    process.env.ADMIN_SECRET = ADMIN_TOKEN;
    app = buildApp();
  });

  afterEach(() => {
    if (originalTotpSecret === undefined) {
      delete process.env.ADMIN_TOTP_SECRET;
    } else {
      process.env.ADMIN_TOTP_SECRET = originalTotpSecret;
    }
  });

  afterAll(() => {
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET;
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret;
    }
    if (originalTotpSecret === undefined) {
      delete process.env.ADMIN_TOTP_SECRET;
    } else {
      process.env.ADMIN_TOTP_SECRET = originalTotpSecret;
    }
  });

  it("allows Bearer alone when ADMIN_TOTP_SECRET is unset", async () => {
    delete process.env.ADMIN_TOTP_SECRET;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("allows Bearer + valid X-Admin-TOTP when 2FA is enabled", async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;
    const code = generateTotp(TOTP_SECRET);

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("X-Admin-TOTP", code);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects missing TOTP with totp_required when Bearer is valid", async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized", totp_required: true });
  });

  it("rejects wrong TOTP with totp_required when Bearer is valid", async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("X-Admin-TOTP", "000000");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized", totp_required: true });
  });

  it("does not leak totp_required when Bearer is wrong", async () => {
    process.env.ADMIN_TOTP_SECRET = TOTP_SECRET;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", "Bearer wrong-token-wrong-token")
      .set("X-Admin-TOTP", generateTotp(TOTP_SECRET));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(res.body.totp_required).toBeUndefined();
  });
});

describe("totp helper", () => {
  it("verifies a code generated for a fixed timestamp", async () => {
    const { verifyTotp, generateTotp } = await import("../../src/admin/totp.js");
    const now = 1_700_000_000_000; // fixed ms
    const code = generateTotp(TOTP_SECRET, { now });
    expect(verifyTotp(TOTP_SECRET, code, { now })).toBe(true);
    expect(verifyTotp(TOTP_SECRET, code, { now: now + 30_000 })).toBe(true); // +1 step window
    expect(verifyTotp(TOTP_SECRET, "999999", { now })).toBe(false);
  });
});
