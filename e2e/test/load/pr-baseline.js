import http from "k6/http";
import { check, group } from "k6";

/**
 * Lightweight k6 baseline load test for PR CI gating (issue #768).
 * Short duration / low VU count so it fits inside a PR check instead of
 * only running nightly. Same latency thresholds as the full baseline test;
 * k6 exits non-zero when a threshold is violated, which fails the CI job.
 */
export const options = {
  vus: 10,
  duration: "30s",

  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<2000"],
    http_req_failed: ["rate<0.1"],
  },
};

const BASE_URL = __ENV.INDEXER_URL || "http://localhost:3001";

export default function () {
  group("Contracts API", () => {
    const listRes = http.get(`${BASE_URL}/api/contracts?page=1&limit=10`);
    check(listRes, {
      "list status is 200": (r) => r.status === 200,
      "list response time < 500ms": (r) => r.timings.duration < 500,
    });
  });

  group("Events API", () => {
    const eventsRes = http.get(`${BASE_URL}/api/events?limit=10`);
    check(eventsRes, {
      "events status is 200": (r) => r.status === 200,
      "events response time < 500ms": (r) => r.timings.duration < 500,
    });
  });
}
