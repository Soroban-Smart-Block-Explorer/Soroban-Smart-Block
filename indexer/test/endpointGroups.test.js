import { describe, it, expect } from '@jest/globals';
import {
  resolveEndpointGroup,
  getTierLimits,
  TIER_BURST_DEFAULTS,
} from '../src/rateLimit/endpointGroups.js';

describe('endpointGroups module (issue #763)', () => {
  describe('resolveEndpointGroup', () => {
    describe('WebSocket group', () => {
      it('resolves /ws to websocket group', () => {
        expect(resolveEndpointGroup('/ws')).toBe('websocket');
      });

      it('resolves /ws/... paths to websocket group', () => {
        expect(resolveEndpointGroup('/ws/live')).toBe('websocket');
        expect(resolveEndpointGroup('/ws/stream/123')).toBe('websocket');
      });

      it('resolves /socket to websocket group', () => {
        expect(resolveEndpointGroup('/socket')).toBe('websocket');
      });

      it('resolves /api/ws to websocket group', () => {
        expect(resolveEndpointGroup('/api/ws')).toBe('websocket');
        expect(resolveEndpointGroup('/api/ws/connect')).toBe('websocket');
      });

      it('resolves /api/socket to websocket group', () => {
        expect(resolveEndpointGroup('/api/socket')).toBe('websocket');
      });
    });

    describe('Simulate group', () => {
      it('resolves /api/simulate to simulate group', () => {
        expect(resolveEndpointGroup('/api/simulate')).toBe('simulate');
      });

      it('resolves /api/simulate/... paths to simulate group', () => {
        expect(resolveEndpointGroup('/api/simulate/contract')).toBe('simulate');
      });

      it('resolves /api/sandbox/simulate to simulate group', () => {
        expect(resolveEndpointGroup('/api/sandbox/simulate')).toBe('simulate');
      });

      it('resolves /api/sandbox/simulate/... paths to simulate group', () => {
        expect(resolveEndpointGroup('/api/sandbox/simulate/call')).toBe('simulate');
      });
    });

    describe('Contracts group', () => {
      it('resolves /api/contracts to contracts group', () => {
        expect(resolveEndpointGroup('/api/contracts')).toBe('contracts');
      });

      it('resolves /api/contracts/... paths to contracts group', () => {
        expect(resolveEndpointGroup('/api/contracts/123')).toBe('contracts');
      });

      it('resolves /api/v1/contracts to contracts group', () => {
        expect(resolveEndpointGroup('/api/v1/contracts')).toBe('contracts');
      });

      it('resolves /api/v1/contracts/... paths to contracts group', () => {
        expect(resolveEndpointGroup('/api/v1/contracts/456')).toBe('contracts');
      });

      it('resolves /api/spec to contracts group', () => {
        expect(resolveEndpointGroup('/api/spec')).toBe('contracts');
      });

      it('resolves /api/verify to contracts group', () => {
        expect(resolveEndpointGroup('/api/verify')).toBe('contracts');
      });
    });

    describe('Search group', () => {
      it('resolves /api/search to search group', () => {
        expect(resolveEndpointGroup('/api/search')).toBe('search');
      });

      it('resolves /api/search/... paths to search group', () => {
        expect(resolveEndpointGroup('/api/search/contracts')).toBe('search');
      });

      it('resolves /api/wallet to search group', () => {
        expect(resolveEndpointGroup('/api/wallet')).toBe('search');
      });

      it('resolves /api/wallet/... paths to search group', () => {
        expect(resolveEndpointGroup('/api/wallet/balance')).toBe('search');
      });
    });

    describe('Events group', () => {
      it('resolves /api/events to events group', () => {
        expect(resolveEndpointGroup('/api/events')).toBe('events');
      });

      it('resolves /api/events/... paths to events group', () => {
        expect(resolveEndpointGroup('/api/events/123')).toBe('events');
      });

      it('resolves /api/v1/events to events group', () => {
        expect(resolveEndpointGroup('/api/v1/events')).toBe('events');
      });

      it('resolves /api/v1/events/... paths to events group', () => {
        expect(resolveEndpointGroup('/api/v1/events/456')).toBe('events');
      });
    });

    describe('Default group', () => {
      it('resolves /api/health to default group', () => {
        expect(resolveEndpointGroup('/api/health')).toBe('default');
      });

      it('resolves /other/path to default group', () => {
        expect(resolveEndpointGroup('/other/path')).toBe('default');
      });

      it('resolves / to default group', () => {
        expect(resolveEndpointGroup('/')).toBe('default');
      });

      it('resolves unmatched paths to default group', () => {
        expect(resolveEndpointGroup('/api/custom/endpoint')).toBe('default');
      });
    });

    describe('Case-insensitive matching', () => {
      it('matches paths case-insensitively', () => {
        expect(resolveEndpointGroup('/API/EVENTS')).toBe('events');
        expect(resolveEndpointGroup('/Api/Events/123')).toBe('events');
        expect(resolveEndpointGroup('/WS/stream')).toBe('websocket');
      });
    });

    describe('Query string handling', () => {
      it('resolves paths with query strings', () => {
        expect(resolveEndpointGroup('/api/events?limit=100')).toBe('events');
        expect(resolveEndpointGroup('/api/search?q=test')).toBe('search');
      });
    });

    describe('Edge cases', () => {
      it('returns default for null/undefined input', () => {
        expect(resolveEndpointGroup(null)).toBe('default');
        expect(resolveEndpointGroup(undefined)).toBe('default');
      });

      it('returns default for non-string input', () => {
        expect(resolveEndpointGroup(123)).toBe('default');
        expect(resolveEndpointGroup({})).toBe('default');
      });

      it('returns default for empty string', () => {
        expect(resolveEndpointGroup('')).toBe('default');
      });

      it('matches exact paths without trailing slash', () => {
        expect(resolveEndpointGroup('/api/events')).toBe('events');
      });
    });

    describe('Priority/ordering', () => {
      it('applies first matching pattern in group order', () => {
        // WebSocket is first in the list, so should match before default
        expect(resolveEndpointGroup('/ws/data')).toBe('websocket');
      });

      it('does not match partial patterns', () => {
        // /api/event should not match /api/events
        expect(resolveEndpointGroup('/api/event')).toBe('default');
      });
    });
  });

  describe('getTierLimits', () => {
    describe('Base RPM limits', () => {
      it('returns correct rpm for events group by tier', () => {
        expect(getTierLimits('events', 'unauthenticated').rpm).toBe(60);
        expect(getTierLimits('events', 'free').rpm).toBe(1000);
        expect(getTierLimits('events', 'pro').rpm).toBe(10000);
      });

      it('returns correct rpm for search group by tier', () => {
        expect(getTierLimits('search', 'unauthenticated').rpm).toBe(30);
        expect(getTierLimits('search', 'free').rpm).toBe(500);
        expect(getTierLimits('search', 'pro').rpm).toBe(5000);
      });

      it('returns correct rpm for contracts group by tier', () => {
        expect(getTierLimits('contracts', 'unauthenticated').rpm).toBe(10);
        expect(getTierLimits('contracts', 'free').rpm).toBe(100);
        expect(getTierLimits('contracts', 'pro').rpm).toBe(1000);
      });

      it('returns correct rpm for simulate group by tier', () => {
        expect(getTierLimits('simulate', 'unauthenticated').rpm).toBe(5);
        expect(getTierLimits('simulate', 'free').rpm).toBe(50);
        expect(getTierLimits('simulate', 'pro').rpm).toBe(500);
      });

      it('returns correct rpm for websocket group by tier', () => {
        expect(getTierLimits('websocket', 'unauthenticated').rpm).toBe(3);
        expect(getTierLimits('websocket', 'free').rpm).toBe(30);
        expect(getTierLimits('websocket', 'pro').rpm).toBe(300);
      });

      it('returns correct rpm for default group by tier', () => {
        expect(getTierLimits('default', 'unauthenticated').rpm).toBe(60);
        expect(getTierLimits('default', 'free').rpm).toBe(1000);
        expect(getTierLimits('default', 'pro').rpm).toBe(10000);
      });
    });

    describe('Enterprise tier handling', () => {
      it('returns Infinity for enterprise tier without override', () => {
        expect(getTierLimits('events', 'enterprise').rpm).toBe(Infinity);
        expect(getTierLimits('search', 'enterprise').rpm).toBe(Infinity);
      });

      it('uses override rpm when provided for enterprise', () => {
        expect(getTierLimits('events', 'enterprise', 50000).rpm).toBe(50000);
        expect(getTierLimits('search', 'enterprise', 10000).rpm).toBe(10000);
      });
    });

    describe('Override rpm handling', () => {
      it('uses override rpm when provided and is finite positive number', () => {
        expect(getTierLimits('events', 'free', 500).rpm).toBe(500);
        expect(getTierLimits('search', 'pro', 2000).rpm).toBe(2000);
      });

      it('falls back to base limits when override is null', () => {
        expect(getTierLimits('events', 'free', null).rpm).toBe(1000);
      });

      it('falls back to base limits when override is non-finite', () => {
        expect(getTierLimits('events', 'pro', Infinity).rpm).toBe(10000);
        expect(getTierLimits('events', 'pro', NaN).rpm).toBe(10000);
      });

      it('falls back to base limits when override is non-positive', () => {
        expect(getTierLimits('events', 'free', 0).rpm).toBe(1000);
        expect(getTierLimits('events', 'free', -100).rpm).toBe(1000);
      });

      it('falls back to base limits when override is not a number', () => {
        expect(getTierLimits('events', 'free', 'invalid').rpm).toBe(1000);
        expect(getTierLimits('events', 'free', {}).rpm).toBe(1000);
      });
    });

    describe('Burst limits', () => {
      it('returns correct burst for each tier', () => {
        expect(getTierLimits('events', 'unauthenticated').burst).toBe(10);
        expect(getTierLimits('events', 'free').burst).toBe(50);
        expect(getTierLimits('events', 'pro').burst).toBe(200);
        expect(getTierLimits('events', 'enterprise').burst).toBe(500);
      });

      it('returns same burst for all groups of same tier', () => {
        const burstFree = getTierLimits('events', 'free').burst;
        expect(getTierLimits('search', 'free').burst).toBe(burstFree);
        expect(getTierLimits('contracts', 'free').burst).toBe(burstFree);
      });
    });

    describe('Unknown group/tier handling', () => {
      it('uses default group limits for unknown group', () => {
        expect(getTierLimits('unknown_group', 'free').rpm).toBe(1000);
      });

      it('uses unauthenticated tier defaults for unknown tier', () => {
        expect(getTierLimits('events', 'unknown_tier').rpm).toBe(60);
      });

      it('uses unauthenticated burst for unknown tier', () => {
        expect(getTierLimits('events', 'unknown_tier').burst).toBe(10);
      });
    });

    describe('Return structure', () => {
      it('returns object with rpm and burst properties', () => {
        const result = getTierLimits('events', 'pro');
        expect(result).toHaveProperty('rpm');
        expect(result).toHaveProperty('burst');
      });

      it('rpm is a number', () => {
        const result = getTierLimits('events', 'pro');
        expect(typeof result.rpm).toBe('number');
      });

      it('burst is a number', () => {
        const result = getTierLimits('events', 'pro');
        expect(typeof result.burst).toBe('number');
      });
    });

    describe('Burst defaults constant', () => {
      it('exports TIER_BURST_DEFAULTS', () => {
        expect(TIER_BURST_DEFAULTS).toBeDefined();
      });

      it('contains all tiers', () => {
        expect(TIER_BURST_DEFAULTS.unauthenticated).toBe(10);
        expect(TIER_BURST_DEFAULTS.free).toBe(50);
        expect(TIER_BURST_DEFAULTS.pro).toBe(200);
        expect(TIER_BURST_DEFAULTS.enterprise).toBe(500);
      });
    });
  });

  describe('Integration: resolveEndpointGroup + getTierLimits', () => {
    it('resolves path to group and gets limits in one flow', () => {
      const group = resolveEndpointGroup('/api/events/123');
      const limits = getTierLimits(group, 'pro');

      expect(group).toBe('events');
      expect(limits.rpm).toBe(10000);
      expect(limits.burst).toBe(200);
    });

    it('applies override rpm after group resolution', () => {
      const group = resolveEndpointGroup('/api/search');
      const limits = getTierLimits(group, 'free', 1000);

      expect(group).toBe('search');
      expect(limits.rpm).toBe(1000); // override applied
      expect(limits.burst).toBe(50); // burst from tier defaults
    });
  });
});
