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
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.unstable_mockModule("stripe", () => ({
  default: jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  })),
}));

jest.unstable_mockModule("../../src/db.js", () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

const { stripeWebhookRouter } = await import("../../src/billing/stripeWebhook.js");

function createTestApp() {
  const app = express();
  app.use("/api/billing", stripeWebhookRouter);
  return app;
}

describe("POST /api/billing/stripe-webhook (issue #764)", () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    mockConstructEvent.mockReset();
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  describe("Signature Verification", () => {
    it("returns 400 with 'Invalid signature' when signature verification fails", async () => {
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

    it("returns 400 when signature header is missing", async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error("No signature provided");
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .send('{"test": "data"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid signature" });
    });

    it("returns 400 when request body is invalid JSON", async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error("Invalid JSON payload");
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "some_signature")
        .send('not valid json')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid signature" });
    });

    it("accepts valid signature and returns 200", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_valid_123",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            metadata: { api_key_id: "key_123" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "pro" },
                    },
                  },
                },
              ],
            },
          },
        },
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

  describe("Event Type Handling", () => {
    it("handles customer.subscription.updated event and updates tier", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_updated_123",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_123",
            metadata: { api_key_id: "key_123" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "pro" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE api_keys SET tier = $1"),
        ["pro", "key_123"]
      );
    });

    it("handles customer.subscription.deleted event and downgrades to free tier", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_deleted_123",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_deleted",
            metadata: { api_key_id: "key_456" },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE api_keys SET tier = 'free'"),
        ["key_456"]
      );
    });

    it("silently ignores unhandled event types", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_unknown_123",
        type: "customer.invoice.created",
        data: { object: {} },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("received", true);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe("Metadata Validation", () => {
    it("skips subscription.updated if api_key_id is missing in metadata", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_no_key_id",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_456",
            metadata: {},
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "enterprise" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("skips subscription.updated if tier cannot be determined from product metadata", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_no_tier",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_789",
            metadata: { api_key_id: "key_789" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: {},
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it("skips subscription.deleted if api_key_id is missing in metadata", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_del_no_key",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_deleted_2",
            metadata: {},
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  describe("Idempotency", () => {
    it("demonstrates current lack of idempotency: duplicate webhook delivery applies state change twice", async () => {
      const eventId = "evt_idempotency_test_123";
      const apiKeyId = "key_idem_test";

      mockConstructEvent.mockReturnValue({
        id: eventId,
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_idem_test",
            metadata: { api_key_id: apiKeyId },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "pro" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      // First delivery
      const res1 = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res1.status).toBe(200);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);

      // Second delivery (same event ID, Stripe retry scenario)
      const res2 = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res2.status).toBe(200);
      // BUG: This demonstrates the current idempotency gap.
      // In a production system, the same event ID should only be processed once.
      // Currently, mockPoolQuery is called twice (once per delivery),
      // showing that the update is applied twice for the same event.
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      expect(mockPoolQuery).toHaveBeenNthCalledWith(1,
        expect.stringContaining("UPDATE api_keys SET tier = $1"),
        ["pro", apiKeyId]
      );
      expect(mockPoolQuery).toHaveBeenNthCalledWith(2,
        expect.stringContaining("UPDATE api_keys SET tier = $1"),
        ["pro", apiKeyId]
      );
    });
  });

  describe("Tier Extraction Logic", () => {
    it("extracts tier from subscription-level metadata first", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_sub_tier",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_with_sub_tier",
            metadata: { api_key_id: "key_sub_tier", tier: "enterprise" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "pro" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE api_keys SET tier = $1"),
        ["enterprise", "key_sub_tier"]
      );
    });

    it("falls back to product metadata if subscription-level tier is missing", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_product_tier",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_product_tier",
            metadata: { api_key_id: "key_product_tier" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "pro" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE api_keys SET tier = $1"),
        ["pro", "key_product_tier"]
      );
    });

    it("only accepts valid tier values (free, pro, enterprise)", async () => {
      mockConstructEvent.mockReturnValue({
        id: "evt_invalid_tier",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_invalid_tier",
            metadata: { api_key_id: "key_invalid_tier" },
            items: {
              data: [
                {
                  price: {
                    product: {
                      metadata: { tier: "invalid_tier_value" },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const res = await request(app)
        .post("/api/billing/stripe-webhook")
        .set("stripe-signature", "valid_signature")
        .send('{"data": "webhook"}')
        .set("Content-Type", "application/json");

      expect(res.status).toBe(200);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });
});
