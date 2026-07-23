import request from "supertest";

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/soroban_test";
process.env.DATABASE_URL = DB_URL;

const { db } = await import("../../src/db.js");
const { startApi } = await import("../../src/api.js");
const {
  ALERT_CONDITIONS,
  fireAlert,
  getActiveAlerts,
  resolveAlert,
} = await import("../../src/alertManager.js");

describe("alert observability API (issue #493)", () => {
  let server;
  let originalAdminSecret;
  let originalFetch;

  function resetAlerts() {
    for (const condition of Object.values(ALERT_CONDITIONS)) {
      resolveAlert(condition);
    }
  }

  beforeAll(() => {
    originalAdminSecret = process.env.ADMIN_SECRET;
    originalFetch = global.fetch;
    process.env.ADMIN_SECRET = "alerts-test-admin-secret";
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    server = startApi();
  });

  afterEach(() => {
    resetAlerts();
  });

  afterAll(async () => {
    resetAlerts();
    global.fetch = originalFetch;

    if (originalAdminSecret === undefined) {
      delete process.env.ADMIN_SECRET;
    } else {
      process.env.ADMIN_SECRET = originalAdminSecret;
    }

    if (server?.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns the all-clear response when no alerts are active", async () => {
    const response = await request(server).get("/api/alerts");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: [], count: 0 });
  });

  it("returns active alerts with stable timestamps and durations", async () => {
    await fireAlert(ALERT_CONDITIONS.LEDGER_GAP, "test ledger gap");

    const response = await request(server).get("/api/alerts");

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.active).toHaveLength(1);
    expect(response.body.active[0]).toMatchObject({
      condition: ALERT_CONDITIONS.LEDGER_GAP,
    });
    expect(new Date(response.body.active[0].firedAt).toISOString()).toBe(
      response.body.active[0].firedAt,
    );
    expect(response.body.active[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes an alert summary in the API health alias", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockResolvedValue({ rows: [{ health_check: 1 }] });
    await fireAlert(ALERT_CONDITIONS.ALL_RPC_DOWN, "all RPC nodes unavailable");

    try {
      const response = await request(server).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body.alerts).toEqual({
        active_count: 1,
        conditions: [ALERT_CONDITIONS.ALL_RPC_DOWN],
      });
    } finally {
      db.query = originalQuery;
    }
  });

  it("requires admin authentication to resolve an alert", async () => {
    await fireAlert(ALERT_CONDITIONS.DB_FAILURE, "database unavailable");

    const response = await request(server).post(
      `/api/admin/alerts/${ALERT_CONDITIONS.DB_FAILURE}/resolve`,
    );

    expect(response.status).toBe(401);
    expect(getActiveAlerts()).toHaveLength(1);
  });

  it("resolves an active alert through the authenticated admin route", async () => {
    await fireAlert(ALERT_CONDITIONS.DLQ_THRESHOLD, "DLQ capacity exceeded");

    const response = await request(server)
      .post(`/api/admin/alerts/${ALERT_CONDITIONS.DLQ_THRESHOLD}/resolve`)
      .set("Authorization", "Bearer alerts-test-admin-secret");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      condition: ALERT_CONDITIONS.DLQ_THRESHOLD,
      resolved: true,
    });
    expect(getActiveAlerts()).toEqual([]);
  });
});
