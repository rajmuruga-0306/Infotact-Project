import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { getRedisClient } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load Lua scripts
const lockRenewLua = readFileSync(resolve(__dirname, 'lua/lockRenew.lua'), 'utf-8');
const lockReleaseLua = readFileSync(resolve(__dirname, 'lua/lockRelease.lua'), 'utf-8');

export interface LockAcquisitionResult {
  acquired: boolean;
  token: string;
  key: string;
  ttlMs: number;
}

export interface LockWatchdog {
  key: string;
  token: string;
  isLost: boolean;
  stop: () => void;
}

/**
 * Acquires a distributed lock using Redis SET ... PX ... NX.
 *
 * @param key Redis lock key (e.g. `lock:txn:${orgId}:${idempotencyKey}`)
 * @param ttlMs Lock lease TTL in milliseconds (default: 15,000ms / 15 seconds)
 * @param client ioredis instance
 */
export async function acquireDistributedLock(
  key: string,
  ttlMs: number = 15000,
  client: Redis = getRedisClient()
): Promise<LockAcquisitionResult> {
  const token = randomUUID();
  const result = await client.set(key, token, 'PX', ttlMs, 'NX');

  return {
    acquired: result === 'OK',
    token,
    key,
    ttlMs,
  };
}

/**
 * Starts an active heartbeat watchdog that automatically renews the lock lease
 * every `intervalMs` (default: 1/3 of TTL) using an atomic Lua script.
 * If ownership is lost or renewal fails, marks `isLost = true` and invokes `onLost`.
 */
export function startLockWatchdog(
  key: string,
  token: string,
  ttlMs: number = 15000,
  intervalMs: number = Math.max(Math.floor(ttlMs / 3), 50),
  onLost?: () => void,
  client: Redis = getRedisClient()
): LockWatchdog {
  const watchdog: LockWatchdog = {
    key,
    token,
    isLost: false,
    stop: () => {
      clearInterval(timerId);
    },
  };

  const timerId = setInterval(async () => {
    if (watchdog.isLost) {
      clearInterval(timerId);
      return;
    }

    try {
      // Evaluate atomic renewal script
      const renewed = await client.eval(lockRenewLua, 1, key, token, ttlMs.toString());
      if (renewed !== 1) {
        watchdog.isLost = true;
        clearInterval(timerId);
        // eslint-disable-next-line no-console
        console.warn(`[LockWatchdog]: Lock ownership lost for key '${key}'. Watchdog terminated.`);
        onLost?.();
      }
    } catch (err: unknown) {
      watchdog.isLost = true;
      clearInterval(timerId);
      // eslint-disable-next-line no-console
      console.error(`[LockWatchdog]: Failed to renew lease for key '${key}' due to Redis error:`, err);
      onLost?.();
    }
  }, intervalMs);

  // Prevent watchdog from keeping Node process alive if unref is available
  if (timerId.unref) {
    timerId.unref();
  }

  return watchdog;
}

/**
 * Verifies that the current process still owns the distributed lock in Redis.
 * Checks both local watchdog status and the current key value in Redis.
 */
export async function verifyLockOwnership(
  key: string,
  token: string,
  watchdog?: LockWatchdog,
  client: Redis = getRedisClient()
): Promise<boolean> {
  if (watchdog?.isLost) {
    return false;
  }

  try {
    const currentToken = await client.get(key);
    return currentToken === token;
  } catch {
    return false;
  }
}

/**
 * Atomically releases the distributed lock using a Lua script ensuring that
 * only the lock owner can delete the key. Stops any running watchdog timer.
 */
export async function releaseDistributedLock(
  key: string,
  token: string,
  watchdog?: LockWatchdog,
  client: Redis = getRedisClient()
): Promise<boolean> {
  if (watchdog) {
    watchdog.stop();
  }

  try {
    const result = await client.eval(lockReleaseLua, 1, key, token);
    return result === 1;
  } catch {
    return false;
  }
}

/**
 * Executes a scoped operation within a distributed lock protected by a heartbeat watchdog.
 */
export async function withDistributedLock<T>(
  key: string,
  ttlMs: number = 15000,
  fn: (lockContext: { token: string; watchdog: LockWatchdog }) => Promise<T>,
  client: Redis = getRedisClient()
): Promise<T> {
  const lock = await acquireDistributedLock(key, ttlMs, client);
  if (!lock.acquired) {
    throw new Error(`TRANSACTION_IN_FLIGHT: Another transaction with key '${key}' is currently executing`);
  }

  const watchdog = startLockWatchdog(key, lock.token, ttlMs, Math.max(Math.floor(ttlMs / 3), 50), undefined, client);

  try {
    return await fn({ token: lock.token, watchdog });
  } finally {
    await releaseDistributedLock(key, lock.token, watchdog, client);
  }
}
