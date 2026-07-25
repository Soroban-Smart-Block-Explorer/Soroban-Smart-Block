/**
 * wasmBuildMetadata.js
 *
 * Parses WASM custom sections to extract reproducible-build metadata:
 *   - contractenvmetav0  → Soroban SDK / environment version
 *   - build_metadata     → compiler version, optimizer, repo URL (Stellar-standard)
 *   - producers          → LLVM / Rust toolchain info (WebAssembly producers section)
 *
 * Also computes the SHA-256 hash of the raw WASM bytes for fingerprinting.
 */

import { createHash } from "crypto";

const WASM_MAGIC = 0x0061736d;

/** Read an unsigned LEB-128 integer from buf at offset. */
function readLEB128(buf, offset) {
  let result = 0,
    shift = 0,
    byte;
  do {
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

/**
 * Iterate over every custom section (id=0) in a WASM binary.
 * Yields { name: string, payload: Buffer } for each one found.
 */
function* customSections(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== WASM_MAGIC) return;

  let pos = 8; // skip magic (4) + version (4)
  while (pos < buf.length) {
    const sectionId = buf[pos++];
    const { value: sectionSize, offset: afterSize } = readLEB128(buf, pos);
    pos = afterSize;
    const sectionEnd = pos + sectionSize;

    if (sectionId === 0 && pos < sectionEnd) {
      const { value: nameLen, offset: nameStart } = readLEB128(buf, pos);
      const nameEnd = nameStart + nameLen;
      const name = buf.toString("utf8", nameStart, nameEnd);
      const payload = buf.slice(nameEnd, sectionEnd);
      yield { name, payload };
    }

    pos = sectionEnd;
  }
}

/**
 * Parse the `build_metadata` custom section used by Stellar/Soroban tooling.
 * The section is a sequence of null-terminated key=value pairs.
 * Known keys: compiler, optimizer, repository, commit
 */
function parseBuildMetadataSection(payload) {
  const text = payload.toString("utf8");
  const result = {};
  // Split on null bytes or newlines; each entry is "key=value"
  for (const entry of text.split(/[\0\n]+/)) {
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const key = entry.slice(0, eq).trim();
      const val = entry.slice(eq + 1).trim();
      if (key && val) result[key] = val;
    }
  }
  return result;
}

/**
 * Parse the WebAssembly `producers` custom section.
 * Format: field-count { field-name value-count { name version }* }*
 * Returns a flat object like { language: "Rust 1.78.0", "processed-by": "rustc 1.78.0" }
 */
function parseProducersSection(payload) {
  const result = {};
  try {
    let pos = 0;
    const { value: fieldCount, offset: o0 } = readLEB128(payload, pos);
    pos = o0;
    for (let i = 0; i < fieldCount; i++) {
      const { value: fnLen, offset: o1 } = readLEB128(payload, pos);
      pos = o1;
      const fieldName = payload.toString("utf8", pos, pos + fnLen);
      pos += fnLen;

      const { value: valCount, offset: o2 } = readLEB128(payload, pos);
      pos = o2;
      const parts = [];
      for (let j = 0; j < valCount; j++) {
        const { value: nLen, offset: o3 } = readLEB128(payload, pos);
        pos = o3;
        const name = payload.toString("utf8", pos, pos + nLen);
        pos += nLen;
        const { value: vLen, offset: o4 } = readLEB128(payload, pos);
        pos = o4;
        const version = payload.toString("utf8", pos, pos + vLen);
        pos += vLen;
        parts.push(version ? `${name} ${version}` : name);
      }
      result[fieldName] = parts.join(", ");
    }
  } catch {
    // malformed section — return whatever we parsed so far
  }
  return result;
}

/**
 * Parse the `contractenvmetav0` section (3 bytes: major, minor, patch).
 */
function parseEnvMetaSection(payload) {
  if (payload.length < 3) return null;
  return {
    major: payload[0],
    minor: payload[1],
    patch: payload[2],
  };
}

/**
 * Extract all build metadata from a WASM binary buffer.
 *
 * @param {Buffer|Uint8Array} wasm
 * @returns {{
 *   wasm_hash: string,           // SHA-256 hex of the raw bytes
 *   size_bytes: number,          // raw WASM binary size in bytes
 *   sdk_version: string|null,    // e.g. "v21.1.0" from contractenvmetav0
 *   compiler: string|null,       // e.g. "rustc 1.78.0"
 *   optimizer: string|null,      // e.g. "wasm-opt 116"
 *   repository: string|null,     // repo URL if embedded
 *   commit: string|null,         // git commit hash if embedded
 *   producers: object,           // raw producers section fields
 * }}
 */
export function extractBuildMetadata(wasm) {
  const buf = Buffer.isBuffer(wasm) ? wasm : Buffer.from(wasm);

  const meta = {
    wasm_hash: createHash("sha256").update(buf).digest("hex"),
    size_bytes: buf.length,
    sdk_version: null,
    compiler: null,
    optimizer: null,
    repository: null,
    commit: null,
    producers: {},
  };

  for (const { name, payload } of customSections(buf)) {
    if (name === "contractenvmetav0") {
      const v = parseEnvMetaSection(payload);
      if (v) meta.sdk_version = `v${v.major}.${v.minor}.${v.patch}`;
    } else if (name === "build_metadata") {
      const bm = parseBuildMetadataSection(payload);
      if (bm.compiler) meta.compiler = bm.compiler;
      if (bm.optimizer) meta.optimizer = bm.optimizer;
      if (bm.repository) meta.repository = bm.repository;
      if (bm.commit) meta.commit = bm.commit;
    } else if (name === "producers") {
      meta.producers = parseProducersSection(payload);
      // Populate compiler from producers if not already set by build_metadata
      if (!meta.compiler && meta.producers["processed-by"]) {
        meta.compiler = meta.producers["processed-by"];
      }
    }
  }

  return meta;
}
