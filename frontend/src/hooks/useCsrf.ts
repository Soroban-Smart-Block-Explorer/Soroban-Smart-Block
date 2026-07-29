/**
 * useCsrf — CSRF token bootstrap hook
 *
 * Fetches a CSRF token from GET /api/csrf-token on first call and stores it in
 * a module-level singleton so every part of the app shares the same token.
 *
 * Usage:
 *   1. Call `initCsrf()` once at application startup (e.g. in main.tsx).
 *   2. Call `getCsrfToken()` anywhere you need the header value — it returns
 *      the cached token synchronously after init completes.
 *
 * The server sets an HttpOnly "csrf-token" cookie and returns the same value in
 * the response body.  The frontend stores the body value and sends it back as
 * the X-CSRF-Token header on every POST / PATCH / DELETE request.
 *
 * Token lifecycle:
 *   • Refreshed automatically if the server returns 403 with error "CSRF token
 *     missing" or "CSRF token mismatch" (handled by mutationFetch in api.ts).
 *   • Falls back silently to an empty string when the server is unreachable
 *     so that API-key-only flows (e.g. CI / testing) are not broken.
 */

const BASE = "/api";

// Module-level singleton — shared across the entire React application.
let _csrfToken = "";
let _initPromise: Promise<void> | null = null;

/**
 * Fetch the CSRF token from the server and cache it.
 * Safe to call multiple times — only issues one network request per session.
 *
 * @returns {Promise<void>}
 */
export async function initCsrf(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/csrf-token`, {
        method: "GET",
        credentials: "include", // send + receive cookies
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.csrfToken === "string" && data.csrfToken.length > 0) {
          _csrfToken = data.csrfToken;
        }
      }
    } catch {
      // Server unreachable — leave token empty; API-key paths will still work.
    }
  })();

  return _initPromise;
}

/**
 * Return the cached CSRF token string.
 * Returns an empty string before `initCsrf()` has resolved.
 *
 * @returns {string}
 */
export function getCsrfToken(): string {
  return _csrfToken;
}

/**
 * Force-refresh the CSRF token (e.g. after a 403 CSRF mismatch).
 * Clears the cached promise so the next call re-fetches from the server.
 *
 * @returns {Promise<void>}
 */
export async function refreshCsrfToken(): Promise<void> {
  _initPromise = null;
  _csrfToken = "";
  return initCsrf();
}
