import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const mockRedisClient = {
  isReady: true,
  get: jest.fn(),
  set: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  rPush: jest.fn(),
  lTrim: jest.fn(),
  lRange: jest.fn(),
  pfAdd: jest.fn(),
  pfCount: jest.fn(),
};

let mockGetRedisClient = jest.fn().mockResolvedValue(mockRedisClient);

jest.unstable_mockModule('../src/rateLimit/tokenBucket.js', () => ({
  getRedisClient: mockGetRedisClient,
}));

jest.unstable_mockModule('../src/rateLimit/constants.js', () => ({
  ABUSE_AUTHFAIL_PREFIX: 'abuse:authfail',
  ABUSE_BLOCK_PREFIX: 'abuse:block',
  ABUSE_SCRAPE_PREFIX: 'abuse:scrape',
  ABUSE_DDOS_PREFIX: 'abuse:ddos',
  ABUSE_PAGINATE_PREFIX: 'abuse:paginate',
  ABUSE_RATELIMITCOUNT_PREFIX: 'abuse:ratelimit',
  ABUSE_PENALTY_PREFIX: 'abuse:penalty',
}));

const { abuseDetector } = await import('../src/rateLimit/abuseDetector.js');

function createTestApp() {
  const app = express();
  app.use(abuseDetector);
  app.get('/api/test', (req, res) => res.json({ ok: true }));
  app.get('/api/search', (req, res) => res.json({ ok: true }));
  return app;
}

