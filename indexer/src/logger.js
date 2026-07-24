import { randomUUID } from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function write(levelName, obj, msg) {
  if ((LEVELS[levelName] ?? 0) < currentLevel) return;
  const entry = {
    level: levelName,
    time: new Date().toISOString(),
    service: "indexer",
    pid: process.pid,
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
