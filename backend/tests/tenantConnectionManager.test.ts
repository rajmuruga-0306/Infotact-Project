import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TenantConnectionManager } from '../src/tenancy/tenantConnectionManager.js';

describe('Dynamic Tenant Connection Manager Unit Tests', () => {
  let mongoServer: MongoMemoryServer;
  let baseUri: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    baseUri = mongoServer.getUri();
  }, 30000);

  afterAll(async () => {
    await mongoServer.stop();
  });

  it('acquires connection, auto-initializes accounts, and reuses pooled connection', async () => {
    const manager = new TenantConnectionManager({
      maxConnections: 5,
      idleTimeoutMs: 60000,
      baseClusterUri: baseUri,
    });

    const org1 = { _id: 'org_alpha', dbName: 'lg_tenant_org_alpha' };

    // First acquisition
    const conn1 = await manager.acquireConnection(org1);
    expect(conn1.orgId).toBe('org_alpha');
    expect(conn1.dbName).toBe('lg_tenant_org_alpha');
    expect(conn1.activeOperations).toBe(1);

    // Verify accounts were automatically initialized
    const primary = await conn1.models.Account.findOne({ accountRef: 'PRIMARY' });
    expect(primary).not.toBeNull();
    expect(primary!.balanceMinor).toBe(0n);

    manager.releaseConnection(org1._id);
    expect(conn1.activeOperations).toBe(0);

    // Second acquisition should reuse existing connection
    const conn1Again = await manager.acquireConnection(org1);
    expect(conn1Again.conn).toBe(conn1.conn);
    manager.releaseConnection(org1._id);

    await manager.closeAll();
  });

  it('enforces max connection bounds and performs LRU eviction on idle connections', async () => {
    // Manager bounded to max 2 connections
    const manager = new TenantConnectionManager({
      maxConnections: 2,
      idleTimeoutMs: 60000,
      baseClusterUri: baseUri,
    });

    const org1 = { _id: 'org_1', dbName: 'lg_tenant_org_1' };
    const org2 = { _id: 'org_2', dbName: 'lg_tenant_org_2' };
    const org3 = { _id: 'org_3', dbName: 'lg_tenant_org_3' };

    // Acquire and release org1
    await manager.acquireConnection(org1);
    manager.releaseConnection(org1._id);

    // Small delay to ensure timestamp separation
    await new Promise((r) => setTimeout(r, 10));

    // Acquire and release org2
    await manager.acquireConnection(org2);
    manager.releaseConnection(org2._id);

    let stats = manager.getPoolStats();
    expect(stats.size).toBe(2);
    expect(stats.tenantIds).toEqual(['org_1', 'org_2']);

    // Small delay to ensure timestamp separation
    await new Promise((r) => setTimeout(r, 10));

    // Acquire org3 -> should evict org1 (the least recently used)
    await manager.acquireConnection(org3);
    manager.releaseConnection(org3._id);

    stats = manager.getPoolStats();
    expect(stats.size).toBe(2);
    expect(stats.tenantIds).toContain('org_2');
    expect(stats.tenantIds).toContain('org_3');
    expect(stats.tenantIds).not.toContain('org_1');

    await manager.closeAll();
  });

  it('does NOT evict active in-flight connections during LRU eviction', async () => {
    const manager = new TenantConnectionManager({
      maxConnections: 2,
      idleTimeoutMs: 60000,
      baseClusterUri: baseUri,
    });

    const org1 = { _id: 'org_busy', dbName: 'lg_tenant_org_busy' };
    const org2 = { _id: 'org_idle', dbName: 'lg_tenant_org_idle' };
    const org3 = { _id: 'org_new', dbName: 'lg_tenant_org_new' };

    // org1 acquired first (older timestamp), but NOT released (activeOperations = 1)
    await manager.acquireConnection(org1);

    // org2 acquired second, and released (activeOperations = 0)
    await manager.acquireConnection(org2);
    manager.releaseConnection(org2._id);

    // Now acquire org3: even though org1 is older, org1 is busy, so org2 must be evicted!
    await manager.acquireConnection(org3);
    manager.releaseConnection(org3._id);

    const stats = manager.getPoolStats();
    expect(stats.size).toBe(2);
    expect(stats.tenantIds).toContain('org_busy');
    expect(stats.tenantIds).toContain('org_new');
    expect(stats.tenantIds).not.toContain('org_idle');

    manager.releaseConnection(org1._id);
    await manager.closeAll();
  });

  it('reaps idle connections older than idleTimeoutMs', async () => {
    const manager = new TenantConnectionManager({
      maxConnections: 5,
      idleTimeoutMs: 50, // 50ms idle threshold for testing
      baseClusterUri: baseUri,
    });

    const org1 = { _id: 'org_short_lived', dbName: 'lg_tenant_org_short_lived' };
    await manager.acquireConnection(org1);
    manager.releaseConnection(org1._id);

    expect(manager.getPoolStats().size).toBe(1);

    // Wait 70ms so connection becomes idle
    await new Promise((r) => setTimeout(r, 70));

    const reapedCount = await manager.reapIdleConnections();
    expect(reapedCount).toBe(1);
    expect(manager.getPoolStats().size).toBe(0);

    await manager.closeAll();
  });

  it('executes scoped operation via withTenant and auto-releases connection', async () => {
    const manager = new TenantConnectionManager({
      maxConnections: 5,
      idleTimeoutMs: 60000,
      baseClusterUri: baseUri,
    });

    const org = { _id: 'org_scoped', dbName: 'lg_tenant_org_scoped' };

    const result = await manager.withTenant(org, async (_conn, models) => {
      expect(manager.getPoolStats().busyConnections).toBe(1);
      return await models.Account.findOne({ accountRef: 'PRIMARY' });
    });

    expect(result).not.toBeNull();
    expect(manager.getPoolStats().busyConnections).toBe(0);

    await manager.closeAll();
  });
});
