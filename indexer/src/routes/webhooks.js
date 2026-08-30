/**
 * Webhook subscription routes — self-service, scoped to the authenticated
 * API key (req.rateContext.keyId), mounted at /api/webhooks.
 *
 *   POST   /api/webhooks                                   — create a subscription
 *   GET    /api/webhooks                                   — list this key's subscriptions
 *   DELETE /api/webhooks/:id                                — deactivate a subscription
 *   POST   /api/webhooks/:id/test                            — send a synthetic test event
 *   GET    /api/webhooks/:id/deliveries                     — paginated delivery log
 *   POST   /api/webhooks/:id/deliveries/:delivery_id/retry   — manual retry
 *
 * Delivery itself (matching + outbound POST + DLQ retry) lives in
 * webhookDelivery.js; index.js calls deliverWebhooksForEvent() after every
 * new event is indexed.
 */

import { Router } from "express";
import { db } from "../db.js";
import { requireAuthenticatedKey } from "../auth/requireAuthenticatedKey.js";
import { assertSafeWebhookUrl, checkReachable, generateSecret, manualRetryDelivery, sendTestEvent } from "../webhookDelivery.js";

const router = Router();
router.use(requireAuthenticatedKey);

function statusForError(message) {
  if (/not found/i.test(message)) return 404;
  if (/required|must be|not reachable|not authorized/i.test(message)) return 400;
  return 500;
}

router.post("/", async (req, res) => {
  try {
    const { url, contract_id, function_filter, wallet_address } = req.body ?? {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url is required and must be a string" });
    }
    if (contract_id !== undefined && contract_id !== null && typeof contract_id !== "string") {
      return res.status(400).json({ error: "contract_id must be a string" });
    }
    if (function_filter !== undefined && function_filter !== null && typeof function_filter !== "string") {
      return res.status(400).json({ error: "function_filter must be a string" });
    }
    if (wallet_address !== undefined && wallet_address !== null && typeof wallet_address !== "string") {
      return res.status(400).json({ error: "wallet_address must be a string" });
    }

    // Validate wallet address format if provided (Stellar account G...)
    if (wallet_address && !/^G[A-Z2-7]{55}$/.test(wallet_address)) {
      return res.status(400).json({ error: "wallet_address must be a valid Stellar account address (G...)" });
    }

    await assertSafeWebhookUrl(url);
    if (contract_id) {
      const contract = await db.getContractMeta(contract_id);
      if (!contract) return res.status(400).json({ error: `contract not found: ${contract_id}` });
    }
    await checkReachable(url);

    const secret = generateSecret();
    const record = await db.createWebhookSubscription({
      api_key_id: req.rateContext.keyId,
      url,
      contract_id: contract_id || null,
      function_filter: function_filter || null,
      wallet_address: wallet_address || null,
      secret,
    });

    // secret is only ever returned here, at creation time.
    res.status(201).json({ ...record, secret });
  } catch (e) {
    res.status(statusForError(e.message)).json({ error: e.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const data = await db.listWebhookSubscriptions(req.rateContext.keyId);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const record = await db.deactivateWebhookSubscription(req.params.id, req.rateContext.keyId);
    if (!record) return res.status(404).json({ error: "subscription not found" });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/test", async (req, res) => {
  try {
    const sub = await db.getWebhookSubscription(req.params.id);
    if (!sub || sub.api_key_id !== req.rateContext.keyId) {
      return res.status(404).json({ error: "subscription not found" });
    }
    const result = await sendTestEvent(sub);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/deliveries", async (req, res) => {
  try {
    const sub = await db.getWebhookSubscription(req.params.id);
    if (!sub || sub.api_key_id !== req.rateContext.keyId) {
      return res.status(404).json({ error: "subscription not found" });
    }
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const result = await db.listWebhookDeliveries(req.params.id, { page, limit });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/deliveries/:delivery_id/retry", async (req, res) => {
  try {
    const delivery = await db.getWebhookDeliveryWithSubscription(req.params.delivery_id);
    if (!delivery || delivery.webhook_id !== req.params.id || delivery.api_key_id !== req.rateContext.keyId) {
      return res.status(404).json({ error: "delivery not found" });
    }
    if (!delivery.webhook_active) {
      return res.status(409).json({ error: "subscription is inactive — reactivate it before retrying" });
    }
    const result = await manualRetryDelivery(delivery);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default function registerWebhookRoutes(app) {
  app.use("/api/webhooks", router);
  return router;
}
