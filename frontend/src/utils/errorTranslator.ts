/**
 * Error Code to Human-Friendly Message Mapper
 * Human-Friendly Error State Explainer UI
 */

const ERROR_DICTIONARY: Record<string, string> = {
  "102": "Execution Failed: Out of Gas",
  "103": "Execution Failed: Unauthorized Access",
  "104": "Execution Failed: Invalid Input",
  "105": "Execution Failed: Contract Not Found",
  "106": "Execution Failed: Invalid Ledger",
  "107": "Execution Failed: Resource Limit Exceeded",
  "108": "Execution Failed: Assertion Failed",
  "109": "Execution Failed: Runtime Panic",
  "110": "Execution Failed: Invalid Operation",
  // protocol-level block compute exhaustion
  tx_resource_limit_exceeded: "Transaction Dropped: Block Compute Capacity Maxed Out",
};

export interface ParsedError {
  code: string;
  category: string;
  message: string;
  raw: string;
}

export function translateError(error: string): ParsedError {
  // check for protocol-level resource limit result code first
  if (
    error === "tx_resource_limit_exceeded" ||
    error === "txResourceLimitExceeded" ||
    error === "RESOURCE_LIMIT_EXCEEDED"
  ) {
    return {
      code: "tx_resource_limit_exceeded",
      category: "protocol",
      message: "Transaction Dropped: Block Compute Capacity Maxed Out",
      raw: error,
    };
  }

  // Try to extract error code
  const codeMatch = error.match(/Error\((\w+),\s*(\d+)\)/);

  if (codeMatch) {
    const [, category, code] = codeMatch;
    const message = ERROR_DICTIONARY[code] || `Execution Failed: Unknown Error (${code})`;
    return { code, category, message, raw: error };
  }

  return {
    code: "unknown",
    category: "unknown",
    message: error || "An unknown error occurred",
    raw: error,
  };
}

export function getErrorSeverity(code: string): "critical" | "warning" | "info" {
  const criticalCodes = ["102", "105", "107"];
  const warningCodes = ["103", "104", "108", "109"];

  if (criticalCodes.includes(code)) return "critical";
  if (warningCodes.includes(code)) return "warning";
  return "info";
}
