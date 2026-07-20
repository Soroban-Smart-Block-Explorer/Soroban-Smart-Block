import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { createApi } from "../src/api.js";

describe("API request correlation and logging", () => {
  it("returns X-Request-Id and preserves traceparent while logging the same request id", async () => {
    const logChunks = [];
    const logStream = new PassThrough();
    logStream.on("data", (chunk) => logChunks.push(chunk.toString()));

    const app = createApi({
      logDestination: logStream,
      dbOverride: {
        async getEventsCursor() {
          return { data: [], next_cursor: null };
        },
      },
    });

    const requestId = randomUUID();
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const response = await request(app)
      .get("/api/events")
      .set("X-Request-Id", requestId)
      .set("traceparent", traceparent)
      .expect(200);

    assert.equal(response.headers["x-request-id"], requestId);
    assert.equal(response.headers["traceparent"], traceparent);

    await new Promise((resolve) => setImmediate(resolve));
    const logs = logChunks.join("");
    assert.ok(logs.includes(requestId), `Expected logs to contain request id ${requestId}`);
  });

  it("records a Prometheus histogram with method, route, and status labels", async () => {
    const app = createApi({
      logDestination: new PassThrough(),
      dbOverride: {
        async getEventsCursor() {
          return { data: [], next_cursor: null };
        },
      },
    });

    await request(app).get("/api/events").expect(200);

    const metricsResponse = await request(app).get("/metrics").expect(200);
    const metricsText = metricsResponse.text;
    assert.ok(
      metricsText.includes('api_request_duration_seconds_count{method="GET",route="/api/events",status="200"}'),
      "Expected histogram count metric with method, route, and status labels"
    );
  });
});
