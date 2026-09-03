import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.unstable_mockModule('graphql', () => ({
  parse: jest.fn((query) => {
    // Simple mock parser that simulates graphql parse()
    // In real scenario, this would be the actual graphql parser
    if (query.includes('__typename')) {
      return {
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [
                { kind: 'Field', name: { value: '__typename' } },
              ],
            },
          },
        ],
      };
    }
    return {
      definitions: [
        {
          kind: 'OperationDefinition',
          selectionSet: {
            selections: [],
          },
        },
      ],
    };
  }),
}));

const { graphqlComplexityLimiter } = await import(
  '../src/rateLimit/graphqlComplexity.js'
);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/graphql', graphqlComplexityLimiter);
  app.post('/graphql', (req, res) => res.json({ ok: true }));
  app.get('/api/other', (req, res) => res.json({ ok: true }));
  return app;
}

describe('graphqlComplexity middleware (issue #763)', () => {
  let app;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Allow path: query under complexity budget', () => {
    it('allows simple query that is under the budget', async () => {
      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ __typename }' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('sets X-GraphQL-Cost header for allowed queries', async () => {
      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ __typename }' });

      expect(res.headers['x-graphql-cost']).toBeDefined();
      expect(res.headers['x-graphql-cost-remaining']).toBeDefined();
    });

    it('computes correct cost-remaining', async () => {
      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ __typename }' });

      const cost = parseInt(res.headers['x-graphql-cost']);
      const remaining = parseInt(res.headers['x-graphql-cost-remaining']);

      // For unauthenticated (default), budget is 100
      expect(remaining).toBe(100 - cost);
      expect(remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Deny path: query exceeds complexity budget', () => {
    it('rejects query that exceeds budget', async () => {
      // Mock a query with cost > 100 (unauthenticated budget)
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: Array(150)
                .fill(null)
                .map((_, i) => ({
                  kind: 'Field',
                  name: { value: `field${i}` },
                })),
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ field1 field2 ... }' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'Query complexity exceeded',
        })
      );
    });

    it('includes cost and limit in error response', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: Array(200)
                .fill(null)
                .map((_, i) => ({
                  kind: 'Field',
                  name: { value: `field${i}` },
                })),
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ /* complex query */ }' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('cost');
      expect(res.body).toHaveProperty('limit');
      expect(res.body.cost).toBeGreaterThan(res.body.limit);
    });
  });

  describe('List field multiplier', () => {
    it('applies 10x multiplier to fields ending in "s"', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [
                { kind: 'Field', name: { value: 'users' } }, // 1 * 10 = 10
              ],
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ users }' });

      expect(res.status).toBe(200);
      const cost = parseInt(res.headers['x-graphql-cost']);
      expect(cost).toBe(10); // list field multiplier applied
    });

    it('applies 10x multiplier to known list field names', async () => {
      const graphqlMod = await import('graphql');
      const listFields = ['edges', 'nodes', 'items', 'results', 'data'];

      for (const field of listFields) {
        graphqlMod.parse.mockReturnValueOnce({
          definitions: [
            {
              kind: 'OperationDefinition',
              selectionSet: {
                selections: [{ kind: 'Field', name: { value: field } }],
              },
            },
          ],
        });

        const res = await request(app)
          .post('/graphql')
          .send({ query: `{ ${field} }` });

        const cost = parseInt(res.headers['x-graphql-cost']);
        expect(cost).toBe(10); // Should be 1 * 10
      }
    });

    it('does not apply multiplier to singular field names', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [{ kind: 'Field', name: { value: 'user' } }], // singular
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ user }' });

      const cost = parseInt(res.headers['x-graphql-cost']);
      expect(cost).toBe(1); // No multiplier for singular
    });
  });

  describe('Tier-based budget', () => {
    it('applies correct budget for unauthenticated tier (default)', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: { selections: [] },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{}' });

      expect(res.status).toBe(200);
      // Budget should be 100 for unauthenticated
      expect(res.headers['x-graphql-cost-remaining']).toBeDefined();
    });

    it('applies tier budget from rateContext', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [{ kind: 'Field', name: { value: 'data' } }], // cost 10
            },
          },
        ],
      });

      let capturedReq;
      const app2 = express();
      app2.use(express.json());
      app2.use((req, res, next) => {
        req.rateContext = { tier: 'pro' };
        next();
      });
      app2.use('/graphql', graphqlComplexityLimiter);
      app2.post('/graphql', (req, res) => {
        capturedReq = req;
        res.json({ ok: true });
      });

      const res = await request(app2)
        .post('/graphql')
        .send({ query: '{ data }' });

      expect(res.status).toBe(200);
      // Pro tier budget is 2000
      expect(parseInt(res.headers['x-graphql-cost-remaining'])).toBeLessThan(2000);
    });
  });

  describe('Edge cases', () => {
    it('skips middleware for non-GraphQL paths', async () => {
      const res = await request(app)
        .get('/api/other')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('passes through when there is no query in request', async () => {
      const res = await request(app)
        .post('/graphql')
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('passes through on parse error', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockImplementationOnce(() => {
        throw new Error('Parse error');
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ invalid syntax }' });

      expect(res.status).toBe(200);
      expect(res.headers['x-graphql-cost']).toBeUndefined();
    });

    it('handles nested selection sets correctly', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [
                {
                  kind: 'Field',
                  name: { value: 'users' }, // 10
                  selectionSet: {
                    selections: [
                      { kind: 'Field', name: { value: 'id' } }, // 1
                      { kind: 'Field', name: { value: 'name' } }, // 1
                    ],
                  },
                },
              ],
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ users { id name } }' });

      expect(res.status).toBe(200);
      const cost = parseInt(res.headers['x-graphql-cost']);
      expect(cost).toBe(12); // 10 + 1 + 1
    });

    it('handles fragment spreads with minimal cost', async () => {
      const graphqlMod = await import('graphql');
      graphqlMod.parse.mockReturnValueOnce({
        definitions: [
          {
            kind: 'OperationDefinition',
            selectionSet: {
              selections: [
                { kind: 'Field', name: { value: 'user' } },
                { kind: 'FragmentSpread', name: { value: 'UserFragment' } },
              ],
            },
          },
        ],
      });

      const res = await request(app)
        .post('/graphql')
        .send({ query: '{ user ...UserFragment }' });

      expect(res.status).toBe(200);
      // Fragment spreads cost 1 each
      const cost = parseInt(res.headers['x-graphql-cost']);
      expect(cost).toBe(2); // user (1) + fragment spread (1)
    });
  });
});
