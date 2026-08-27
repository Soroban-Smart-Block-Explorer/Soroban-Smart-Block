/**
 * Self-service developer dashboard routes, scoped to the authenticated API
 * key (req.rateContext.keyId), mounted at /api/dashboard.
 *
 * "My keys" is every api_keys row sharing the same `email` as the calling
 * key (email is set at self-service creation via POST /api/keys — migration
 * 010). A key with no email only ever manages itself. This is deliberately
 * separate from /api/admin/api-keys (admin.js), which is gated by the
 * ADMIN_SECRET bearer token and has no ownership scoping at all.
 *
 *   GET    /api/dashboard/me                      — current key's own record + usage
 *   GET    /api/dashboard/api-keys                — list keys owned by the same email
 *   POST   /api/dashboard/api-keys                 — create an additional key
 *   POST   /api/dashboard/api-keys/:id/rotate      — rotate one of my keys
 *   DELETE /api/dashboard/api-keys/:id             — revoke one of my keys
 *   GET    /api/dashboard/api-keys/:id/usage       — requests + events-received for one key
 */

import { Router } from "express";
import { db } from "../db.js";
import { requireAuthenticatedKey } from "../auth/requireAuthenticatedKey.js";
import { createKey, rotateKey, deleteKey, getKeyUsage, getKeyById, listKeysForOwner, assertOwnsKey } from "../admin/keyManager.js";

const router = Router();
router.use(requireAuthenticatedKey);

function statusForError(message) {
  if (/not found/i.test(message)) return 404;
  if (/not authorized/i.test(message)) return 403;
  if (/required|must be/i.test(message)) return 400;
  return 500;
}

router.get("/me", async (req, res) => {
  try {
    const record = await getKeyById(req.rateContext.keyId);
    if (!record) return res.status(404).json({ error: "API key not found" });
    const [usage, events_received] = await Promise.all([
      getKeyUsage(req.rateContext.keyId),
      db.countWebhookDeliveriesForApiKey(req.rateContext.keyId),
    ]);
    res.json({ ...record, usage: { ...usage, events_received } });
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.get("/api-keys", async (req, res) => {
  try {
    const data = await listKeysForOwner(req.rateContext.keyId);
    res.json({ data });
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.post("/api-keys", async (req, res) => {
  try {
    const owner = await getKeyById(req.rateContext.keyId);
    if (!owner) return res.status(404).json({ error: "API key not found" });

    const { name, tier, rate_limit, expires_at } = req.body ?? {};
    const result = await createKey({
      name,
      tier,
      rate_limit,
      expires_at,
      email: owner.email ?? null,
      verified: true, // created from an already-authenticated session — no email round-trip needed
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.post("/api-keys/:id/rotate", async (req, res) => {
  try {
    await assertOwnsKey(req.rateContext.keyId, req.params.id);
    const result = await rotateKey(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.delete("/api-keys/:id", async (req, res) => {
  try {
    await assertOwnsKey(req.rateContext.keyId, req.params.id);
    await deleteKey(req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.get("/api-keys/:id/usage", async (req, res) => {
  try {
    await assertOwnsKey(req.rateContext.keyId, req.params.id);
    const [usage, events_received] = await Promise.all([
      getKeyUsage(req.params.id),
      db.countWebhookDeliveriesForApiKey(req.params.id),
    ]);
    res.json({ ...usage, events_received });
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

export default function registerDashboardRoutes(app) {
  app.use("/api/dashboard", router);
  return router;
}
