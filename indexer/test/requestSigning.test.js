import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifySignedRequest, signRequest, SIGNING_HEADERS } from "../src/auth/requestSigning.js";

const SKEW = 300;
const NOW = 1_800_000_000;

function makeStore(secrets = { k1: ["secret-new"] }) {
  const seen = new Set();
  return {
    getSecrets: async (keyId) => secrets[keyId] ?? [],
    claimNonce: async (keyId, nonce) => {
      const k = `${keyId}:${nonce}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  };
}

function signed({ secret = "secret-new", body = '{"name":"x"}', ts = NOW, nonce = "nonce-0123456789abcdef" } = {}) {
  const req = { method: "POST", path: "/api/contracts", body, timestamp: String(ts), nonce };
  return {
    method: req.method,
    path: req.path,
    rawBody: Buffer.from(body),
    headers: {
      [SIGNING_HEADERS.keyId]: "k1",
      [SIGNING_HEADERS.timestamp]: String(ts),
      [SIGNING_HEADERS.nonce]: nonce,
      [SIGNING_HEADERS.signature]: signRequest(secret, req),
    },
  };
}

const verify = (req, store) => verifySignedRequest({ ...req, nowSec: NOW, skewSec: SKEW, ...store });

describe("request signing (#852)", () => {
  it("accepts a correctly signed request and rejects its replay with 409 nonce_reused", async () => {
    const store = makeStore();
    const req = signed();
    assert.equal((await verify(req, store)).ok, true);
    const replay = await verify(req, store);
    assert.equal(replay.status, 409);
    assert.equal(replay.error, "nonce_reused");
  });

  it("rejects a body tampered by one byte", async () => {
    const req = signed();
    req.rawBody = Buffer.from('{"name":"y"}');
    const r = await verify(req, makeStore());
    assert.equal(r.status, 401);
    assert.equal(r.error, "invalid_signature");
  });

  it("rejects a 6-minute-old request with 401 stale_timestamp and echoes server_time", async () => {
    const r = await verify(signed({ ts: NOW - 360 }), makeStore());
    assert.equal(r.status, 401);
    assert.equal(r.error, "stale_timestamp");
    assert.equal(r.server_time, NOW);
  });

  it("accepts a request exactly at the skew boundary", async () => {
    assert.equal((await verify(signed({ ts: NOW - SKEW }), makeStore())).ok, true);
  });

  it("verifies with either secret during a rotation overlap", async () => {
    const store = makeStore({ k1: ["secret-new", "secret-old"] });
    assert.equal((await verify(signed({ secret: "secret-old", nonce: "nonce-old-0123456789" }), store)).ok, true);
    assert.equal((await verify(signed({ secret: "secret-new", nonce: "nonce-new-0123456789" }), store)).ok, true);
    assert.equal((await verify(signed({ secret: "revoked", nonce: "nonce-rev-0123456789" }), store)).ok, false);
  });

  it("lets exactly one of two concurrent same-nonce requests through", async () => {
    const store = makeStore();
    const results = await Promise.all([verify(signed(), store), verify(signed(), store)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  it("reports missing headers as signature_missing", async () => {
    const r = await verify({ method: "POST", path: "/api/contracts", rawBody: Buffer.from(""), headers: {} }, makeStore());
    assert.equal(r.error, "signature_missing");
  });
});
