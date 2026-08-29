import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// Carries the current request's correlation ID across async/await boundaries
// so every logger.* call made while handling a request — including ones deep
// in modules that never see `req` — picks it up automatically (#756).
export const requestContext = new AsyncLocalStorage();

function write(levelName, obj, msg) {
  if ((LEVELS[levelName] ?? 0) < currentLevel) return;
  const ctx = requestContext.getStore();
  const entry = {
    level: levelName,
    time: new Date().toISOString(),
    service: "indexer",
    pid: process.pid,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(typeof obj === "string" ? { msg: obj } : obj),
    ...(msg !== undefined ? { msg } : {}),
  };
  const line = JSON.stringify(entry);
  if (levelName === "error" || levelName === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function makeLogger(ctx = {}) {
  return {
    debug: (obj, msg) => write("debug", { ...ctx, ...(typeof obj === "string" ? { msg: obj } : obj) }, msg),
    info:  (obj, msg) => write("info",  { ...ctx, ...(typeof obj === "string" ? { msg: obj } : obj) }, msg),
    warn:  (obj, msg) => write("warn",  { ...ctx, ...(typeof obj === "string" ? { msg: obj } : obj) }, msg),
    error: (obj, msg) => write("error", { ...ctx, ...(typeof obj === "string" ? { msg: obj } : obj) }, msg),
    child: (extra) => makeLogger({ ...ctx, ...extra }),
  };
}

export const logger = makeLogger();

export function createCorrelatedLogger() {
  return logger.child({ correlationId: randomUUID() });
}
