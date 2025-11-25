import Redis from 'ioredis';
import { createHash } from 'crypto';

export class CacheService {
  private redis: Redis | null = null;
  private isConnected = false;

  constructor(url?: string, password?: string) {
    if (!url) {
      console.log('[Cache] Redis URL not provided, caching disabled');
      return;
    }

    try {
      this.redis = new Redis(url, {
        password: password || undefined,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) {
            console.error('[Cache] Redis connection failed after 3 attempts');
            return null;
          }
          return Math.min(times * 100, 3000);
        }
      });

      this.redis.on('connect', () => {
        this.isConnected = true;
        console.log('[Cache] Redis connected');
      });

      this.redis.on('error', (err) => {
        console.error('[Cache] Redis error:', err.message);
        this.isConnected = false;
      });

      this.redis.connect().catch((err) => {
        console.error('[Cache] Failed to connect to Redis:', err.message);
      });
    } catch (error) {
      console.error('[Cache] Redis initialization error:', error);
      this.redis = null;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis || !this.isConnected) {
      return null;
    }

    try {
      return await this.redis.get(key);
    } catch (error) {
      console.error('[Cache] Get error:', error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds = 86400): Promise<void> {
    if (!this.redis || !this.isConnected) {
      return;
    }

    try {
      await this.redis.setex(key, ttlSeconds, value);
    } catch (error) {
      console.error('[Cache] Set error:', error);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.redis || !this.isConnected) {
      return;
    }

    try {
      await this.redis.del(key);
    } catch (error) {
      console.error('[Cache] Delete error:', error);
    }
  }

  hashKey(input: string): string {
    const normalized = input.trim().toLowerCase();
    return createHash('sha256').update(normalized).digest('hex');
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
