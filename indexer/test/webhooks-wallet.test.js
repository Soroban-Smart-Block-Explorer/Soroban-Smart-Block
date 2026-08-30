import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { startApi } from '../src/api.js';
import { db } from '../src/db.js';
import { deliverWebhooksForEvent } from '../src/webhookDelivery.js';

let app, server, apiKey;

beforeAll(async () => {
  // Start the API server for testing
  app = await startApi();
  server = app.listen(0);

  // Create a test API key for webhook subscriptions
  const keyResult = await db.createApiKey({
    key: 'test-key-' + Date.now(),
    name: 'Test Webhook Key',
    tier: 'pro',
  });
  apiKey = keyResult.key;
});

afterAll(async () => {
  server.close();
  await db.pool.end();
});

describe('Webhook Wallet Address Subscriptions', () => {
  it('should register a wallet address subscription', async () => {
    const walletAddress = 'GBUQWP3BOUZX34ULNQG23RQ6F4BFSRTNAQYI5EJGKZOJE7D5JUDPOEQ';

    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        url: 'https://example.com/webhook',
        wallet_address: walletAddress,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.wallet_address).toBe(walletAddress);
    expect(res.body.secret).toBeDefined();
  });

  it('should reject invalid wallet addresses', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        url: 'https://example.com/webhook',
        wallet_address: 'invalid-address',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid Stellar account address/);
  });

  it('should match events containing wallet address in topics', async () => {
    const walletAddress = 'GBUQWP3BOUZX34ULNQG23RQ6F4BFSRTNAQYI5EJGKZOJE7D5JUDPOEQ';
    let deliveryAttempted = false;

    // Register a wallet subscription
    const sub = await db.createWebhookSubscription({
      api_key_id: (await db.createApiKey({ key: 'wallet-test-' + Date.now(), name: 'Test', tier: 'pro' })).id,
      url: 'https://example.com/webhook',
      wallet_address: walletAddress,
      secret: 'test-secret-' + Date.now(),
    });

    // Mock fetch to track delivery attempts
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (url === 'https://example.com/webhook') {
        deliveryAttempted = true;
        return new Response('OK', { status: 200 });
      }
      return originalFetch(url, options);
    };

    // Emit an event with the wallet address in topics
    const decoded = {
      contract_id: 'CTEST00000000000000000000000000000000000000000000000',
      function: 'test_function',
      ledger: 1000,
      tx_hash: 'test-tx-hash',
      description: 'Test event',
      raw_topics: [walletAddress, 'other-topic'],
      raw_data: '[]',
    };

    await deliverWebhooksForEvent(decoded);

    global.fetch = originalFetch;

    expect(deliveryAttempted).toBe(true);
  });

  it('should not match events without the subscribed wallet', async () => {
    const walletAddress = 'GBUQWP3BOUZX34ULNQG23RQ6F4BFSRTNAQYI5EJGKZOJE7D5JUDPOEQ';
    const otherWallet = 'GBQQATUATJGZ2SO36PJXRHFCBQZXYC7CQCM4J3HGAGVMZ6PGPG4PJSE';
    let deliveryAttempted = false;

    // Register a wallet subscription for one address
    const sub = await db.createWebhookSubscription({
      api_key_id: (await db.createApiKey({ key: 'wallet-test2-' + Date.now(), name: 'Test', tier: 'pro' })).id,
      url: 'https://example.com/webhook',
      wallet_address: walletAddress,
      secret: 'test-secret-' + Date.now(),
    });

    global.fetch = async (url, options) => {
      if (url === 'https://example.com/webhook') {
        deliveryAttempted = true;
      }
      return new Response('OK', { status: 200 });
    };

    // Emit an event with a different wallet
    const decoded = {
      contract_id: 'CTEST00000000000000000000000000000000000000000000000',
      function: 'test_function',
      ledger: 1001,
      tx_hash: 'test-tx-hash-2',
      description: 'Test event with different wallet',
      raw_topics: [otherWallet],
      raw_data: '[]',
    };

    await deliverWebhooksForEvent(decoded);

    expect(deliveryAttempted).toBe(false);
  });

  it('should list wallet subscriptions', async () => {
    const walletAddress = 'GBUQWP3BOUZX34ULNQG23RQ6F4BFSRTNAQYI5EJGKZOJE7D5JUDPOEQ';

    // Register subscription
    await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        url: 'https://example.com/webhook',
        wallet_address: walletAddress,
      });

    // List subscriptions
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const walletSub = res.body.data.find((s) => s.wallet_address === walletAddress);
    expect(walletSub).toBeDefined();
  });

  it('should deregister a wallet subscription', async () => {
    const walletAddress = 'GBUQWP3BOUZX34ULNQG23RQ6F4BFSRTNAQYI5EJGKZOJE7D5JUDPOEQ';

    // Register subscription
    const registerRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        url: 'https://example.com/webhook',
        wallet_address: walletAddress,
      });

    const webhookId = registerRes.body.id;

    // Delete subscription
    const deleteRes = await request(app)
      .delete(`/api/webhooks/${webhookId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(deleteRes.status).toBe(204);

    // Verify deletion
    const listRes = await request(app)
      .get('/api/webhooks')
      .set('Authorization', `Bearer ${apiKey}`);

    const deletedSub = listRes.body.data.find((s) => s.id === webhookId && s.active);
    expect(deletedSub).toBeUndefined();
  });
});
