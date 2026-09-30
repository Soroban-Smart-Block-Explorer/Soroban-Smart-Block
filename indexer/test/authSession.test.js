import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import {
  evaluateSession,
  isElevated,
  getCookie,
  hashToken,
  startSession,
  rotateSession,
  loadSession,
  requireStepUp,
  IDLE_TIMEOUT_MS,
  SESSION_COOKIE,
} from "../src/auth/session.js";
import { hashRecoveryCode, generateRecoveryCodes } from "../src/auth/recovery.js";
import { verifyCsrf } from "../src/csrf.js";

// In-memory stand-ins for the auth_sessions DB methods (#933).
let sessions;
beforeEach(() => {
  sessions = new Map();
  db.insertAuthSession = async ({ idHash, accountId, authMethod, expiresAt, elevatedUntil }) => {
    sessions.set(idHash, {
      id_hash: idHash,
      account_id: accountId,
      auth_method: authMethod,
      expires_at: expiresAt,
      elevated_until: elevatedUntil,
      last_seen_at: new Date(),
      revoked_at: null,
    });
  };
  db.revokeAuthSession = async (idHash) => {
    const row = sessions.get(idHash);
    if (row) row.revoked_at = new Date();
  };
  db.getAuthSession = async (idHash) => sessions.get(idHash) ?? null;
  db.touchAuthSession = async () => {};
});

function mockRes() {
  return {
    cookies: {},
    cookie(name, value, opts) {
      this.cookies[name] = { value, opts };
    },
    clearCookie() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const now = Date.now();
const row = (over = {}) => ({
  revoked_at: null,
  expires_at: new Date(now + 3_600_000),
  last_seen_at: new Date(now),
  ...over,
});

describe("session expiry", () => {
  it("valid session", () => assert.equal(evaluateSession(row(), now), "valid"));
  it("missing", () => assert.equal(evaluateSession(null, now), "missing"));
  it("revoked", () => assert.equal(evaluateSession(row({ revoked_at: new Date() }), now), "revoked"));
  it("absolute timeout", () => assert.equal(evaluateSession(row({ expires_at: new Date(now - 1) }), now), "expired"));
  it("idle timeout", () =>
    assert.equal(evaluateSession(row({ last_seen_at: new Date(now - IDLE_TIMEOUT_MS - 1) }), now), "idle"));
  it("step-up window", () => {
    assert.equal(isElevated(row({ elevated_until: new Date(now + 1000) }), now), true);
    assert.equal(isElevated(row({ elevated_until: new Date(now - 1000) }), now), false);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, Secure and SameSite=Lax", async () => {
    const res = mockRes();
    await startSession({ headers: {} }, res, "acct", "passkey");
    const { opts } = res.cookies[SESSION_COOKIE];
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.secure, true);
    assert.equal(opts.sameSite, "lax");
  });
});

describe("session fixation", () => {
  it("sign-in never reuses an attacker-planted id and revokes the old one", async () => {
    const planted = "attacker-chosen-id";
    await db.insertAuthSession({ idHash: hashToken(planted), accountId: "attacker", authMethod: "email", expiresAt: new Date(now + 60_000) });
    const res = mockRes();
    const issued = await startSession({ headers: { cookie: `${SESSION_COOKIE}=${planted}` } }, res, "victim", "passkey");
    assert.notEqual(issued, planted);
    assert.ok(sessions.get(hashToken(planted)).revoked_at, "planted session revoked");
    assert.equal(sessions.get(hashToken(issued)).account_id, "victim");
  });

  it("rotates the id on privilege change (step-up)", async () => {
    const res = mockRes();
    const first = await startSession({ headers: {} }, res, "acct", "passkey");
    const req = { headers: { cookie: `${SESSION_COOKIE}=${first}` } };
    await loadSession(req, res, () => {});
    const second = await rotateSession(req, res, { elevated: true });
    assert.notEqual(first, second);
    assert.ok(sessions.get(hashToken(first)).revoked_at);
    assert.ok(isElevated(sessions.get(hashToken(second))));
  });

  it("an expired session cookie is not loaded", async () => {
    await db.insertAuthSession({ idHash: hashToken("old"), accountId: "a", authMethod: "passkey", expiresAt: new Date(now - 1) });
    const req = { headers: { cookie: `${SESSION_COOKIE}=old` } };
    await loadSession(req, mockRes(), () => {});
    assert.equal(req.session, undefined);
  });
});

describe("step-up", () => {
  it("rejects sensitive actions without a recent re-authentication", () => {
    const res = mockRes();
    let called = false;
    requireStepUp({ session: row() }, res, () => (called = true));
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.step_up, true);
  });
});

describe("CSRF", () => {
  it("a session cookie alone cannot make a state-changing request", () => {
    const res = mockRes();
    let called = false;
    verifyCsrf(
      { method: "POST", path: "/api/auth/recovery-codes", headers: { cookie: `${SESSION_COOKIE}=abc` } },
      res,
      () => (called = true),
    );
    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
  });
});

describe("recovery codes", () => {
  it("are unique and normalise case/dashes when hashed", () => {
    const codes = generateRecoveryCodes();
    assert.equal(new Set(codes).size, codes.length);
    assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase().replace("-", " ")));
  });
});

describe("cookie parsing", () => {
  it("reads a named cookie", () => assert.equal(getCookie({ headers: { cookie: "a=1; sid=xyz" } }, "sid"), "xyz"));
});
