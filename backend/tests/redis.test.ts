import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisMemoryServer } from 'redis-memory-server';
import { Redis } from 'ioredis';
import {
  getRedisClient,
  checkRateLimit,
  storeInitialRefreshToken,
  rotateRefreshToken,
  revokeFamily,
  isFamilyRevoked,
} from '../src/redis/client.js';

describe('Real Redis Client & Atomic Lua Scripts', () => {
  let redisServer: RedisMemoryServer;
  let client: Redis;

  beforeAll(async () => {
    redisServer = new RedisMemoryServer();
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    client = getRedisClient(`redis://${host}:${port}`);
  });

  afterAll(async () => {
    await client.quit();
    await redisServer.stop();
  });

  describe('Atomic Sliding-Window Rate Limiter (rateLimiter.lua)', () => {
    it('allows requests within limit and tracks remaining quota', async () => {
      const key = 'ratelimit:test:ip1';
      const windowMs = 5000;
      const limit = 3;

      const r1 = await checkRateLimit(key, windowMs, limit, 'req1', client);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = await checkRateLimit(key, windowMs, limit, 'req2', client);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await checkRateLimit(key, windowMs, limit, 'req3', client);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // Exceeded
      const r4 = await checkRateLimit(key, windowMs, limit, 'req4', client);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it('enforces limit atomically under 20 concurrent requests', async () => {
      const key = 'ratelimit:test:concurrency';
      const windowMs = 5000;
      const limit = 5;

      const promises = Array.from({ length: 20 }, (_, i) =>
        checkRateLimit(key, windowMs, limit, `concurrent_req_${i}`, client)
      );

      const results = await Promise.all(promises);
      const allowedCount = results.filter((r) => r.allowed).length;
      const blockedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(5);
      expect(blockedCount).toBe(15);
    });
  });

  describe('Refresh Token Rotation & Tripwire Reuse Detection (refreshTokenRotate.lua)', () => {
    it('successfully stores and rotates a refresh token', async () => {
      const familyId = 'fam_legit_100';
      const token1 = 'hash_token_1';
      const token2 = 'hash_token_2';
      const sessionData = { userId: 'usr_1', orgId: 'org_1', role: 'ORG_ADMIN' };

      // 1. Initial store
      await storeInitialRefreshToken(token1, familyId, sessionData, 3600, client);

      // Verify token exists in family set
      const tokens = await client.smembers(`refresh_family:${familyId}`);
      expect(tokens).toContain(token1);

      // 2. Legitimate rotation
      const rotateResult = await rotateRefreshToken(
        token1,
        token2,
        sessionData,
        3600,
        300,
        900,
        client
      );

      expect(rotateResult.status).toBe('OK');
      if (rotateResult.status === 'OK') {
        expect(rotateResult.data.userId).toBe('usr_1');
      }

      // Verify old token is gone, new token is in family
      const updatedTokens = await client.smembers(`refresh_family:${familyId}`);
      expect(updatedTokens).not.toContain(token1);
      expect(updatedTokens).toContain(token2);
    });

    it('trips reuse detection when an old token is replayed and revokes family', async () => {
      const familyId = 'fam_theft_200';
      const tokenA = 'hash_token_a';
      const tokenB = 'hash_token_b';
      const tokenC = 'hash_token_c';
      const sessionData = { userId: 'usr_2', orgId: 'org_2' };

      // 1. Store initial token
      await storeInitialRefreshToken(tokenA, familyId, sessionData, 3600, client);

      // 2. Legitimate user rotates tokenA -> tokenB
      const rot1 = await rotateRefreshToken(tokenA, tokenB, sessionData, 3600, 300, 900, client);
      expect(rot1.status).toBe('OK');

      // 3. Attacker replays tokenA!
      const rotReplay = await rotateRefreshToken(tokenA, tokenC, sessionData, 3600, 300, 900, client);
      expect(rotReplay.status).toBe('REUSE_DETECTED');
      if (rotReplay.status === 'REUSE_DETECTED') {
        expect(rotReplay.familyId).toBe(familyId);
      }

      // 4. Verify entire family is wiped and blacklisted
      const activeFamilyTokens = await client.smembers(`refresh_family:${familyId}`);
      expect(activeFamilyTokens).toHaveLength(0);

      const activeTokenB = await client.get(`refresh_token:${tokenB}`);
      expect(activeTokenB).toBeNull();

      // 5. Verify family is revoked
      const revoked = await isFamilyRevoked(familyId, client);
      expect(revoked).toBe(true);
    });

    it('explicit logout revokes family and access tokens immediately', async () => {
      const familyId = 'fam_logout_300';
      const token = 'hash_token_logout';
      await storeInitialRefreshToken(token, familyId, { userId: 'usr_3' }, 3600, client);

      expect(await isFamilyRevoked(familyId, client)).toBe(false);

      await revokeFamily(familyId, 900, client);

      expect(await isFamilyRevoked(familyId, client)).toBe(true);
      expect(await client.get(`refresh_token:${token}`)).toBeNull();
    });

    it('fails closed when Redis is unreachable during revocation check', async () => {
      // Disconnected client that fails immediately without retrying
      const brokenClient = new Redis({
        host: '127.0.0.1',
        port: 1,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        connectTimeout: 200,
        lazyConnect: true,
      });
      brokenClient.on('error', () => {}); // silence connection error output

      const revoked = await isFamilyRevoked('any_family', brokenClient);
      expect(revoked).toBe(true); // Must fail closed!

      brokenClient.disconnect();
    });
  });
});
