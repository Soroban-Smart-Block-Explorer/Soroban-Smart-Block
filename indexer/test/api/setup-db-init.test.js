import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Issue #417: Audit POST /api/setup/db-init.
//
// seed-lib.js generated fake Stellar addresses and was wired into the
// /api/setup/db-init handler. It was deleted during cleanup, and this handler
// must stay intentionally minimal: it should call db.init() and nothing else —
// no static import of seed-lib, and no dynamic `await import("./seed-lib.js")`.
//
// This is a static-source assertion (no DB/RPC required) so the invariant is
// guarded on every test run.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSource = fs.readFileSync(path.resolve(__dirname, "../../src/api.js"), "utf8");

// Extract the db-init handler body: from the route registration up to its
// closing `});`.
function extractDbInitHandler(source) {
  const start = source.indexOf('app.post("/api/setup/db-init"');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe("POST /api/setup/db-init (issue #417)", () => {
  it("does not reference seed-lib anywhere in api.js", () => {
    expect(apiSource).not.toMatch(/seed-lib/);
    expect(apiSource).not.toMatch(/seedLib/);
  });

  it("has no dynamic import of seed-lib", () => {
    // Catches `await import('./seed-lib.js')` / `import("../seed-lib")` etc.
    expect(apiSource).not.toMatch(/import\(\s*['"][^'"]*seed-lib/);
  });

  it("handler calls db.init() and only db.init()", () => {
    const handler = extractDbInitHandler(apiSource);
    expect(handler).toMatch(/db\.init\(\)/);
    // No seeding helpers slipped into the handler body.
    expect(handler).not.toMatch(/seed/i);
    // The only awaited call in the handler is db.init().
    const awaits = handler.match(/await\s+([\w.]+)\s*\(/g) || [];
    expect(awaits).toEqual(["await db.init("]);
  });
});
