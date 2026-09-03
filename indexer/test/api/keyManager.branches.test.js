/**
 * keyManager branch coverage (issue #765): rotation grace-period boundaries
 * and revocation. Mocks the DB pool so no live PostgreSQL is required.
 */
import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => ({
  query: mockClientQuery,
  release: mockRelease,
}));

jest.unstable_mockModule("../../src/db.js", () => ({
  pool: {
    query: mockQuery,
    connect: mockConnect,
  },
}));

const { rotateKey, deleteKey } = await import("../../src/admin/keyManager.js");

const EXISTING_KEY = {
  name: "test-key",
  email: null,
  tier: "free",
  rate_limit: 10,
  daily_limit: 100,
  allowed_ips: null,
  allowed_endpoints: null,
  expires_at: null,
  verified: false,
};

describe("keyManager rotation grace period", () => {
  let originalGraceMinutes;

  beforeAll(() => {
    originalGraceMinutes = process.env.KEY_ROTATION_GRACE_MINUTES;
  });

  afterEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    if (originalGraceMinutes === undefined) {
      delete process.env.KEY_ROTATION_GRACE_MINUTES;
    } else {
      process.env.KEY_ROTATION_GRACE_MINUTES = originalGraceMinutes;
    }
  });

  it("throws when rotating a key that does not exist", async () => {
    mockClientQuery.mockImplementation(async (sql) => {
      if (sql.startsWith("BEGIN")) return {};
      if (sql.includes("SELECT name")) return { rows: [] };
      if (sql.startsWith("ROLLBACK")) return {};
      return { rows: [] };
    });

    await expect(rotateKey("missing-id")).rejects.toThrow("API key not found: missing-id");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("computes an immediate rotation_grace_until when grace minutes is 0", async () => {
    process.env.KEY_ROTATION_GRACE_MINUTES = "0";
    const before = Date.now();
    let capturedGraceUntil;

    mockClientQuery.mockImplementation(async (sql, params) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) return {};
      if (sql.includes("SELECT name")) return { rows: [EXISTING_KEY] };
      if (sql.includes("INSERT INTO api_keys")) {
        return { rows: [{ id: "new-id", ...EXISTING_KEY, revoked: false }] };
      }
      if (sql.includes("SET revoked = TRUE") && sql.includes("rotation_grace_until")) {
        capturedGraceUntil = params[0];
        return {};
      }
      return { rows: [] };
    });

    await rotateKey("old-id");

    expect(capturedGraceUntil).toBeDefined();
    const graceMs = new Date(capturedGraceUntil).getTime() - before;
    expect(graceMs).toBeGreaterThanOrEqual(0);
    expect(graceMs).toBeLessThan(5000);
  });

  it("computes a future rotation_grace_until using KEY_ROTATION_GRACE_MINUTES", async () => {
    process.env.KEY_ROTATION_GRACE_MINUTES = "60";
    const before = Date.now();
    let capturedGraceUntil;

    mockClientQuery.mockImplementation(async (sql, params) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) return {};
      if (sql.includes("SELECT name")) return { rows: [EXISTING_KEY] };
      if (sql.includes("INSERT INTO api_keys")) {
        return { rows: [{ id: "new-id", ...EXISTING_KEY, revoked: false }] };
      }
      if (sql.includes("SET revoked = TRUE") && sql.includes("rotation_grace_until")) {
        capturedGraceUntil = params[0];
        return {};
      }
      return { rows: [] };
    });

    await rotateKey("old-id");

    const graceMs = new Date(capturedGraceUntil).getTime() - before;
    expect(graceMs).toBeGreaterThan(59 * 60_000);
    expect(graceMs).toBeLessThanOrEqual(60 * 60_000 + 5000);
  });

  it("rolls back and rethrows when the insert fails mid-transaction", async () => {
    mockClientQuery.mockImplementation(async (sql) => {
      if (sql.startsWith("BEGIN")) return {};
      if (sql.includes("SELECT name")) return { rows: [EXISTING_KEY] };
      if (sql.includes("INSERT INTO api_keys")) throw new Error("insert failed");
      if (sql.startsWith("ROLLBACK")) return {};
      return { rows: [] };
    });

    await expect(rotateKey("old-id")).rejects.toThrow("insert failed");
    expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe("keyManager revocation", () => {
  afterEach(() => {
    mockQuery.mockReset();
  });

  it("throws when deleting a key that does not exist", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(deleteKey("missing-id")).rejects.toThrow("API key not found: missing-id");
  });

  it("sets revoked = true and returns the record without key_hash", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: "key-1", key_hash: "should-not-leak", revoked: true }],
    });

    const result = await deleteKey("key-1");

    expect(mockQuery.mock.calls[0][0]).toContain("SET revoked = TRUE");
    expect(result).toEqual({ id: "key-1", revoked: true });
    expect(result.key_hash).toBeUndefined();
  });
});
