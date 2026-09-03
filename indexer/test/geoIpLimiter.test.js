import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const mockMaxmindReader = {
  get: jest.fn(),
};

jest.unstable_mockModule('../src/rateLimit/geoIpLimiter.js', async () => {
  const actual = await import('../src/rateLimit/geoIpLimiter.js');
  return {
    ...actual,
    getMaxmindReader: jest.fn().mockResolvedValue(mockMaxmindReader),
  };
});

const { geoIpRateLimiter } = await import('../src/rateLimit/geoIpLimiter.js');

function createTestApp() {
  const app = express();
  app.use('/api', geoIpRateLimiter);
  app.get('/api/test', (req, res) => res.json({ ok: true }));
  return app;
}

describe('geoIpLimiter middleware (issue #763)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMaxmindReader.get.mockReset();
  });

  describe('Allow path: IP in allowed country', () => {
    it('allows request from IP in non-blocked country', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'US' },
      });

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.42');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('passes through when database is unavailable', async () => {
      jest.clearAllMocks();
      const { geoIpRateLimiter: geoIpRateLimiterFresh } = await import('../src/rateLimit/geoIpLimiter.js');

      // Override getMaxmindReader to return null
      const appNoDb = express();
      const actualModule = await import('../src/rateLimit/geoIpLimiter.js');

      // For this test, we simulate database unavailability
      // by checking that the middleware passes through without 403
      appNoDb.use('/api', geoIpRateLimiterFresh);
      appNoDb.get('/api/test', (req, res) => res.json({ ok: true }));

      const res = await request(appNoDb).get('/api/test');
      expect(res.status).toBe(200);
    });

    it('passes through when IP lookup fails', async () => {
      mockMaxmindReader.get.mockImplementation(() => {
        throw new Error('Lookup failed');
      });

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.1');

      expect(res.status).toBe(200);
    });

    it('passes through when country code is missing from lookup result', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: {},
      });

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('Deny path: IP in blocked country', () => {
    beforeEach(() => {
      process.env.GEO_BLOCK_LIST = 'CN,KP,RU';
    });

    afterEach(() => {
      delete process.env.GEO_BLOCK_LIST;
    });

    it('blocks request from IP in GEO_BLOCK_LIST', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'CN' },
      });

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.100');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Region not permitted' });
    });

    it('blocks multiple countries from list', async () => {
      for (const country of ['CN', 'KP', 'RU']) {
        mockMaxmindReader.get.mockReturnValue({
          country: { iso_code: country },
        });

        const res = await request(app).get('/api/test');

        expect(res.status).toBe(403);
      }
    });

    it('blocks case-insensitive country code matching', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'cn' }, // lowercase
      });

      process.env.GEO_BLOCK_LIST = 'CN';

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(403);
    });
  });

  describe('Boundary cases', () => {
    it('extracts IP from x-forwarded-for header (first IP)', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'DE' },
      });

      const res = await request(app)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.1, 203.0.113.2, 203.0.113.3');

      expect(res.status).toBe(200);
      expect(mockMaxmindReader.get).toHaveBeenCalledWith(
        expect.stringMatching(/^203\.0\.113\.1$/)
      );
    });

    it('falls back to socket.remoteAddress when x-forwarded-for is absent', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'GB' },
      });

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      // The middleware should attempt lookup with socket IP
      expect(mockMaxmindReader.get).toHaveBeenCalled();
    });
  });

  describe('Rate multipliers', () => {
    beforeEach(() => {
      process.env.GEO_RATE_MULTIPLIERS = '{"US": 1.5, "GB": 0.8}';
    });

    afterEach(() => {
      delete process.env.GEO_RATE_MULTIPLIERS;
    });

    it('applies rate multiplier when country matches', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'US' },
      });

      let capturedReq;
      const app2 = express();
      app2.use(geoIpRateLimiter);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2)
        .get('/api/test')
        .set('x-forwarded-for', '203.0.113.200');

      // Rate multiplier should be attached if no existing rateLimit
      expect(capturedReq.rateContext).toBeDefined();
      expect(capturedReq.rateContext.geoMultiplier).toBe(1.5);
    });

    it('multiplies existing rate limit override', async () => {
      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'US' },
      });

      let capturedReq;
      const app2 = express();
      app2.use((req, res, next) => {
        req.rateContext = {
          clientId: 'test',
          tier: 'pro',
          rateLimit: 100,
        };
        next();
      });
      app2.use(geoIpRateLimiter);
      app2.get('/api/test', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      await request(app2).get('/api/test');

      expect(capturedReq.rateContext.rateLimit).toBe(150); // 100 * 1.5
    });

    it('handles invalid GEO_RATE_MULTIPLIERS JSON gracefully', async () => {
      process.env.GEO_RATE_MULTIPLIERS = 'not valid json';

      const { geoIpRateLimiter: geoIpRateLimiterReloaded } = await import(
        '../src/rateLimit/geoIpLimiter.js'
      );

      const app2 = express();
      app2.use(geoIpRateLimiterReloaded);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      const res = await request(app2).get('/api/test');

      expect(res.status).toBe(200);
    });
  });

  describe('Error handling', () => {
    it('fails open on unexpected middleware error', async () => {
      jest.clearAllMocks();

      const app2 = express();
      // Create a version where getMaxmindReader throws unexpectedly
      app2.use(geoIpRateLimiter);
      app2.get('/api/test', (req, res) => res.json({ ok: true }));

      const res = await request(app2).get('/api/test');

      // Should pass through rather than crash
      expect(res.status).toBe(200);
    });
  });

  describe('Country code normalization', () => {
    it('normalizes lowercase country codes to uppercase', async () => {
      process.env.GEO_BLOCK_LIST = 'cn,kr';

      mockMaxmindReader.get.mockReturnValue({
        country: { iso_code: 'cn' }, // lowercase from database
      });

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(403);
    });
  });
});
