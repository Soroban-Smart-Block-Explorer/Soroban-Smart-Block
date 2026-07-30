import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

const mockConstructEvent = jest.fn();

jest.unstable_mockModule("stripe", () => ({
  default: jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  })),
}));

jest.unstable_mockModule("../../src/db.js", () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

const { stripeWebhookRouter } = await import("../../src/billing/stripeWebhook.js");

function createTestApp() {
  const app = express();
  app.use("/api/billing", stripeWebhookRouter);
  return app;
}

describe("POST /api/billing/stripe-webhook (issue #618)", () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    mockConstructEvent.mockReset();
  });

  it("returns 400 when signature is invalid", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const res = await request(app)
      .post("/api/billing/stripe-webhook")
      .set("stripe-signature", "tampered_signature")
      .send('{"test": "data"}')
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid signature" });
  });

  it("returns 200 when signature is valid", async () => {
    mockConstructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: { object: { metadata: { api_key_id: "test-key-id" } } },
    });

    const res = await request(app)
      .post("/api/billing/stripe-webhook")
      .set("stripe-signature", "valid_signature")
      .send('{"test": "data"}')
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("received", true);
  });
});
