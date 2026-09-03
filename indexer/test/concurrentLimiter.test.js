import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const mockRedisClient = {
  isReady: true,
  incr: jest.fn(),
  decr: jest.fn(),
  expire: jest.fn(),
};

let mockGetRedisClient = jest.fn().mockResolvedValue(mockRedisClient);

jest.unstable_mockModule('../src/rateLimit/tokenBucket.js', () => ({
  getRedisClient: mockGetRedisClient,
}));

jest.unstable_mockModule('../src/rateLimit/constants.js', () => ({
  CONC_PREFIX: 'conc',
  CONC_WS_PREFIX: 'conc:ws',
  TTL_CONC_SAFETY: 300,
}));

const { concurrentRequestLimiter } = await import(
  '../src/rateLimit/concurrentLimiter.js'
);

function createTestApp() {
  const app = express();
  app.use('/api', concurrentRequestLimiter);
  app.get('/api/test', (req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/test', (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('concurrentLimiter middleware (issue #763)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.incr.mockReset();
    mockRedisClient.decr.mockReset();
    mockRedisClient.expire.mockReset();
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.decr.mockResolvedValue(0);
    mockRedisClient.expire.mockResolvedValue(1);
  });

  describe('Allow path: under concurrent cap', () => {
    it('allows request when under HTTP concurrent limit', async () => {
      mockRedisClient.incr.mockResolvedValue(3); // within limit of 5 for unauthenticated

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('increments counter on request start', async () => {
      mockRedisClient.incr.mockResolvedValue(2);

      await request(app).get('/api/test');

      expect(mockRedisClient.incr).toHaveBeenCalled();
    });

    it('decrements counter on response finish', async () => {
      mockRedisClient.incr.mockResolvedValue(2);
      mockRedisClient.decr.mockResolvedValue(1);

      await request(app).get('/api/test');

      // Give time for res.on('finish') callback
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRedisClient.decr).toHaveBeenCalled();
    });

    it('sets TTL safety net after INCR', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      await request(app).get('/api/test');

      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        expect.stringMatching(/^conc:/),
        300
      );
    });
  });

  describe('Deny path: at or exceeds concurrent cap', () => {
    it('returns 503 when concurrent limit is exceeded', async () => {
      mockRedisClient.incr.mockResolvedValue(6); // exceeds limit of 5 for unauthenticated

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Too many concurrent requests' });
    });

    it('sets Retry-After header to 1 when limited', async () => {
      mockRedisClient.incr.mockResolvedValue(6);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
    });

    it('immediately decrements counter when rejecting request', async () => {
      mockRedisClient.incr.mockResolvedValue(10);
      mockRedisClient.decr.mockResolvedValue(9);

      await request(app).get('/api/test');

      expect(mockRedisClient.decr).toHaveBeenCalled();
    });

    it('ignores decrement errors on rejection', async () => {
      mockRedisClient.incr.mockResolvedValue(10);
      mockRedisClient.decr.mockRejectedValue(new Error('Redis error'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(503);
      // Should not throw
    });
  });

  describe('Tier-specific limits', () => {
    it('applies free tier limit (20) when tier is free', async () => {
      mockRedisClient.incr.mockResolvedValue(15); // within 20

      let capturedReq;
      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'client-free', tier: 'free' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      const res = await request(app2).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('applies pro tier limit (100) when tier is pro', async () => {
      mockRedisClient.incr.mockResolvedValue(90); // within 100

      let capturedReq;
      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'client-pro', tier: 'pro' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      const res = await request(app2).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('applies enterprise tier limit (200) when tier is enterprise', async () => {
      mockRedisClient.incr.mockResolvedValue(150); // within 200

      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'client-enterprise', tier: 'enterprise' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      const res = await request(app2).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('WebSocket connections', () => {
    it('detects WebSocket upgrade requests', async () => {
      mockRedisClient.incr.mockResolvedValue(1); // within WS limit of 1 for unauthenticated

      const app2 = express();
      app2.use(concurrentRequestLimiter);
      app2.get('/ws', (req, res) => res.json({ ok: true }));

      const res = await request(app2)
        .get('/ws')
        .set('upgrade', 'websocket')
        .set('connection', 'upgrade');

      // Should use WS limits (lower than HTTP)
      expect(mockRedisClient.incr).toHaveBeenCalled();
    });

    it('uses separate Redis keys for HTTP vs WebSocket', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'test-client', tier: 'free' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2).get('/api/test');

      const httpCall = mockRedisClient.incr.mock.calls[0][0];
      expect(httpCall).toMatch(/^conc:/);
    });

    it('applies WebSocket tier limit (1 for unauthenticated)', async () => {
      mockRedisClient.incr.mockResolvedValue(2); // exceeds WS limit of 1

      const app2 = express();
      app2.use(concurrentRequestLimiter);
      app2.get('/ws', (req, res) => res.json({ ok: true }));

      const res = await request(app2)
        .get('/ws')
        .set('upgrade', 'websocket');

      expect(res.status).toBe(503);
    });
  });

  describe('Error handling', () => {
    it('fails open when Redis is unavailable', async () => {
      mockGetRedisClient.mockResolvedValue(null);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('fails open on Redis error during INCR', async () => {
      mockRedisClient.incr.mockRejectedValue(new Error('Redis down'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('ignores DECR errors during response cleanup', async () => {
      mockRedisClient.incr.mockResolvedValue(2);
      mockRedisClient.decr.mockRejectedValue(new Error('Redis error'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      // Cleanup error should not affect response
    });

    it('handles missing rateContext gracefully', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      // Request without rateContext middleware
      const app2 = express();
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      const res = await request(app2).get('/api/test');

      expect(res.status).toBe(200);
      expect(mockRedisClient.incr).toHaveBeenCalled();
    });
  });

  describe('Release path: counter cleanup', () => {
    it('decrements counter even on successful responses', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.decr.mockResolvedValue(0);

      const app2 = express();
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2).get('/api/test');

      await new Promise((r) => setTimeout(r, 50));
      expect(mockRedisClient.decr).toHaveBeenCalled();
    });

    it('decrements counter even on error responses', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.decr.mockResolvedValue(0);

      const app2 = express();
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => {
        res.status(500).json({ error: 'Internal server error' });
      });

      await request(app2).get('/api/test');

      await new Promise((r) => setTimeout(r, 50));
      expect(mockRedisClient.decr).toHaveBeenCalled();
    });
  });

  describe('Redis key format', () => {
    it('uses conc:{clientId} prefix for HTTP requests', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'my-client-123', tier: 'free' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2).get('/api/test');

      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        expect.stringMatching(/^conc:my-client-123$/)
      );
    });

    it('uses conc:ws:{clientId} prefix for WebSocket requests', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'ws-client-456', tier: 'pro' };
        next();
      });
      app2.use(concurrentRequestLimiter);
      app2.get('/ws', (req, res) => res.json({ ok: true }));

      await request(app2)
        .get('/ws')
        .set('upgrade', 'websocket');

      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        expect.stringMatching(/^conc:ws:ws-client-456$/)
      );
    });
  });
});
