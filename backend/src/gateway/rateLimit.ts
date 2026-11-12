import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { checkRateLimit, getRedisClient } from '../redis/client.js';

export interface RateLimiterOptions {
  windowMs?: number;
  maxLimit?: number;
  keyPrefix?: string;
  client?: Redis;
}

/**
 * Factory for Redis-backed sliding-window rate limit middleware using atomic Lua.
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const windowMs = options.windowMs || env.RATE_LIMIT_WINDOW_MS;
  const maxLimit = options.maxLimit || env.RATE_LIMIT_MAX;
  const prefix = options.keyPrefix || 'ratelimit:general';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawForwarded = req.headers['x-forwarded-for'];
    const clientIp =
      (typeof rawForwarded === 'string' ? rawForwarded.split(',')[0]?.trim() : undefined) ||
      req.ip ||
      '127.0.0.1';
    const requestId = req.requestId || 'unknown';

    const key = `${prefix}:${clientIp}`;

    try {
      const client = options.client || getRedisClient();
      const { allowed, remaining } = await checkRateLimit(key, windowMs, maxLimit, requestId, client);

      res.setHeader('X-RateLimit-Limit', maxLimit.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());

      if (!allowed) {
        const retryAfterSeconds = Math.ceil(windowMs / 1000);
        res.setHeader('Retry-After', retryAfterSeconds.toString());
        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds`,
            requestId,
          },
        });
        return;
      }

      next();
    } catch (err: unknown) {
      // In case Redis fails, fail closed for rate-sensitive endpoints
      // eslint-disable-next-line no-console
      console.error('[RateLimiter Error]:', err);
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Rate limiting service temporarily unavailable',
          requestId,
        },
      });
    }
  };
}

export const generalRateLimiter = createRateLimiter({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxLimit: env.RATE_LIMIT_MAX,
  keyPrefix: 'ratelimit:general',
});

export const authRateLimiter = createRateLimiter({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  maxLimit: env.AUTH_RATE_LIMIT_MAX,
  keyPrefix: 'ratelimit:auth',
});
