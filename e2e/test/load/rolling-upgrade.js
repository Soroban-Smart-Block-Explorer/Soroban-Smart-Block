import http from "k6/http";
import { check } from "k6";

/**
 * Constant load held across a Helm rolling upgrade in the kind CI job (#935).
 * Any failed request fails the job: the upgrade must be zero-downtime.
 */
export const options = {
  vus: 20,
  duration: __ENV.DURATION || "3m",
  thresholds: {
    http_req_failed: ["rate==0"],
  },
};

const BASE_URL = __ENV.INDEXER_URL || "http://localhost:3001";

export default function () {
  const res = http.get(`${BASE_URL}/health/live`);
  check(res, { "status 200": (r) => r.status === 200 });
}
