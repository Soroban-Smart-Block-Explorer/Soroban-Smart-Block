import { jest } from "@jest/globals";
import request from "supertest";

const { csrfTokenHandler, verifyCsrf, generateToken, COOKIE_NAME, HEADER_NAME } = await import("../src/csrf.js");

// Mock Express app for integration testing
function createMockApp() {
  const express = await import("express");
  const app = express.default();

  app.use(express.default.json());
  app.use(express.default.urlencoded({ extended: false }));

  app.get("/api/csrf-token", csrfTokenHandler);

  app.post("/protected", verifyCsrf, (req, res) => {
    res.json({ success: true });
  });

  app.post("/protected-api-key", verifyCsrf, (req, res) => {
    res.json({ success: true });
  });

  app.post("/admin/test", verifyCsrf, (req, res) => {
    res.json({ success: true });
  });

  app.ws("/socket", verifyCsrf, (ws) => {
    ws.send("connected");
  });

  return app;
}

describe("CSRF Protection — Double-Submit Cookie Pattern", () => {
  describe("csrfTokenHandler", () => {
    it("generates and returns a fresh CSRF token", async () => {
      const app = await createMockApp();
      const res = await request(app).get("/api/csrf-token");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("csrfToken");
      expect(typeof res.body.csrfToken).toBe("string");
      expect(res.body.csrfToken.length).toBe(64); // 32 bytes as hex

      // Token should also be set as HttpOnly cookie
      const cookieHeader = res.headers["set-cookie"]?.[0];
      expect(cookieHeader).toContain(`${COOKIE_NAME}=`);
      expect(cookieHeader).toContain("HttpOnly");
    });

    it("reuses an existing valid token when present (concurrent requests don't invalidate each other)", async () => {
      const app = await createMockApp();

      // Get initial token
      const res1 = await request(app).get("/api/csrf-token");
      const token1 = res1.body.csrfToken;
      const cookie1 = res1.headers["set-cookie"]?.[0];

      // Make a second request with the same cookie
      const res2 = await request(app)
        .get("/api/csrf-token")
        .set("Cookie", `${COOKIE_NAME}=${token1}`);

      const token2 = res2.body.csrfToken;

      // Should return the same token (reuse)
      expect(token2).toBe(token1);
    });
  });

  describe("verifyCsrf — Token Matching", () => {
    it("rejects requests with missing CSRF token", async () => {
      const app = await createMockApp();

      const res = await request(app)
        .post("/protected")
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("CSRF token missing");
    });

    it("rejects requests with mismatched CSRF token (stale cookie)", async () => {
      const app = await createMockApp();

      const token1 = generateToken();
      const token2 = generateToken();

      const res = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token1}`)
        .set(HEADER_NAME, token2) // Different token in header
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("CSRF token mismatch");
    });

    it("accepts requests with matching CSRF token (cookie and header)", async () => {
      const app = await createMockApp();
      const token = generateToken();

      const res = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token}`)
        .set(HEADER_NAME, token)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("verifyCsrf — Concurrent Tabs (Shared Token)", () => {
    it("allows multiple concurrent requests from different tabs using the same token", async () => {
      const app = await createMockApp();
      const token = generateToken();

      // Simulate Tab 1 request
      const res1 = request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token}`)
        .set(HEADER_NAME, token)
        .send({});

      // Simulate Tab 2 request (same token, same cookie)
      const res2 = request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token}`)
        .set(HEADER_NAME, token)
        .send({});

      // Both should succeed
      const [r1, r2] = await Promise.all([res1, res2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });

    it("handles stale token from one tab when another tab has refreshed", async () => {
      const app = await createMockApp();

      const token1 = generateToken();
      const token2 = generateToken();

      // Tab 1: uses old token
      const res1 = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token1}`)
        .set(HEADER_NAME, token1)
        .send({});

      expect(res1.status).toBe(200); // Old token still works while cookie is valid

      // Tab 2: after refresh, uses new token (simulating server-side refresh)
      const res2 = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token2}`)
        .set(HEADER_NAME, token2)
        .send({});

      expect(res2.status).toBe(200); // New token works

      // Tab 1: trying to use old token with new cookie — should fail
      const res3 = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${token2}`)
        .set(HEADER_NAME, token1) // Old token in header
        .send({});

      expect(res3.status).toBe(403); // Mismatch between cookie and header
      expect(res3.body.error).toContain("CSRF token mismatch");
    });
  });

  describe("verifyCsrf — SameSite Attribute (Dev vs Prod)", () => {
    it("sets SameSite=Lax in development environment", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      try {
        const app = await createMockApp();
        const res = await request(app).get("/api/csrf-token");

        const cookieHeader = res.headers["set-cookie"]?.[0];
        expect(cookieHeader).toContain("SameSite=Lax");
        expect(cookieHeader).not.toContain("SameSite=Strict");
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it("sets SameSite=Strict in production environment", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        const app = await createMockApp();
        const res = await request(app).get("/api/csrf-token");

        const cookieHeader = res.headers["set-cookie"]?.[0];
        expect(cookieHeader).toContain("SameSite=Strict");
        expect(cookieHeader).not.toContain("SameSite=Lax");
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it("sets Secure flag only in production environment", async () => {
      const originalEnv = process.env.NODE_ENV;

      // Test development
      process.env.NODE_ENV = "development";
      let app = await createMockApp();
      let res = await request(app).get("/api/csrf-token");
      let cookieHeader = res.headers["set-cookie"]?.[0];
      expect(cookieHeader).not.toContain("Secure;");

      // Test production
      process.env.NODE_ENV = "production";
      app = await createMockApp();
      res = await request(app).get("/api/csrf-token");
      cookieHeader = res.headers["set-cookie"]?.[0];
      expect(cookieHeader).toContain("Secure");

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("verifyCsrf — Exemptions", () => {
    it("allows API-key-authenticated requests to bypass CSRF verification", async () => {
      const app = await createMockApp();

      const res = await request(app)
        .post("/protected-api-key")
        .set("x-api-key", "valid-key")
        .send({});

      // Should succeed without CSRF token
      expect(res.status).toBe(200);
    });

    it("allows admin routes to bypass CSRF verification", async () => {
      const app = await createMockApp();

      const res = await request(app)
        .post("/admin/test")
        .send({});

      // Should succeed without CSRF token (admin routes are gated by Bearer auth)
      expect(res.status).toBe(200);
    });

    it("allows GET requests to bypass CSRF verification", async () => {
      const app = await createMockApp();

      const res = await request(app).get("/protected");

      // GET requests are safe/idempotent — should pass
      expect(res.status).toBe(404); // Route not found (no GET handler), not 403 CSRF
    });
  });

  describe("verifyCsrf — Token Format Validation", () => {
    it("rejects requests with invalid token format (wrong length)", async () => {
      const app = await createMockApp();

      const invalidToken = "short";
      const validCookie = generateToken();

      const res = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${validCookie}`)
        .set(HEADER_NAME, invalidToken)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("CSRF token mismatch");
    });

    it("rejects requests where cookie token is invalid (wrong length)", async () => {
      const app = await createMockApp();

      const validToken = generateToken();
      const invalidCookie = "invalid";

      const res = await request(app)
        .post("/protected")
        .set("Cookie", `${COOKIE_NAME}=${invalidCookie}`)
        .set(HEADER_NAME, validToken)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("CSRF token mismatch");
    });
  });
});
