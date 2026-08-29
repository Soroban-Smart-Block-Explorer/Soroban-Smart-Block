import { logger } from "./logger.js";
export async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = isRetryableError(err);
      if (!isRetryable || attempt === maxAttempts) throw err;
      const delay = Math.pow(2, attempt) * baseDelayMs;
      logger.warn(`[rpc-retry] attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function isRetryableError(err) {
  if (!err) return false;
  const status = err?.response?.status ?? err?.status ?? err?.statusCode;
  // 429 Too Many Requests, 503 Service Unavailable (RPC blackout), 502/504 gateway errors
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  if (err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || err?.code === "ECONNREFUSED") return true;
  if (err?.message && /timeout|rate\s*limit|too\s*many\s*requests|service\s*unavailable|ECONNREFUSED/i.test(err.message)) return true;
  return false;
}
