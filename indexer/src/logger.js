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

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// Accepts either the structured form `(obj, msg?)` or a variadic console-like
// form `(...parts)` so former `console.log/warn/error/debug` call sites can
// route straight through the structured logger without rewriting their args.
function makeLevelFn(levelName, ctx) {
  return (...args) => {
    let obj;
    let msg;
    if (args.length === 1 && typeof args[0] !== "string") {
      obj = args[0];
    } else if (typeof args[0] === "object" && args[0] !== null && !(args[0] instanceof Error)) {
      obj = args[0];
      msg = args.slice(1).map(formatArg).join(" ");
    } else {
      obj = {};
      msg = args.map(formatArg).join(" ");
    }
    write(levelName, { ...ctx, ...obj }, msg);
  };
}

function makeLogger(ctx = {}) {
  return {
    debug: makeLevelFn("debug", ctx),
    info: makeLevelFn("info", ctx),
    warn: makeLevelFn("warn", ctx),
    error: makeLevelFn("error", ctx),
    child: (extra) => makeLogger({ ...ctx, ...extra }),
  };
}

export const logger = makeLogger();

export function createCorrelatedLogger() {
  return logger.child({ correlationId: randomUUID() });
}
