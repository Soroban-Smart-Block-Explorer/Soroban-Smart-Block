/**
 * Guards self-service routes (webhooks, dashboard) that must be scoped to a
 * real, DB-issued API key — unlike most of the API, an unauthenticated
 * (hashed-IP) caller has no `api_keys.id` to own a webhook subscription or
 * key against, so `req.rateContext.keyId` must be present.
 */
export function requireAuthenticatedKey(req, res, next) {
  if (!req.rateContext?.keyId) {
    return res.status(401).json({ error: "A valid API key (x-api-key header) is required" });
  }
  next();
}
