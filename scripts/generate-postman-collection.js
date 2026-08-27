#!/usr/bin/env node
/**
 * Generates a Postman v2.1 collection from docs/api/openapi.yaml.
 *
 * The output is import-ready in both Postman and Insomnia (Insomnia natively
 * imports Postman v2.1 collections), and covers every endpoint documented in
 * the OpenAPI spec: method, URL, path/query params, headers, auth, and
 * request body shape.
 *
 * Usage:
 *   node scripts/generate-postman-collection.js [output-path]
 *
 * With no argument, writes to docs/api/postman_collection.json (the
 * committed file). CI passes a temp path and diffs it against the committed
 * copy to catch drift — see .github/workflows/ci.yml.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Converter from "openapi-to-postmanv2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const specPath = path.join(repoRoot, "docs/api/openapi.yaml");
const outputPath = path.resolve(
  repoRoot,
  process.argv[2] || "docs/api/postman_collection.json",
);

const spec = readFileSync(specPath, "utf8");

Converter.convert(
  { type: "string", data: spec },
  {
    folderStrategy: "Tags",
    includeAuthInfoInExample: false,
    // "Schema" resolves unfaked values to stable type placeholders (e.g.
    // "<string>") instead of "Example" mode's randomly faked realistic
    // values — see the determinism note in normalize() below.
    requestParametersResolution: "Schema",
    exampleParametersResolution: "Schema",
  },
  (err, result) => {
    if (err) {
      console.error(`[postman] conversion failed: ${err.message}`);
      process.exit(1);
    }
    if (!result.result) {
      console.error(`[postman] conversion failed: ${result.reason}`);
      process.exit(1);
    }

    const [collection] = result.output.map((o) => o.data);
    normalize(collection);
    writeFileSync(outputPath, `${JSON.stringify(collection, null, 2)}\n`);
    console.log(`[postman] wrote ${path.relative(repoRoot, outputPath)}`);
  },
);

// The converter's output is nondeterministic between runs of the *same*
// spec in two ways, which would make a "regenerate and diff" CI check
// permanently red for reasons unrelated to actual spec changes:
//
//  1. Every folder/item/response gets a random UUID `id` (and the collection
//     gets a random `_postman_id`) that isn't derived from the spec at all.
//     These aren't needed for import — Postman/Insomnia assign fresh ids on
//     import regardless.
//  2. Saved example responses have their bodies faked from the response
//     schema for any field without an explicit `example` in the spec (e.g.
//     picking a random enum member, or a random number). This uses an
//     internal, unseeded RNG the library doesn't expose a hook for, so the
//     fake values differ on every run even though they're not real
//     documentation content.
//  3. For free-form objects (`type: object` with no declared properties —
//     e.g. an arbitrary metadata bag), the faker invents a random number of
//     placeholder `key_0`, `key_1`, ... properties with randomly chosen
//     types. requestParametersResolution/exampleParametersResolution:
//     "Schema" (below) makes every *schema-defined* field a stable type
//     placeholder like "<string>", which eliminates this randomness
//     everywhere except this one free-form-object fallback.
//
// Stripping (1) and (2), and canonicalizing (3) to a single representative
// key, keeps the collection's actual value — every documented endpoint,
// fully specified as a request (method, URL, params, headers, auth, request
// body shape) — while making regeneration byte-for-byte stable so drift only
// shows up when the spec itself changes.
function normalize(node) {
  if (Array.isArray(node)) {
    node.forEach(normalize);
  } else if (node && typeof node === "object") {
    delete node.id;
    delete node._postman_id;
    delete node.response;
    if (node.mode === "raw" && typeof node.raw === "string") {
      node.raw = normalizeRawBody(node.raw);
    }
    for (const value of Object.values(node)) normalize(value);
  }
}

function normalizeRawBody(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // not JSON (or not an object) — leave as-is
  }
  return JSON.stringify(collapseFreeformMaps(parsed), null, 2);
}

function collapseFreeformMaps(value) {
  if (Array.isArray(value)) return value.map(collapseFreeformMaps);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const isFreeformMap =
      keys.length > 0 && keys.every((k, i) => k === `key_${i}`);
    if (isFreeformMap) return { key_0: "<string>" };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, collapseFreeformMaps(v)]),
    );
  }
  return value;
}
