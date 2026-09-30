import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreSubmission, urlRisk, reporterWeight } from "../src/moderation/riskScore.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/moderation-submissions.json", import.meta.url), "utf8"));

describe("moderation risk scoring fixtures (#934)", () => {
  for (const f of fixtures) {
    it(`${f.label} → ${f.expect}`, () => {
      const result = scoreSubmission(f.submission, f.ctx ?? {});
      assert.equal(result.status, f.expect, JSON.stringify(result.signals));
    });
  }
});

describe("urlRisk", () => {
  it("trusts known domains", () => {
    assert.equal(urlRisk("https://stellar.org/docs"), 0);
    assert.equal(urlRisk("https://developers.stellar.org"), 0);
  });
  it("flags punycode look-alikes", () => {
    assert.ok(urlRisk("https://xn--stellr-cta.org") >= 30);
  });
});

describe("reporterWeight", () => {
  it("defaults to 1 for new reporters", () => assert.equal(reporterWeight({}), 1));
  it("down-weights reporters whose reports were dismissed (brigades)", () => {
    assert.ok(reporterWeight({ upheld: 0, dismissed: 9 }) < 0.2);
  });
  it("caps trusted reporters", () => assert.equal(reporterWeight({ upheld: 50 }), 3));
});
