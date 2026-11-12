import mongoose, { Connection } from 'mongoose';
import { env } from '../config/env.js';
import { getTenantModels, TenantModels } from '../models/tenant/index.js';

export interface TenantOrgInfo {
  _id: string | { toString(): string };
  dbName: string;
  dbUri?: string;
}

export interface PooledTenantConnection {
  orgId: string;
  dbName: string;
  conn: Connection;
  models: TenantModels;
  lastAccessedAt: number;
  activeOperations: number;
}

export interface TenantConnectionManagerOptions {
  maxConnections?: number;
  idleTimeoutMs?: number;
  baseClusterUri?: string;
}

export class TenantConnectionManager {
  private pool = new Map<string, PooledTenantConnection>();
  private maxConnections: number;
  private idleTimeoutMs: number;
  private baseClusterUri: string;
  private reaperInterval: NodeJS.Timeout | null = null;

  constructor(options: TenantConnectionManagerOptions = {}) {
    this.maxConnections = options.maxConnections || env.MAX_TENANT_CONNECTIONS;
    this.idleTimeoutMs = options.idleTimeoutMs || env.IDLE_CONNECTION_TIMEOUT_MS;
    this.baseClusterUri = options.baseClusterUri || env.MONGODB_URI;

    // Start idle connection reaper every 60 seconds (unref so it doesn't block process exit)
    this.reaperInterval = setInterval(() => {
      this.reapIdleConnections().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[TenantConnectionManager Reaper Error]:', err);
      });
    }, 60000);

    if (this.reaperInterval.unref) {
      this.reaperInterval.unref();
    }
  }

  /**
   * Acquires or creates an isolated MongoDB connection for the given tenant.
   * Updates LRU recency timestamp.
   */
  async acquireConnection(org: TenantOrgInfo): Promise<PooledTenantConnection> {
    const orgId = typeof org._id === 'string' ? org._id : org._id.toString();

    // 1. If connection exists in pool, refresh LRU and increment active operations
    const existing = this.pool.get(orgId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      existing.activeOperations++;
      // Re-insert into Map to maintain insertion-order LRU
      this.pool.delete(orgId);
      this.pool.set(orgId, existing);
      return existing;
    }

    // 2. If pool is saturated, evict the least recently used idle connection
    if (this.pool.size >= this.maxConnections) {
      await this.evictLruConnection();
    }

    // 3. Connect to tenant database
    const targetUri = org.dbUri || this.baseClusterUri;
    const conn = mongoose.createConnection(targetUri, {
      dbName: org.dbName,
      maxPoolSize: 5,
      minPoolSize: 0,
      autoIndex: true,
      serverSelectionTimeoutMS: 10000,
    });

    // Await connection readiness
    await conn.asPromise();

    // 4. Initialize tenant models bound to this connection
    const models = getTenantModels(conn);
    await models.initializeAccounts();

    const pooled: PooledTenantConnection = {
      orgId,
      dbName: org.dbName,
      conn,
      models,
      lastAccessedAt: Date.now(),
      activeOperations: 1,
    };

    this.pool.set(orgId, pooled);
    return pooled;
  }

  /**
   * Decrements active in-flight operation counter for a tenant connection.
   */
  releaseConnection(orgId: string): void {
    const pooled = this.pool.get(orgId);
    if (pooled && pooled.activeOperations > 0) {
      pooled.activeOperations--;
      pooled.lastAccessedAt = Date.now();
    }
  }

  /**
   * Executes a scoped operation with an automatically acquired and released tenant connection.
   */
  async withTenant<T>(
    org: TenantOrgInfo,
    operation: (conn: Connection, models: TenantModels) => Promise<T>
  ): Promise<T> {
    const pooled = await this.acquireConnection(org);
    try {
      return await operation(pooled.conn, pooled.models);
    } finally {
      this.releaseConnection(pooled.orgId);
    }
  }

  /**
   * Evicts the least recently used idle connection (activeOperations === 0).
   */
  private async evictLruConnection(): Promise<boolean> {
    let lruKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [orgId, entry] of this.pool.entries()) {
      if (entry.activeOperations === 0 && entry.lastAccessedAt < oldestTimestamp) {
        oldestTimestamp = entry.lastAccessedAt;
        lruKey = orgId;
      }
    }

    if (!lruKey) {
      // All connections are busy; cannot evict idle connection
      return false;
    }

    const entryToClose = this.pool.get(lruKey);
    if (entryToClose) {
      this.pool.delete(lruKey);
      await entryToClose.conn.close();
      return true;
    }

    return false;
  }

  /**
   * Closes connections that have been idle longer than idleTimeoutMs.
   */
  async reapIdleConnections(): Promise<number> {
    const now = Date.now();
    const toReap: string[] = [];

    for (const [orgId, entry] of this.pool.entries()) {
      if (entry.activeOperations === 0 && now - entry.lastAccessedAt > this.idleTimeoutMs) {
        toReap.push(orgId);
      }
    }

    for (const orgId of toReap) {
      const entry = this.pool.get(orgId);
      if (entry) {
        this.pool.delete(orgId);
        await entry.conn.close();
      }
    }

    return toReap.length;
  }

  /**
   * Returns current connection pool statistics.
   */
  getPoolStats(): {
    size: number;
    maxConnections: number;
    tenantIds: string[];
    busyConnections: number;
  } {
    let busyCount = 0;
    for (const entry of this.pool.values()) {
      if (entry.activeOperations > 0) {
        busyCount++;
      }
    }

    return {
      size: this.pool.size,
      maxConnections: this.maxConnections,
      tenantIds: Array.from(this.pool.keys()),
      busyConnections: busyCount,
    };
  }

  /**
   * Manually closes a specific tenant connection.
   */
  async closeConnection(orgId: string): Promise<void> {
    const entry = this.pool.get(orgId);
    if (entry) {
      this.pool.delete(orgId);
      await entry.conn.close();
    }
  }

  /**
   * Closes all active tenant connections and stops the idle reaper.
   */
  async closeAll(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    const closePromises = Array.from(this.pool.values()).map((entry) => entry.conn.close());
    this.pool.clear();
    await Promise.all(closePromises);
  }
}

// Export singleton tenant connection manager
export const tenantConnectionManager = new TenantConnectionManager();
