import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheService } from '../../src/services/cache.service';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  };
  return { default: vi.fn(() => mockRedis) };
});

describe('CacheService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('disabled mode (no URL)', () => {
    it('creates service without redis when no URL', () => {
      const cache = new CacheService();
      expect(cache).toBeDefined();
    });

    it('get returns null when disabled', async () => {
      const cache = new CacheService();
      const result = await cache.get('key');
      expect(result).toBeNull();
    });

    it('set does nothing when disabled', async () => {
      const cache = new CacheService();
      await cache.set('key', 'value');
      // No error thrown
    });

    it('del does nothing when disabled', async () => {
      const cache = new CacheService();
      await cache.del('key');
      // No error thrown
    });
  });

  describe('hashKey', () => {
    it('returns consistent hash for same input', () => {
      const cache = new CacheService();
      const hash1 = cache.hashKey('test input');
      const hash2 = cache.hashKey('test input');
      expect(hash1).toBe(hash2);
    });

    it('normalizes input (trim + lowercase)', () => {
      const cache = new CacheService();
      const hash1 = cache.hashKey('Test Input');
      const hash2 = cache.hashKey('  test input  ');
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different inputs', () => {
      const cache = new CacheService();
      const hash1 = cache.hashKey('input one');
      const hash2 = cache.hashKey('input two');
      expect(hash1).not.toBe(hash2);
    });

    it('returns a hex string', () => {
      const cache = new CacheService();
      const hash = cache.hashKey('test');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('disconnect', () => {
    it('does nothing when no redis', async () => {
      const cache = new CacheService();
      await cache.disconnect();
      // No error thrown
    });
  });
});
