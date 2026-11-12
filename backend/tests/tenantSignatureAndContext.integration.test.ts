import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';
import mongoose, { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import { generateKeyPairSync } from 'node:crypto';
import { getControlModels, ControlModels, setControlDbConnection } from '../src/models/control/index.js';
import { getRedisClient, setRedisClient } from '../src/redis/client.js';
import {
  TenantConnectionManager,
  createTenantContextMiddleware,
} from '../src/tenancy/index.js';
import {
  createVerifyTenantSignatureMiddleware,
  signTenantRequest,
} from '../src/gateway/verifyTenantSignature.js';

describe('Tenant Request Signing & Multi-Tenant Isolation Integration Tests', () => {
  let mongoServer: MongoMemoryServer;
  let redisServer: RedisMemoryServer;
  let controlConn: Connection;
  let redisClient: Redis;
  let controlModels: ControlModels;
  let connectionManager: TenantConnectionManager;
  let app: Express;

  // Generate tenant 1 RSA keypair
  const tenant1Keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Generate tenant 2 RSA keypair
  const tenant2Keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let tenant1OrgId: string;
  let tenant2OrgId: string;

  beforeAll(async () => {
    // 1. In-memory Mongo and Redis
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    controlConn = mongoose.createConnection(mongoUri, { autoIndex: true });
    setControlDbConnection(controlConn);
    controlModels = getControlModels(controlConn);

    await Promise.all([
      controlModels.Organization.init(),
      controlModels.User.init(),
      controlModels.OrganizationMembership.init(),
      controlModels.PlatformAuditLog.init(),
    ]);

    redisServer = new RedisMemoryServer();
    const redisHost = await redisServer.getHost();
    const redisPort = await redisServer.getPort();
    redisClient = getRedisClient(`redis://${redisHost}:${redisPort}`);
    setRedisClient(redisClient);

    // 2. Create Tenant 1 and Tenant 2 Organizations in control DB
    const org1 = await controlModels.Organization.create({
      name: 'Acme Corp',
      slug: 'acme-corp',
      dbName: 'lg_tenant_acme_corp',
      publicKeyPem: tenant1Keys.publicKey,
      keyId: 'key_acme_1',
      status: 'ACTIVE',
    });
    tenant1OrgId = org1._id.toString();

    const org2 = await controlModels.Organization.create({
      name: 'Beta Labs',
      slug: 'beta-labs',
      dbName: 'lg_tenant_beta_labs',
      publicKeyPem: tenant2Keys.publicKey,
      keyId: 'key_beta_1',
      status: 'ACTIVE',
    });
    tenant2OrgId = org2._id.toString();

    // 3. Setup Tenant Connection Manager
    connectionManager = new TenantConnectionManager({
      maxConnections: 5,
      idleTimeoutMs: 60000,
      baseClusterUri: mongoUri,
    });

    const tenantContextMiddleware = createTenantContextMiddleware({
      connectionManager,
      controlDbConn: controlConn,
    });

    const verifySignatureMiddleware = createVerifyTenantSignatureMiddleware({
      redisClient,
      maxClockSkewMs: 300000, // 5 minutes
    });

    // 4. Test Express App
    app = express();
    app.use(
      express.json({
        verify: (req: Request, _res: Response, buf: Buffer) => {
          req.rawBody = buf;
        },
      })
    );

    // Simulated auth injects active orgId from test header
    app.use((req: Request, _res: Response, next) => {
      const authOrgId = req.headers['x-test-org-id'] as string;
      if (authOrgId) {
        req.auth = {
          userId: 'test_user_1',
          orgId: authOrgId,
          role: 'ORG_ADMIN',
          email: 'test@tenant.com',
          familyId: 'fam_1',
        };
      }
      next();
    });

    // Protected Tenant Route: requires tenantContext + verifyTenantSignature
    app.post(
      '/api/v1/tenant/action',
      tenantContextMiddleware,
      verifySignatureMiddleware,
      async (req: Request, res: Response) => {
        const models = req.tenant!.models;
        const body = req.body;

        // Perform a tenant-isolated database write
        const record = await models.UsageRecord.create({
          resource: body.resource || 'api_test',
          units: body.units || 1,
          costMinor: body.costMinor || 100,
        });

        res.status(200).json({
          status: 'ok',
          orgSlug: req.tenant!.org.slug,
          dbName: req.tenant!.dbConn.name,
          recordId: record._id.toString(),
        });
      }
    );
  }, 60000);

  afterAll(async () => {
    setControlDbConnection(null);
    setRedisClient(null);
    await connectionManager.closeAll();
    await controlConn.close();
    await mongoServer.stop();
    await redisClient.quit();
    await redisServer.stop();
  });

  describe('1. Cryptographic Tenant Request Signing', () => {
    it('verifies valid RSA-SHA256 signature and executes tenant operation', async () => {
      const payload = { resource: 'compute_units', units: 5, costMinor: 500 };
      const path = '/api/v1/tenant/action';

      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload,
      });

      const res = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.orgSlug).toBe('acme-corp');
      expect(res.body.dbName).toBe('lg_tenant_acme_corp');
    });

    it('rejects tampered request payload with 401 INVALID_SIGNATURE', async () => {
      const payload = { resource: 'compute_units', units: 5, costMinor: 500 };
      const path = '/api/v1/tenant/action';

      // Sign legitimate payload
      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload,
      });

      // Attacker tampers with body (e.g. units 5 -> 500)
      const tamperedPayload = { ...payload, units: 500 };

      const res = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(tamperedPayload);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });

    it('blocks replay attack when identical nonce is reused within active window', async () => {
      const payload = { resource: 'api_calls', units: 1, costMinor: 10 };
      const path = '/api/v1/tenant/action';

      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload,
        nonce: 'replayed_nonce_12345',
      });

      // First request: valid
      const res1 = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);
      expect(res1.status).toBe(200);

      // Second replayed request: blocked by Redis nonce deduplication
      const res2 = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);

      expect(res2.status).toBe(401);
      expect(res2.body.error.code).toBe('REPLAY_ATTACK_DETECTED');
    });

    it('rejects request with expired or skewed timestamp (> 300s)', async () => {
      const payload = { resource: 'api_calls', units: 1, costMinor: 10 };
      const path = '/api/v1/tenant/action';

      // Timestamp from 10 minutes ago
      const staleTimestamp = Date.now() - 600000;

      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload,
        timestamp: staleTimestamp,
      });

      const res = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TIMESTAMP_EXPIRED');
    });

    it('rejects unknown keyId that does not match tenant organization keyId', async () => {
      const payload = { resource: 'api_calls', units: 1, costMinor: 10 };
      const path = '/api/v1/tenant/action';

      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'wrong_unregistered_key',
        method: 'POST',
        path,
        body: payload,
      });

      const res = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNKNOWN_KEY_ID');
    });

    it('rejects request signed by tenant2 key when requesting tenant1 organization', async () => {
      const payload = { resource: 'api_calls', units: 1, costMinor: 10 };
      const path = '/api/v1/tenant/action';

      // Tenant 2 signs with tenant 2 private key, but sets tenant1's keyId
      const sigHeaders = signTenantRequest({
        privateKeyPem: tenant2Keys.privateKey, // Wrong key!
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload,
      });

      const res = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sigHeaders)
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('2. Multi-Tenant Database Isolation', () => {
    it('strictly isolates tenant data across discrete database connections', async () => {
      const path = '/api/v1/tenant/action';

      // 1. Tenant 1 writes record
      const payload1 = { resource: 'acme_private_data', units: 10, costMinor: 1000 };
      const sig1 = signTenantRequest({
        privateKeyPem: tenant1Keys.privateKey,
        keyId: 'key_acme_1',
        method: 'POST',
        path,
        body: payload1,
      });

      const res1 = await request(app)
        .post(path)
        .set('x-test-org-id', tenant1OrgId)
        .set(sig1)
        .send(payload1);

      expect(res1.status).toBe(200);
      expect(res1.body.dbName).toBe('lg_tenant_acme_corp');

      // 2. Tenant 2 writes record
      const payload2 = { resource: 'beta_private_data', units: 20, costMinor: 2000 };
      const sig2 = signTenantRequest({
        privateKeyPem: tenant2Keys.privateKey,
        keyId: 'key_beta_1',
        method: 'POST',
        path,
        body: payload2,
      });

      const res2 = await request(app)
        .post(path)
        .set('x-test-org-id', tenant2OrgId)
        .set(sig2)
        .send(payload2);

      expect(res2.status).toBe(200);
      expect(res2.body.dbName).toBe('lg_tenant_beta_labs');

      // 3. Verify physical database isolation directly via connectionManager
      const acmeConn = await connectionManager.acquireConnection({
        _id: tenant1OrgId,
        dbName: 'lg_tenant_acme_corp',
      });
      const betaConn = await connectionManager.acquireConnection({
        _id: tenant2OrgId,
        dbName: 'lg_tenant_beta_labs',
      });

      // Acme database should have acme_private_data, but NEVER beta_private_data
      const acmeRecords = await acmeConn.models.UsageRecord.find();
      expect(acmeRecords.some((r) => r.resource === 'acme_private_data')).toBe(true);
      expect(acmeRecords.some((r) => r.resource === 'beta_private_data')).toBe(false);

      // Beta database should have beta_private_data, but NEVER acme_private_data
      const betaRecords = await betaConn.models.UsageRecord.find();
      expect(betaRecords.some((r) => r.resource === 'beta_private_data')).toBe(true);
      expect(betaRecords.some((r) => r.resource === 'acme_private_data')).toBe(false);

      connectionManager.releaseConnection(tenant1OrgId);
      connectionManager.releaseConnection(tenant2OrgId);
    });
  });
});
