/**
 * Admin auth decision-branch coverage (issue #765).
 * Covers branches not exercised by adminAuth.totp.test.js: missing
 * ADMIN_SECRET, IP allowlist enforcement, missing/malformed Authorization
 * header, and timing-safe comparison with mismatched-length tokens.
 */
import express from "express";
import request from "supertest";
import { adminAuthMiddleware } from "../../src/admin/adminAuth.js";

const ADMIN_TOKEN = "branches-test-admin-secret";

function buildApp() {
  const app = express();
  app.get("/api/admin/ping", adminAuthMiddleware, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("adminAuth decision branches", () => {
  let originalAdminSecret;
  let originalAllowlist;
  let app;

  beforeAll(() => {
    originalAdminSecret = process.env.ADMIN_SECRET;
    originalAllowlist = process.env.ADMIN_IP_ALLOWLIST;
    app = buildApp();
  });

  afterEach(() => {
    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET;
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret;
    }
    if (originalAllowlist === undefined) {
      delete process.env.ADMIN_IP_ALLOWLIST;
    } else {
      process.env.ADMIN_IP_ALLOWLIST = originalAllowlist;
    }
  });

  it("denies with 401 when ADMIN_SECRET is not configured", async () => {
    delete process.env.ADMIN_SECRET;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", "Bearer anything");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("denies with 403 when client IP is outside ADMIN_IP_ALLOWLIST", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("X-Forwarded-For", "8.8.8.8");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("allows when client IP matches ADMIN_IP_ALLOWLIST", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;
    process.env.ADMIN_IP_ALLOWLIST = "10.0.0.0/8";

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .set("X-Forwarded-For", "10.1.2.3");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("denies with 401 when Authorization header is missing", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;

    const res = await request(app).get("/api/admin/ping");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("denies with 401 when Authorization header is not a Bearer token", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Basic ${ADMIN_TOKEN}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("denies with 401 when the token length differs from the secret's", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", "Bearer short");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("denies with 401 when the token is the wrong value at equal length", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;
    const wrongSameLength = "x".repeat(ADMIN_TOKEN.length);

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${wrongSameLength}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("allows when the Bearer token matches ADMIN_SECRET", async () => {
    process.env.ADMIN_SECRET = ADMIN_TOKEN;

    const res = await request(app)
      .get("/api/admin/ping")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
