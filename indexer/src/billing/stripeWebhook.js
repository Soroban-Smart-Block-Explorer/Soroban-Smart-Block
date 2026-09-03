import { logger } from "../logger.js";
/**
 * Stripe Webhook Handler
 *
 * Verifies incoming Stripe webhook signatures and handles subscription lifecycle
 * events to update api_keys.tier accordingly.
 *
 * Handled events:
 *   customer.subscription.updated  → update tier from product metadata
 *   customer.subscription.deleted  → downgrade tier to 'free'
 *
 * Security:
 *   - express.raw() is applied on this route so Stripe signature verification
 *     can operate on the raw request body (JSON parsing would invalidate the sig).
 *   - Returns 400 { error: "Invalid signature" } if verification fails.
 *   - Returns 200 { received: true } on success.
 *
 * Environment variables:
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
 *   STRIPE_SECRET_KEY      — Stripe API key (sk_...)
 */

import express from 'express';
import Stripe from 'stripe';
import { pool } from '../db.js';

const stripeWebhookRouter = express.Router();

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /stripe-webhook
 *
 * express.raw() is applied inline so only this route receives an unparsed body.
 * The parent app must NOT apply express.json() before this route for the path
 * /api/billing/stripe-webhook, or the raw body will be consumed.
 */
stripeWebhookRouter.post(
  '/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.error('[stripeWebhook] STRIPE_WEBHOOK_SECRET is not set');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Lazily instantiate Stripe client so the module can be imported without
    // STRIPE_SECRET_KEY being set (e.g. in tests that mock the client).
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      apiVersion: '2023-10-16',
    });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.warn('[stripeWebhook] Signature verification failed:', err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    try {
      await _handleEvent(event);
      return res.status(200).json({ received: true });
    } catch (err) {
      logger.error('[stripeWebhook] Event handling error:', err.message);
      // Return 200 to prevent Stripe retrying an event we cannot process.
      // The error is logged for investigation.
      return res.status(200).json({ received: true, warning: err.message });
    }
  },
);

// ── Event handler ─────────────────────────────────────────────────────────────

/**
 * Dispatch a verified Stripe event to the appropriate handler.
 *
 * @param {import('stripe').Stripe.Event} event
 */
async function _handleEvent(event) {
  switch (event.type) {
    case 'customer.subscription.updated':
      await _handleSubscriptionUpdated(event.data.object);
      break;

    case 'customer.subscription.deleted':
      await _handleSubscriptionDeleted(event.data.object);
      break;

    default:
      // Silently ignore unhandled event types.
      logger.info(`[stripeWebhook] Unhandled event type: ${event.type}`);
  }
}

// ── customer.subscription.updated ─────────────────────────────────────────────

/**
 * Update the API key's tier to match the subscription's product metadata.
 *
 * The Stripe product should have metadata:
 *   tier: 'free' | 'pro' | 'enterprise'
 *
 * The subscription (or its metadata) should identify the API key via:
 *   api_key_id: '<uuid>'
 *
 * @param {import('stripe').Stripe.Subscription} subscription
 */
async function _handleSubscriptionUpdated(subscription) {
  const apiKeyId = subscription.metadata?.api_key_id;

  if (!apiKeyId) {
    logger.warn('[stripeWebhook] subscription.updated: no api_key_id in metadata, skipping');
    return;
  }

  // Derive tier from the first subscription item's product metadata.
  const tier = _extractTierFromSubscription(subscription);

  if (!tier) {
    logger.warn('[stripeWebhook] subscription.updated: could not determine tier from product metadata');
    return;
  }

  await pool.query(
    `UPDATE api_keys SET tier = $1, updated_at = NOW() WHERE id = $2`,
    [tier, apiKeyId],
  );

  logger.info(`[stripeWebhook] Updated api_keys.tier → ${tier} for key ${apiKeyId}`);
}

// ── customer.subscription.deleted ─────────────────────────────────────────────

/**
 * Downgrade the API key tier to 'free' when a subscription is cancelled.
 *
 * @param {import('stripe').Stripe.Subscription} subscription
 */
async function _handleSubscriptionDeleted(subscription) {
  const apiKeyId = subscription.metadata?.api_key_id;

  if (!apiKeyId) {
    logger.warn('[stripeWebhook] subscription.deleted: no api_key_id in metadata, skipping');
    return;
  }

  await pool.query(
    `UPDATE api_keys SET tier = 'free', updated_at = NOW() WHERE id = $1`,
    [apiKeyId],
  );

  logger.info(`[stripeWebhook] Downgraded api_keys.tier → free for key ${apiKeyId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a tier string from the subscription's product metadata.
 * Returns null if the tier cannot be determined or is not a known value.
 *
 * @param {import('stripe').Stripe.Subscription} subscription
 * @returns {string|null}
 */
function _extractTierFromSubscription(subscription) {
  const VALID_TIERS = ['free', 'pro', 'enterprise'];

  // Try subscription-level metadata first.
  const subTier = subscription.metadata?.tier;
  if (subTier && VALID_TIERS.includes(subTier)) return subTier;

  // Fall back to first subscription item's price/product metadata.
  const items = subscription.items?.data ?? [];
  for (const item of items) {
    const productMeta = item.price?.product?.metadata ?? item.plan?.metadata ?? {};
    const productTier = productMeta.tier;
    if (productTier && VALID_TIERS.includes(productTier)) return productTier;
  }

  return null;
}

export { stripeWebhookRouter };
