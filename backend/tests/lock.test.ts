import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisMemoryServer } from 'redis-memory-server';
import { Redis } from 'ioredis';
import { getRedisClient } from '../src/redis/client.js';
import {
  acquireDistributedLock,
  startLockWatchdog,
  verifyLockOwnership,
  releaseDistributedLock,
  withDistributedLock,
} from '../src/redis/lock.js';

describe('Redis Distributed Lock with Heartbeat Watchdog', () => {
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

  it('enforces mutual exclusion under 20 concurrent lock requests', async () => {
    const lockKey = 'lock:test:concurrency';
    const promises = Array.from({ length: 20 }, () =>
      acquireDistributedLock(lockKey, 5000, client)
    );

    const results = await Promise.all(promises);
    const acquired = results.filter((r) => r.acquired);
    const rejected = results.filter((r) => !r.acquired);

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(19);

    // Clean up
    await releaseDistributedLock(lockKey, acquired[0]!.token, undefined, client);
  });

  it('heartbeat watchdog keeps lock alive beyond initial TTL', async () => {
    const lockKey = 'lock:test:watchdog_renewal';
    const initialTtlMs = 200; // 200ms short lease
    const lock = await acquireDistributedLock(lockKey, initialTtlMs, client);
    expect(lock.acquired).toBe(true);

    // Start watchdog with 60ms renewal interval
    const watchdog = startLockWatchdog(lockKey, lock.token, initialTtlMs, 60, undefined, client);

    // Wait 450ms (longer than the initial 200ms lease)
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Lock must STILL be alive and owned by our token because watchdog renewed it!
    const isStillOwned = await verifyLockOwnership(lockKey, lock.token, watchdog, client);
    expect(isStillOwned).toBe(true);
    expect(watchdog.isLost).toBe(false);

    // Stop and release
    await releaseDistributedLock(lockKey, lock.token, watchdog, client);

    // After release, key must be absent
    const afterToken = await client.get(lockKey);
    expect(afterToken).toBeNull();
  });

  it('detects lock loss and invokes onLost when lock is overwritten or evicted', async () => {
    const lockKey = 'lock:test:loss_detection';
    const lock = await acquireDistributedLock(lockKey, 500, client);
    expect(lock.acquired).toBe(true);

    let onLostCalled = false;
    const watchdog = startLockWatchdog(
      lockKey,
      lock.token,
      500,
      50,
      () => {
        onLostCalled = true;
      },
      client
    );

    // Overwrite the lock key simulating theft / split-brain / admin override
    await client.set(lockKey, 'alien-token-999');

    // Wait for next watchdog tick (approx 80ms)
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(watchdog.isLost).toBe(true);
    expect(onLostCalled).toBe(true);

    // Pre-commit verification must fail!
    const isOwned = await verifyLockOwnership(lockKey, lock.token, watchdog, client);
    expect(isOwned).toBe(false);

    watchdog.stop();
  });

  it('atomic release script only deletes lock if token matches', async () => {
    const lockKey = 'lock:test:safe_release';
    const lock = await acquireDistributedLock(lockKey, 5000, client);

    // Attempt release with wrong token -> fails, lock stays intact
    const releasedWrong = await releaseDistributedLock(lockKey, 'wrong-token', undefined, client);
    expect(releasedWrong).toBe(false);
    expect(await client.get(lockKey)).toBe(lock.token);

    // Release with correct token -> succeeds
    const releasedRight = await releaseDistributedLock(lockKey, lock.token, undefined, client);
    expect(releasedRight).toBe(true);
    expect(await client.get(lockKey)).toBeNull();
  });

  it('withDistributedLock executes scoped operation and cleans up', async () => {
    const lockKey = 'lock:test:scoped_runner';
    let executed = false;

    const result = await withDistributedLock(
      lockKey,
      2000,
      async ({ token, watchdog }) => {
        executed = true;
        const owned = await verifyLockOwnership(lockKey, token, watchdog, client);
        expect(owned).toBe(true);
        return 42;
      },
      client
    );

    expect(executed).toBe(true);
    expect(result).toBe(42);

    // Lock must be released automatically
    expect(await client.get(lockKey)).toBeNull();
  });
});
