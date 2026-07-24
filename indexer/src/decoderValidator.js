import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "./decodedEvent.schema.json" with { type: "json" };
import { decoderSchemaViolationsTotal } from "./metrics.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// eslint-disable-next-line no-control-regex -- intentionally strips control characters
const INVALID_HTML_OR_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const HTML_TAGS = /<[^>]*>/g;

export function sanitizeDecodedText(value) {
  if (value == null) return "";
  let sanitized = String(value);
  sanitized = sanitized.replace(HTML_TAGS, "");
  sanitized = sanitized.replace(INVALID_HTML_OR_CONTROL, "");
  if (sanitized.length > 2048) sanitized = sanitized.slice(0, 2048);
  if (sanitized.trim().length === 0) sanitized = "<invalid decoded text>";
  return sanitized;
}

export function validateDecodedEvent(decoded) {
  const valid = validate(decoded);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map((err) => ({
    message: err.message,
    instancePath: err.instancePath,
    schemaPath: err.schemaPath,
    params: err.params,
  }));

  const labels = new Set();
  for (const err of errors) {
    const field = err.instancePath.replace(/\//g, "_").replace(/^_/, "") || "root";
    labels.add(field || "root");
  }
  const label = [...labels].join(",");
  decoderSchemaViolationsTotal.inc({ field: label });

  return { valid: false, errors };
}

/**
 * Validate and sanitize a decoded event before database insertion.
 * On validation failure, sanitizes the description, sets decoded=false,
 * and logs structured error information.
 *
 * @param {object} decoded - The decoded event object from decoder
 * @param {object} logger - Logger instance (optional, falls back to console)
 * @returns {object} The validated/sanitized decoded object with a decoded flag
 */
export function validateAndSanitizeDecodedEvent(decoded, logger = console) {
  // Always sanitize the description field to prevent corruption
  if (decoded.description) {
    decoded.description = sanitizeDecodedText(decoded.description);
  }

  const validation = validateDecodedEvent(decoded);
  
  if (!validation.valid) {
    // On validation failure: log structured error and mark as unverified
    const errorSummary = validation.errors
      .map(e => `${e.instancePath || "root"}: ${e.message}`)
      .join("; ");
    
    // Structured logging: object serialized as JSON for log aggregation
    const errorLog = {
      component: "decoderValidator",
      event: "schema_validation_failed",
      contract_id: decoded.contract_id,
      tx_hash: decoded.tx_hash,
      function: decoded.function,
      ledger: decoded.ledger,
      error_count: validation.errors.length,
      errors: validation.errors.map(e => ({
        path: e.instancePath || "root",
        message: e.message,
        schema_path: e.schemaPath,
        params: e.params,
      })),
      decoded_text_sample: decoded.description ? decoded.description.slice(0, 100) : null,
    };
    
    logger.error(
      `[DecoderValidator] Decoded event schema validation failed: ${errorSummary}`,
      JSON.stringify(errorLog, null, 2)
    );

    // Mark as unverified but still store with sanitized description
    decoded.decoded = false;
  } else {
    decoded.decoded = true;
  }

  return decoded;
}
