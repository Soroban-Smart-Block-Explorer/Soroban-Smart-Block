/**
 * OpenTelemetry tracing setup (issue #755).
 *
 * Exports spans to any OTLP/HTTP collector (Jaeger, Tempo, Honeycomb, etc.)
 * configured via OTEL_EXPORTER_OTLP_ENDPOINT (defaults to a local collector
 * at http://localhost:4318). Import this module before anything else so the
 * tracer provider is registered before spans are created.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const OTEL_ENABLED = process.env.OTEL_TRACING_ENABLED !== "false";

if (OTEL_ENABLED) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  const exporter = new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "soroban-indexer",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
}

export const tracer = trace.getTracer("soroban-indexer");

/**
 * Run `fn` inside a new active span named `name`, recording exceptions and
 * always ending the span. Child spans created by `fn` (e.g. a DB query
 * inside an RPC handler) automatically nest under this span via the
 * AsyncHooksContextManager registered above.
 */
export async function withSpan(name, fn, attributes = {}) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
