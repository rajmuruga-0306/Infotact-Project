import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import mongoose, { Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';
import { Redis } from 'ioredis';
import { VIRTUAL_CLEARING_ACCOUNT } from '@ledgerguard/shared';
import {
  setControlDbConnection,
  getControlModels,
  ControlModels,
} from '../src/models/control/index.js';
import { getTenantModels, TenantModels } from '../src/models/tenant/index.js';
import { TenantConnectionManager } from '../src/tenancy/tenantConnectionManager.js';
import { getRedisClient, setRedisClient } from '../src/redis/client.js';
import { JwtService } from '../src/gateway/jwt/jwtService.js';
import { createAuthenticateMiddleware } from '../src/gateway/authenticate.js';
import { createTenantContextMiddleware } from '../src/tenancy/tenantContext.js';
import {
  createVerifyTenantSignatureMiddleware,
  signTenantRequest,
} from '../src/gateway/verifyTenantSignature.js';
import { LedgerService } from '../src/modules/ledger/ledgerService.js';
import { UsageService } from '../src/modules/usage/usageService.js';
import { UsageController } from '../src/modules/usage/usageController.js';
import { defaultPricingEngine } from '../src/modules/usage/pricingEngine.js';

describe('Usage Metering, Aggregation & Tiered Billing Integration Tests (Phase 5 Gate)', () => {
  let replSet: MongoMemoryReplSet;
  let redisServer: RedisMemoryServer;
  let redisClient: Redis;
  let controlConn: Connection;
  let tenantConn: Connection;
  let controlModels: ControlModels;
  let tenantModels: TenantModels;
  let connectionManager: TenantConnectionManager;
  let jwtService: JwtService;
  let ledgerService: LedgerService;
  let usageService: UsageService;
  let usageController: UsageController;
  let app: Express;

  // Active Gateway RS256 Keypair
  const gatewayKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Tenant Alpha RSA-2048 Keypair
  const tenantAlphaKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Tenant Beta RSA-2048 Keypair
  const tenantBetaKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let tenantAlphaOrgId: string;
  let tenantAlphaUserId: string;
  let validAlphaAccessToken: string;

  let tenantBetaOrgId: string;
  let tenantBetaUserId: string;
  let validBetaAccessToken: string;
  let tenantBetaConn: Connection;

  beforeAll(async () => {
    // 1. In-memory MongoDB Replica Set
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const replSetUri = replSet.getUri();

    controlConn = mongoose.createConnection(replSetUri, { autoIndex: true });
    setControlDbConnection(controlConn);
    controlModels = getControlModels(controlConn);

    await Promise.all([
      controlModels.Organization.init(),
      controlModels.User.init(),
      controlModels.OrganizationMembership.init(),
      controlModels.PlatformAuditLog.init(),
    ]);

    // 2. Real Redis Server
    redisServer = new RedisMemoryServer();
    const redisHost = await redisServer.getHost();
    const redisPort = await redisServer.getPort();
    redisClient = getRedisClient(`redis://${redisHost}:${redisPort}`);
    setRedisClient(redisClient);

    // 3. JWT Service
    jwtService = new JwtService({
      keyId: 'key-gateway-1',
      privateKeyPem: gatewayKeys.privateKey,
      publicKeys: {
        'key-gateway-1': gatewayKeys.publicKey,
      },
    });

    // 4. Create Tenant Alpha Organization and User
    const orgAlpha = await controlModels.Organization.create({
      name: 'Alpha Cloud Corp',
      slug: 'alpha-cloud',
      dbName: 'lg_tenant_alpha_cloud',
      publicKeyPem: tenantAlphaKeys.publicKey,
      keyId: 'key_alpha_1',
      status: 'ACTIVE',
    });
    tenantAlphaOrgId = orgAlpha._id.toString();

    const userAlpha = await controlModels.User.create({
      email: 'admin@alpha-cloud.com',
      passwordHash: 'hashed_pw',
      fullName: 'Alpha Admin',
    });
    tenantAlphaUserId = userAlpha._id.toString();

    await controlModels.OrganizationMembership.create({
      userId: userAlpha._id,
      orgId: orgAlpha._id,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
    });

    // 5. Create Tenant Beta Organization and User
    const orgBeta = await controlModels.Organization.create({
      name: 'Beta Labs Corp',
      slug: 'beta-labs',
      dbName: 'lg_tenant_beta_labs',
      publicKeyPem: tenantBetaKeys.publicKey,
      keyId: 'key_beta_1',
      status: 'ACTIVE',
    });
    tenantBetaOrgId = orgBeta._id.toString();

    const userBeta = await controlModels.User.create({
      email: 'admin@beta-labs.com',
      passwordHash: 'hashed_pw',
      fullName: 'Beta Admin',
    });
    tenantBetaUserId = userBeta._id.toString();

    await controlModels.OrganizationMembership.create({
      userId: userBeta._id,
      orgId: orgBeta._id,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
    });

    // 6. Pre-connect and initialize tenant databases
    tenantConn = mongoose.createConnection(replSetUri, {
      dbName: orgAlpha.dbName,
      autoIndex: true,
    });
    await tenantConn.asPromise();

    tenantModels = getTenantModels(tenantConn);
    await Promise.all([
      tenantModels.Account.init(),
      tenantModels.Transaction.init(),
      tenantModels.LedgerEntry.init(),
      tenantModels.UsageRecord.init(),
      tenantModels.TenantAuditLog.init(),
      tenantModels.initializeAccounts('USD', 50000n, 1000000n), // 500.00 credit limit, 10,000.00 monthly limit
    ]);

    tenantBetaConn = mongoose.createConnection(replSetUri, {
      dbName: orgBeta.dbName,
      autoIndex: true,
    });
    await tenantBetaConn.asPromise();
    const betaModels = getTenantModels(tenantBetaConn);
    await Promise.all([
      betaModels.Account.init(),
      betaModels.Transaction.init(),
      betaModels.LedgerEntry.init(),
      betaModels.UsageRecord.init(),
      betaModels.TenantAuditLog.init(),
      betaModels.initializeAccounts('USD', 50000n, 1000000n),
    ]);

    // 7. Tenant Connection Manager
    connectionManager = new TenantConnectionManager({
      baseClusterUri: replSetUri,
      maxConnections: 10,
    });

    // 8. Services & Controller
    ledgerService = new LedgerService();
    usageService = new UsageService(defaultPricingEngine, ledgerService);
    usageController = new UsageController(usageService, redisClient);

    // 9. Express Test App
    app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.requestId = 'req_usage_test';
      next();
    });
    app.use(
      express.json({
        verify: (req: Request, _res: Response, buf: Buffer) => {
          req.rawBody = buf;
        },
      })
    );

    const authenticate = createAuthenticateMiddleware(jwtService, redisClient);
    const tenantContext = createTenantContextMiddleware({
      connectionManager,
      controlDbConn: controlConn,
    });
    const verifySignature = createVerifyTenantSignatureMiddleware({ redisClient });

    const router = express.Router();
    router.use(authenticate);
    router.use(tenantContext);
    router.use(verifySignature);

    router.post('/record', usageController.recordUsage);
    router.post('/batch', usageController.recordUsageBatch);
    router.post('/aggregate-and-settle', usageController.aggregateAndSettle);
    router.get('/analytics', usageController.getAnalytics);
    router.get('/records', usageController.getUsageRecords);
    router.get('/pricing-plans', usageController.getPricingPlans);
    router.get('/audit-logs', usageController.getTenantAuditLogs);

    app.use('/api/v1/usage', router);

    // 10. Issue Tokens
    validAlphaAccessToken = jwtService.signAccessToken({
      userId: tenantAlphaUserId,
      orgId: tenantAlphaOrgId,
      role: 'ORG_ADMIN',
      email: 'admin@alpha-cloud.com',
      familyId: 'fam_usage_alpha',
    });

    validBetaAccessToken = jwtService.signAccessToken({
      userId: tenantBetaUserId,
      orgId: tenantBetaOrgId,
      role: 'ORG_ADMIN',
      email: 'admin@beta-labs.com',
      familyId: 'fam_usage_beta',
    });
  }, 40000);

  afterAll(async () => {
    if (tenantConn) await tenantConn.close();
    if (tenantBetaConn) await tenantBetaConn.close();
    if (connectionManager) await connectionManager.closeAll();
    if (controlConn) await controlConn.close();
    if (redisClient) await redisClient.quit();
    if (redisServer) await redisServer.stop();
    if (replSet) await replSet.stop();
  });

  function signRequestAlpha(method: string, path: string, body?: unknown) {
    const rawBody = body !== undefined ? JSON.stringify(body) : '';
    return signTenantRequest({
      privateKeyPem: tenantAlphaKeys.privateKey,
      keyId: 'key_alpha_1',
      method,
      path,
      body: rawBody,
    });
  }

  function signRequestBeta(method: string, path: string, body?: unknown) {
    const rawBody = body !== undefined ? JSON.stringify(body) : '';
    return signTenantRequest({
      privateKeyPem: tenantBetaKeys.privateKey,
      keyId: 'key_beta_1',
      method,
      path,
      body: rawBody,
    });
  }

  describe('1. Single Usage Recording & Immediate Ledger Settlement', () => {
    it('meters usage, applies Tier 0 pricing, and immediately posts a balanced double-entry charge', async () => {
      const path = '/api/v1/usage/record';
      const body = {
        resource: 'api_calls',
        units: 500, // In Tier 0 (0 to 1,000) @ 5 minor units = 2,500 minor units ($25.00)
        idempotencyKey: 'meter_rec_001',
        settleImmediately: true,
      };
      const headers = signRequestAlpha('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.usageRecord).toBeDefined();
      expect(res.body.usageRecord.resource).toBe('api_calls');
      expect(res.body.usageRecord.units).toBe(500);
      expect(res.body.usageRecord.costMinor).toBe(2500);
      expect(res.body.usageRecord.billed).toBe(true);
      expect(res.body.usageRecord.transactionId).toBeDefined();

      expect(res.body.transaction).toBeDefined();
      expect(res.body.transaction.status).toBe('POSTED');
      expect(res.body.transaction.amountMinor).toBe(2500);

      // Verify Account Balance in Tenant Database
      const primaryAcc = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAcc!.balanceMinor).toBe(-2500n);

      const clearingAcc = await tenantModels.Account.findOne({ accountRef: VIRTUAL_CLEARING_ACCOUNT });
      expect(clearingAcc!.balanceMinor).toBe(2500n);

      // Verify double-entry balancing invariant
      expect(primaryAcc!.balanceMinor + clearingAcc!.balanceMinor).toBe(0n);
    });
  });

  describe('2. Cumulative Monthly Progression Across Tier Boundaries', () => {
    it('seamlessly transitions into Tier 1 based on cumulative monthly consumption', async () => {
      // Prior usage this month is 500 units.
      // New usage: 1,000 units. Cumulative total will be 1,500.
      // Next 500 units in Tier 0 (500 to 1,000) @ 5 = 2,500 cents
      // Next 500 units in Tier 1 (1,000 to 1,500) @ 3 = 1,500 cents
      // Total cost = 4,000 cents ($40.00)
      const path = '/api/v1/usage/record';
      const body = {
        resource: 'api_calls',
        units: 1000,
        idempotencyKey: 'meter_rec_002',
        settleImmediately: true,
      };
      const headers = signRequestAlpha('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.usageRecord.costMinor).toBe(4000);
      expect(res.body.transaction.amountMinor).toBe(4000);

      // Account balance decreases by 4,000: from -2,500 to -6,500
      const primaryAcc = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAcc!.balanceMinor).toBe(-6500n);
    });
  });

  describe('3. Idempotent Replay Protection', () => {
    it('returns existing usage record and transaction without double-charging on identical replay', async () => {
      const primaryBefore = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      const balanceBefore = primaryBefore!.balanceMinor;

      const path = '/api/v1/usage/record';
      const body = {
        resource: 'api_calls',
        units: 1000,
        idempotencyKey: 'meter_rec_002', // Re-using key from test 2
        settleImmediately: true,
      };
      const headers = signRequestAlpha('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.usageRecord.idempotencyKey).toBe('meter_rec_002');

      // Balance must NOT be deducted again
      const primaryAfter = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAfter!.balanceMinor).toBe(balanceBefore);
    });
  });

  describe('4. Credit Limit Enforcement on Metered Usage', () => {
    it('rejects usage when cost exceeds available credit (402 INSUFFICIENT_FUNDS)', async () => {
      // Balance is -6500n. Set creditLimit to 8000n -> Available is 1500n.
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        { $set: { creditLimitMinor: 8000n } }
      );

      const path = '/api/v1/usage/record';
      const body = {
        resource: 'storage_gb',
        units: 200, // 200 GB @ 20 cents = 4,000 cents > 1,500 available credit!
        idempotencyKey: 'meter_rec_overlimit',
        settleImmediately: true,
      };
      const headers = signRequestAlpha('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers)
        .send(body);

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

      // Account balance remains untouched
      const primary = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primary!.balanceMinor).toBe(-6500n);
    });
  });

  describe('5. Buffered Usage & Aggregate Billing Settlement', () => {
    it('buffers unbilled usage records and settles them into a single consolidated ledger charge', async () => {
      // Restore ample credit limit
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        { $set: { creditLimitMinor: 100000n } }
      );

      const primaryBefore = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      const balanceBefore = primaryBefore!.balanceMinor;

      // 1. Ingest unbilled usage record (settleImmediately = false)
      const pathRecord = '/api/v1/usage/record';
      const body1 = {
        resource: 'compute_minutes',
        units: 100, // 100 mins in Tier 0 @ 10 = 1,000 minor units
        idempotencyKey: 'buffered_usage_001',
        settleImmediately: false,
      };
      const headers1 = signRequestAlpha('POST', pathRecord, body1);

      const res1 = await request(app)
        .post(pathRecord)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers1)
        .send(body1);

      expect(res1.status).toBe(201);
      expect(res1.body.usageRecord.billed).toBe(false);
      expect(res1.body.usageRecord.costMinor).toBe(1000);
      expect(res1.body.transaction).toBeNull();

      // Account balance MUST NOT change yet
      const primaryMid = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryMid!.balanceMinor).toBe(balanceBefore);

      // 2. Call aggregate-and-settle
      const pathSettle = '/api/v1/usage/aggregate-and-settle';
      const settleBody = { resource: 'compute_minutes' };
      const headersSettle = signRequestAlpha('POST', pathSettle, settleBody);

      const resSettle = await request(app)
        .post(pathSettle)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headersSettle)
        .send(settleBody);

      expect(resSettle.status).toBe(200);
      expect(resSettle.body.settledCount).toBe(1);
      expect(resSettle.body.totalAmountMinor).toBe(1000);
      expect(resSettle.body.transaction).toBeDefined();
      expect(resSettle.body.transaction.status).toBe('POSTED');

      // Verify the unbilled record is now marked as billed
      const updatedRecord = await tenantModels.UsageRecord.findOne({ idempotencyKey: 'buffered_usage_001' });
      expect(updatedRecord!.billed).toBe(true);
      expect(updatedRecord!.transactionId).toBeDefined();

      // Account balance is now debited by 1,000
      const primaryAfter = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAfter!.balanceMinor).toBe(balanceBefore - 1000n);
    });
  });

  describe('6. Batch Usage Ingestion (POST /api/v1/usage/batch)', () => {
    it('ingests an array of usage events in a single batch call', async () => {
      const path = '/api/v1/usage/batch';
      const body = {
        records: [
          { resource: 'bandwidth_egress', units: 10, idempotencyKey: 'batch_egress_1', settleImmediately: true },
          { resource: 'bandwidth_egress', units: 20, idempotencyKey: 'batch_egress_2', settleImmediately: true },
        ],
      };
      const headers = signRequestAlpha('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.count).toBe(2);
      expect(res.body.records).toHaveLength(2);
      // 10 GB @ 15 = 150 cents; 20 GB @ 15 = 300 cents; total = 450 cents
      expect(res.body.totalCostMinor).toBe(450);
    });
  });

  describe('7. Analytics Dashboard Query API (GET /api/v1/usage/analytics)', () => {
    it('returns summary metrics, spend trends, resource breakdown, and status breakdown', async () => {
      const path = '/api/v1/usage/analytics?range=30d';
      const headers = signRequestAlpha('GET', path);

      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers);

      expect(res.status).toBe(200);

      // Summary
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.currency).toBe('USD');
      expect(res.body.summary.totalSpendMinor).toBeGreaterThan(0);
      expect(res.body.summary.transactionSuccessRate).toBe(83); // 5 POSTED / 6 total transactions = 83%
      expect(res.body.summary.limitUsedPercent).toBeDefined();

      // Spend Over Time
      expect(res.body.spendOverTime).toBeInstanceOf(Array);
      expect(res.body.spendOverTime.length).toBeGreaterThan(0);

      // Resource Breakdown
      expect(res.body.resourceBreakdown).toBeInstanceOf(Array);
      const resources = res.body.resourceBreakdown.map((r: { resource: string }) => r.resource);
      expect(resources).toContain('api_calls');
      expect(resources).toContain('compute_minutes');
      expect(resources).toContain('bandwidth_egress');

      // Status Breakdown
      expect(res.body.statusBreakdown).toBeInstanceOf(Array);
      const postedStatus = res.body.statusBreakdown.find((s: { status: string }) => s.status === 'POSTED');
      expect(postedStatus).toBeDefined();
      expect(postedStatus.count).toBeGreaterThan(0);
    });
  });

  describe('8. Pricing Plans & Tenant Audit Logs', () => {
    it('retrieves configured pricing plans (GET /api/v1/usage/pricing-plans)', async () => {
      const path = '/api/v1/usage/pricing-plans';
      const headers = signRequestAlpha('GET', path);

      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.plans).toBeInstanceOf(Array);
      const resources = res.body.plans.map((p: { resource: string }) => p.resource);
      expect(resources).toContain('api_calls');
      expect(resources).toContain('compute_minutes');
      expect(resources).toContain('storage_gb');
    });

    it('records and returns tenant audit logs (GET /api/v1/usage/audit-logs)', async () => {
      const path = '/api/v1/usage/audit-logs?page=1&limit=10';
      const headers = signRequestAlpha('GET', path);

      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.logs).toBeInstanceOf(Array);
      expect(res.body.logs.length).toBeGreaterThan(0);

      const actions = res.body.logs.map((l: { action: string }) => l.action);
      expect(actions).toContain('USAGE_RECORDED');
      expect(actions).toContain('USAGE_SETTLED');
    });
  });

  describe('9. Multi-Tenant Physical Isolation', () => {
    it('strictly isolates tenant usage data and analytics across discrete databases', async () => {
      // 1. Record usage in Tenant Beta
      const path = '/api/v1/usage/record';
      const bodyBeta = {
        resource: 'ai_tokens',
        units: 50000,
        idempotencyKey: 'beta_usage_001',
        settleImmediately: true,
      };
      const headersBeta = signRequestBeta('POST', path, bodyBeta);

      const resBeta = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validBetaAccessToken}`)
        .set(headersBeta)
        .send(bodyBeta);

      expect(resBeta.status).toBe(201);
      expect(resBeta.body.usageRecord.resource).toBe('ai_tokens');

      // 2. Query Tenant Alpha's usage records: must NOT contain ai_tokens
      const pathAlphaRecords = '/api/v1/usage/records?resource=ai_tokens';
      const headersAlpha = signRequestAlpha('GET', pathAlphaRecords);

      const resAlpha = await request(app)
        .get(pathAlphaRecords)
        .set('Authorization', `Bearer ${validAlphaAccessToken}`)
        .set(headersAlpha);

      expect(resAlpha.status).toBe(200);
      expect(resAlpha.body.records).toHaveLength(0);
      expect(resAlpha.body.pagination.total).toBe(0);

      // 3. Directly inspect Tenant Alpha's DB: zero Beta records
      const alphaDirect = await tenantModels.UsageRecord.find({ idempotencyKey: 'beta_usage_001' });
      expect(alphaDirect).toHaveLength(0);
    });
  });
});
