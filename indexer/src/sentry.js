import * as Sentry from "@sentry/node";

/**
 * Initializes Sentry error tracking when SENTRY_DSN is set (#757), and wires
 * up handlers so uncaught exceptions and unhandled rejections surface in the
 * dashboard instead of only being log-grepped.
 * No-op when the DSN is left blank (e.g. local dev).
 */
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });

  process.on("uncaughtException", (err) => {
    Sentry.captureException(err);
  });
  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
}

export { Sentry };
