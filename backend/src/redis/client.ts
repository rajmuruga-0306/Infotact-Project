import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load Lua script contents
const rateLimiterLua = readFileSync(resolve(__dirname, 'lua/rateLimiter.lua'), 'utf-8');
const refreshTokenRotateLua = readFileSync(resolve(__dirname, 'lua/refreshTokenRotate.lua'), 'utf-8');
const revokeFamilyLua = readFileSync(resolve(__dirname, 'lua/revokeFamily.lua'), 'utf-8');

let redisInstance: Redis | null = null;

export function setRedisClient(client: Redis | null): void {
  redisInstance = client;
}

/**
 * Returns the singleton Redis client or connects to a custom URL (e.g. for testing).
 */
export function getRedisClient(customUrl?: string): Redis {
  if (customUrl) {
    const client = new Redis(customUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    registerLuaCommands(client);
    return client;
  }

  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => {
        // Exponential backoff, up to 2 seconds
        return Math.min(times * 100, 2000);
      },
    });

    redisInstance.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        // eslint-disable-next-line no-console
        console.error('[Redis Client Error]:', err.message);
      }
    });

    registerLuaCommands(redisInstance);
  }

  return redisInstance;
}

/**
 * Registers custom Lua scripts on the ioredis instance.
 */
function registerLuaCommands(redis: Redis): void {
  redis.defineCommand('rateLimitSlidingWindow', {
    numberOfKeys: 1,
    lua: rateLimiterLua,
  });

  redis.defineCommand('rotateRefreshTokenLua', {
    numberOfKeys: 3,
    lua: refreshTokenRotateLua,
  });

  redis.defineCommand('revokeFamilyLua', {
    numberOfKeys: 2,
    lua: revokeFamilyLua,
  });
}

/**
 * Executes atomic sliding-window rate limit check.
 */
export async function checkRateLimit(
  key: string,
  windowMs: number,
  maxLimit: number,
  requestId: string = Date.now().toString(),
  client: Redis = getRedisClient()
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (client as any).rateLimitSlidingWindow(
    key,
    now.toString(),
    windowMs.toString(),
    maxLimit.toString(),
    requestId
  )) as [number, number];

  return {
    allowed: result[0] === 1,
    remaining: result[1],
  };
}

/**
 * Registers a newly issued refresh token into its family set.
 */
export async function storeInitialRefreshToken(
  tokenHash: string,
  familyId: string,
  data: Record<string, unknown>,
  ttlSeconds: number = 604800, // 7 days default
  client: Redis = getRedisClient()
): Promise<void> {
  const pipeline = client.pipeline();
  const tokenKey = `refresh_token:${tokenHash}`;
  const familyKey = `refresh_family:${familyId}`;

  const payloadWithFamily = { ...data, familyId };
  pipeline.set(tokenKey, JSON.stringify(payloadWithFamily), 'EX', ttlSeconds);
  pipeline.sadd(familyKey, tokenHash);
  pipeline.expire(familyKey, ttlSeconds);

  await pipeline.exec();
}

export type RotateTokenResult =
  | { status: 'OK'; data: Record<string, unknown> }
  | { status: 'REUSE_DETECTED'; familyId: string }
  | { status: 'INVALID_TOKEN' };

/**
 * Atomically rotates a refresh token with tripwire reuse detection.
 */
export async function rotateRefreshToken(
  oldTokenHash: string,
  newTokenHash: string,
  newData: Record<string, unknown>,
  ttlSeconds: number = 604800,
  markerTtlSeconds: number = 300,
  accessRevokeTtlSeconds: number = 900,
  client: Redis = getRedisClient()
): Promise<RotateTokenResult> {
  const oldKey = `refresh_token:${oldTokenHash}`;
  const markerKey = `rotated_token:${oldTokenHash}`;
  const newKey = `refresh_token:${newTokenHash}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (client as any).rotateRefreshTokenLua(
    oldKey,
    markerKey,
    newKey,
    oldTokenHash,
    newTokenHash,
    JSON.stringify(newData),
    ttlSeconds.toString(),
    markerTtlSeconds.toString(),
    accessRevokeTtlSeconds.toString()
  )) as [string, string?];

  const code = result[0];
  if (code === 'OK' && result[1]) {
    return { status: 'OK', data: JSON.parse(result[1]) };
  } else if (code === 'REUSE_DETECTED' && result[1]) {
    return { status: 'REUSE_DETECTED', familyId: result[1] };
  } else {
    return { status: 'INVALID_TOKEN' };
  }
}

/**
 * Atomically revokes an entire refresh token family and marks its access tokens as revoked via Lua.
 */
export async function revokeFamily(
  familyId: string,
  revokeTTLSeconds: number = 900,
  client: Redis = getRedisClient()
): Promise<void> {
  const familyKey = `refresh_family:${familyId}`;
  const revokedKey = `revoked_family:${familyId}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (client as any).revokeFamilyLua(
    familyKey,
    revokedKey,
    'refresh_token:',
    revokeTTLSeconds.toString()
  );
}

/**
 * Checks whether an access token family is revoked (Immediate Logout / Revocation Check).
 * Throws on network/connection failure so authenticate middleware can return a controlled 503.
 */
export async function isFamilyRevoked(
  familyId: string,
  client: Redis = getRedisClient()
): Promise<boolean> {
  const exists = await client.exists(`revoked_family:${familyId}`);
  return exists === 1;
}

/**
 * Closes the singleton Redis client connection.
 */
export async function closeRedisClient(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