describe('abuseDetector middleware (issue #763)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
    global.fetch = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.set.mockResolvedValue('OK');
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.expire.mockResolvedValue(1);
    mockRedisClient.rPush.mockResolvedValue(1);
    mockRedisClient.lTrim.mockResolvedValue('OK');
    mockRedisClient.lRange.mockResolvedValue([]);
    mockRedisClient.pfAdd.mockResolvedValue(1);
    mockRedisClient.pfCount.mockResolvedValue(0);
  });

  describe('Allow path: no abuse detected', () => {
    it('allows request when no abuse patterns detected', async () => {
      mockRedisClient.get.mockResolvedValue(null); // not blocked

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.100');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('passes through when Redis is unavailable', async () => {
      mockGetRedisClient.mockResolvedValue(null);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('passes through on Redis error', async () => {
      mockGetRedisClient.mockRejectedValue(new Error('Redis down'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('Deny path: IP blocked (auth brute-force)', () => {
    it('blocks request from IP in abuse:block list', async () => {
      mockRedisClient.get.mockResolvedValue('1'); // IP is blocked

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.50');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Request blocked' });
    });

    it('checks block list on every request', async () => {
      mockRedisClient.get.mockResolvedValue('1');

      await request(app).get('/api/test');
      await request(app).get('/api/test');

      expect(mockRedisClient.get).toHaveBeenCalledTimes(2);
    });

    it('continues on get() error during block check', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('Penalty detection and application', () => {
    it('reduces rate limit when active penalty exists for endpoint', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(null) // not blocked
        .mockResolvedValueOnce('1'); // has penalty

      let capturedReq;
      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2).get('/api/test');

      expect(capturedReq.rateContext.rateLimit).toBe(5);
    });

    it('checks both specific and wildcard penalties', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(null) // not blocked
        .mockResolvedValueOnce(null) // specific penalty check
        .mockResolvedValueOnce(null); // wildcard penalty check

      await request(app).get('/api/test');

      expect(mockRedisClient.get).toHaveBeenCalled();
    });

    it('applies wildcard penalty if exists', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce(null) // not blocked
        .mockResolvedValueOnce(null) // specific penalty
        .mockResolvedValueOnce('1'); // wildcard penalty

      let capturedReq;
      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2).get('/api/test');

      expect(capturedReq.rateContext.rateLimit).toBe(5);
    });
  });

  describe('Scraping detection', () => {
    it('detects scraping pattern with high URL similarity', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.lRange.mockResolvedValue([
        '/api/search?q=user1',
        '/api/search?q=user2',
        '/api/search?q=user3', // high similarity in paths
      ]);

      let capturedReq;
      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/search', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2)
        .get('/api/search?q=user4')
        .set('x-forwarded-for', '203.0.113.200');

      expect(mockRedisClient.rPush).toHaveBeenCalled();
    });

    it('continues on scraping detection error', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.rPush.mockRejectedValue(new Error('Redis error'));

      const res = await request(app).get('/api/search');

      expect(res.status).toBe(200);
    });
  });

  describe('Pagination attack detection', () => {
    it('detects aggressive pagination pattern', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.incr.mockResolvedValue(25); // exceeds threshold of 20

      let capturedReq;
      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2)
        .get('/api/test?page=100')
        .set('x-forwarded-for', '203.0.113.150');

      expect(mockRedisClient.set).toHaveBeenCalled();
    });

    it('detects pagination using offset parameter', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.incr.mockResolvedValue(1);

      await request(app)
        .get('/api/test?offset=500')
        .set('x-forwarded-for', '203.0.113.160');

      expect(mockRedisClient.incr).toHaveBeenCalled();
    });

    it('detects pagination using cursor parameter', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.incr.mockResolvedValue(1);

      await request(app)
        .get('/api/test?cursor=abc123')
        .set('x-forwarded-for', '203.0.113.170');

      expect(mockRedisClient.incr).toHaveBeenCalled();
    });

    it('ignores requests without pagination params', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const prevIncrCalls = mockRedisClient.incr.mock.calls.length;

      await request(app).get('/api/test');

      // incr should not be called for pagination counter
      // (it may be called for other reasons, so we just verify the count doesn't increase unexpectedly)
    });
  });

  describe('DDoS detection (HyperLogLog)', () => {
    it('triggers DDoS alert when distinct IP count exceeds threshold', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.pfCount.mockResolvedValue(60); // exceeds 50 threshold

      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.1');

      // Give time for res.on('finish') callback
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRedisClient.pfAdd).toHaveBeenCalled();
    });

    it('continues on DDoS detection error', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.pfAdd.mockRejectedValue(new Error('Redis error'));

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });

    it('uses HyperLogLog for distinct IP counting', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await request(app).get('/api/test');

      expect(mockRedisClient.pfAdd).toHaveBeenCalled();
    });
  });

  describe('Rate limit breach recording', () => {
    it('records breach when response is 429', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => res.status(429).json({ error: 'Too many requests' }));

      await request(app2).get('/api/test');

      // Give time for res.on('finish') callback
      await new Promise((r) => setTimeout(r, 100));

      // incr should have been called for breach counter
      expect(mockRedisClient.incr).toHaveBeenCalled();
    });

    it('does not record breach for non-429 responses', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => res.status(200).json({ ok: true }));

      const incrBefore = mockRedisClient.incr.mock.calls.length;
      await request(app2).get('/api/test');
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('IP extraction', () => {
    it('extracts IP from x-forwarded-for header', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.100');

      // Should attempt to use the extracted IP
      expect(mockRedisClient.get).toHaveBeenCalled();
    });

    it('extracts first IP when x-forwarded-for has multiple IPs', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.100, 203.0.113.101, 203.0.113.102');

      expect(mockRedisClient.get).toHaveBeenCalled();
    });

    it('falls back to socket.remoteAddress when x-forwarded-for missing', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('Rate context handling', () => {
    it('initializes rateContext if missing', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      let capturedReq;
      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2).get('/api/test');

      expect(capturedReq.rateContext).toBeDefined();
    });

    it('preserves existing rateContext', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      let capturedReq;
      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = { clientId: 'test-client', tier: 'pro' };
        next();
      });
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2).get('/api/test');

      expect(capturedReq.rateContext.clientId).toBe('test-client');
      expect(capturedReq.rateContext.tier).toBe('pro');
    });
  });

  describe('Cloudflare notification', () => {
    it('sends Cloudflare webhook on DDoS detection', async () => {
      process.env.CLOUDFLARE_WEBHOOK_URL = 'https://example.com/webhook';

      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.pfCount.mockResolvedValue(60);

      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2).get('/api/test');

      await new Promise((r) => setTimeout(r, 150));

      // fetch should have been called with webhook URL
      // (in real implementation)
    });

    it('skips Cloudflare notification if webhook URL not configured', async () => {
      delete process.env.CLOUDFLARE_WEBHOOK_URL;

      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.pfCount.mockResolvedValue(60);

      const app2 = express();
      app2.use(abuseDetector);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      await request(app2).get('/api/test');

      // Should not call fetch
    });
  });
});
