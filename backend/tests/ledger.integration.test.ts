import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';
import mongoose, { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import { generateKeyPairSync } from 'node:crypto';
import { getControlModels, ControlModels, setControlDbConnection } from '../src/models/control/index.js';
import { getTenantModels, TenantModels, VIRTUAL_CLEARING_ACCOUNT } from '../src/models/tenant/index.js';
import { getRedisClient, setRedisClient } from '../src/redis/client.js';
import { JwtService } from '../src/gateway/jwt/jwtService.js';
import { createAuthenticateMiddleware } from '../src/gateway/authenticate.js';
import { createTenantContextMiddleware, TenantConnectionManager } from '../src/tenancy/index.js';
import { createVerifyTenantSignatureMiddleware, signTenantRequest } from '../src/gateway/verifyTenantSignature.js';
import { LedgerController } from '../src/modules/ledger/ledgerController.js';
import { LedgerService } from '../src/modules/ledger/ledgerService.js';

describe('Double-Entry Ledger Engine & ACID Transactions Integration Tests (Phase 4 Gate)', () => {
  let replSet: MongoMemoryReplSet;
  let redisServer: RedisMemoryServer;
  let controlConn: Connection;
  let tenantConn: Connection;
  let redisClient: Redis;
  let controlModels: ControlModels;
  let tenantModels: TenantModels;
  let jwtService: JwtService;
  let connectionManager: TenantConnectionManager;
  let ledgerService: LedgerService;
  let ledgerController: LedgerController;
  let app: Express;

  // Active Gateway RS256 Keypair
  const gatewayKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Tenant RSA-2048 Keypair
  const tenantKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let tenantOrgId: string;
  let tenantUserId: string;
  let validAccessToken: string;

  beforeAll(async () => {
    // 1. In-memory MongoDB Replica Set (for ACID transaction support)
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

    // 4. Create Organization and User
    const org = await controlModels.Organization.create({
      name: 'Acme Ledger Corp',
      slug: 'acme-ledger',
      dbName: 'lg_tenant_acme_ledger',
      publicKeyPem: tenantKeys.publicKey,
      keyId: 'key_acme_1',
      status: 'ACTIVE',
    });
    tenantOrgId = org._id.toString();

    const user = await controlModels.User.create({
      email: 'billing-admin@acme-ledger.com',
      passwordHash: 'hashed_pw',
      fullName: 'Acme Billing Admin',
    });
    tenantUserId = user._id.toString();

    await controlModels.OrganizationMembership.create({
      userId: user._id,
      orgId: org._id,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
    });

    // 5. Pre-connect and initialize tenant database collections
    tenantConn = mongoose.createConnection(replSetUri, {
      dbName: org.dbName,
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
      tenantModels.initializeAccounts('USD', 50000n, 1000000n), // 500.00 USD credit limit, 10,000.00 USD monthly limit
    ]);

    // 6. Tenant Connection Manager
    connectionManager = new TenantConnectionManager({
      baseClusterUri: replSetUri,
      maxConnections: 10,
    });

    // 7. Ledger Service & Controller
    ledgerService = new LedgerService();
    ledgerController = new LedgerController(ledgerService, redisClient);

    // 8. Express Test Application
    app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.requestId = 'req_ledger_test';
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

    // Mount test ledger router
    const router = express.Router();
    router.use(authenticate);
    router.use(tenantContext);
    router.use(verifySignature);

    router.post('/transactions', ledgerController.createTransaction);
    router.get('/transactions', ledgerController.getTransactions);
    router.get('/transactions/:id', ledgerController.getTransactionById);
    router.get('/balance', ledgerController.getBalance);

    app.use('/api/v1/ledger', router);

    // 9. Issue valid access token
    validAccessToken = jwtService.signAccessToken({
      userId: tenantUserId,
      orgId: tenantOrgId,
      role: 'ORG_ADMIN',
      email: 'billing-admin@acme-ledger.com',
      familyId: 'fam_ledger_test',
    });
  }, 40000);

  afterAll(async () => {
    if (tenantConn) await tenantConn.close();
    if (connectionManager) await connectionManager.closeAll();
    if (controlConn) await controlConn.close();
    if (redisClient) await redisClient.quit();
    if (redisServer) await redisServer.stop();
    if (replSet) await replSet.stop();
  });

  /**
   * Helper to sign an HTTP request for tenant verification.
   */
  function signRequest(method: string, path: string, body?: unknown) {
    const rawBody = body !== undefined ? JSON.stringify(body) : '';
    return signTenantRequest({
      privateKeyPem: tenantKeys.privateKey,
      keyId: 'key_acme_1',
      method,
      path,
      body: rawBody,
    });
  }

  describe('1. Double-Entry Accounting Invariant & Math Accuracy', () => {
    it('creates balanced DEBIT PRIMARY and CREDIT PLATFORM_CLEARING entries for a charge', async () => {
      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 5000, // 50.00 USD
        currency: 'USD',
        resource: 'compute_instances',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_debit_credit_001')
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('POSTED');
      expect(res.body.amountMinor).toBe(5000);

      // Verify Database Balances:
      // PRIMARY account must be debited by 5000 (balance goes from 0 to -5000)
      const primaryAcc = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAcc!.balanceMinor).toBe(-5000n);

      // Virtual Clearing account must be credited by 5000 (balance goes from 0 to 5000)
      const clearingAcc = await tenantModels.Account.findOne({ accountRef: VIRTUAL_CLEARING_ACCOUNT });
      expect(clearingAcc!.balanceMinor).toBe(5000n);

      // Mathematical Invariant: sum of all balances in tenant DB is exactly zero!
      expect(primaryAcc!.balanceMinor + clearingAcc!.balanceMinor).toBe(0n);

      // Verify Journal Lines:
      const lines = await tenantModels.LedgerEntry.find({ transactionId: res.body._id }).sort({ direction: 1 });
      expect(lines).toHaveLength(2);

      const debitLine = lines.find((l) => l.direction === 'DEBIT');
      const creditLine = lines.find((l) => l.direction === 'CREDIT');

      expect(debitLine!.accountRef).toBe('PRIMARY');
      expect(debitLine!.amountMinor).toBe(5000n);
      expect(debitLine!.balanceAfterMinor).toBe(-5000n);

      expect(creditLine!.accountRef).toBe(VIRTUAL_CLEARING_ACCOUNT);
      expect(creditLine!.amountMinor).toBe(5000n);
      expect(creditLine!.balanceAfterMinor).toBe(5000n);
    });
  });

  describe('2. Idempotent Replay & Payload Integrity', () => {
    it('returns existing transaction idempotently without double-charging on identical replay', async () => {
      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 2500, // 25.00 USD
        currency: 'USD',
        resource: 'storage_volumes',
      };

      // 1. Initial request
      const headers1 = signRequest('POST', path, body);
      const res1 = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_replay_test_002')
        .set(headers1)
        .send(body);

      expect(res1.status).toBe(201);
      const originalTxnId = res1.body._id;

      const primaryBefore = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      const balanceBefore = primaryBefore!.balanceMinor;

      // 2. Re-send identical request with same idempotency key
      const headers2 = signRequest('POST', path, body);
      const res2 = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_replay_test_002')
        .set(headers2)
        .send(body);

      expect(res2.status).toBe(201);
      expect(res2.body._id).toBe(originalTxnId);

      // Verify account balance was NOT deducted again
      const primaryAfter = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAfter!.balanceMinor).toBe(balanceBefore);
    });

    it('rejects replay with same idempotency key but altered payload (409 IDEMPOTENCY_PAYLOAD_MISMATCH)', async () => {
      const path = '/api/v1/ledger/transactions';
      const alteredBody = {
        type: 'charge',
        amountMinor: 9999, // Altered amount!
        currency: 'USD',
        resource: 'storage_volumes',
      };

      const headers = signRequest('POST', path, alteredBody);
      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_replay_test_002') // Key used above
        .set(headers)
        .send(alteredBody);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });
  });

  describe('3. Concurrency Protection & Mutual Exclusion', () => {
    it('executes exactly once under 10 concurrent requests with identical idempotency key', async () => {
      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 1000,
        currency: 'USD',
        resource: 'concurrent_stress',
      };

      const primaryBefore = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      const balanceBefore = primaryBefore!.balanceMinor;

      // Launch 10 concurrent requests with same idempotency key
      const promises = Array.from({ length: 10 }, () => {
        const headers = signRequest('POST', path, body);
        return request(app)
          .post(path)
          .set('Authorization', `Bearer ${validAccessToken}`)
          .set('Idempotency-Key', 'idem_concurrent_003')
          .set(headers)
          .send(body);
      });

      const responses = await Promise.all(promises);
      const succeeded = responses.filter((r) => r.status === 200 || r.status === 201);
      const inFlight = responses.filter(
        (r) => r.status === 409 && (r.body as any)?.error?.code === 'TRANSACTION_IN_FLIGHT'
      );
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      expect(succeeded.length + inFlight.length).toBe(10);

      // All successful responses must share the exact same transaction ID
      const firstId = succeeded[0]!.body._id;
      for (const res of succeeded) {
        expect(res.body._id).toBe(firstId);
      }

      // Exactly 1000 was deducted once
      const primaryAfter = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAfter!.balanceMinor).toBe(balanceBefore - 1000n);

      const count = await tenantModels.Transaction.countDocuments({ idempotencyKey: 'idem_concurrent_003' });
      expect(count).toBe(1);
    });

    it('enforces available balance limits safely under concurrent competing charges', async () => {
      // Deterministically set available balance to 45,000 cents and high monthly limit
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        { $set: { balanceMinor: 0n, creditLimitMinor: 45000n, currentMonthSpendMinor: 0n, monthlyLimitMinor: 1000000n } }
      );

      const path = '/api/v1/ledger/transactions';
      // 5 concurrent charges each attempting to spend 20,000 cents (total 100,000 > available)
      const chargeAmount = 20000;

      const promises = Array.from({ length: 5 }, (_, i) => {
        const body = {
          type: 'charge',
          amountMinor: chargeAmount,
          currency: 'USD',
          resource: `competing_charge_${i}`,
        };
        const headers = signRequest('POST', path, body);
        return request(app)
          .post(path)
          .set('Authorization', `Bearer ${validAccessToken}`)
          .set('Idempotency-Key', `idem_compete_balance_${i}`)
          .set(headers)
          .send(body);
      });

      const responses = await Promise.all(promises);
      const succeeded = responses.filter((r) => r.status === 201);
      const failed = responses.filter((r) => r.status === 402);

      // Exactly 2 could fit in the available balance (~41500 / 20000 = 2)
      expect(succeeded).toHaveLength(2);
      expect(failed).toHaveLength(3);

      for (const f of failed) {
        expect(f.body.error.code).toBe('INSUFFICIENT_FUNDS');
      }

      // Final balance must NEVER breach credit limit
      const finalAccount = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(finalAccount!.balanceMinor + finalAccount!.creditLimitMinor).toBeGreaterThanOrEqual(0n);
    });
  });

  describe('4. Monthly Limit Enforcement & Calendar Month Rollover', () => {
    it('rejects charge when monthly spending limit is exceeded (402 MONTHLY_LIMIT_EXCEEDED)', async () => {
      // Set ample available balance so insufficient funds doesn't trigger, but small monthly quota
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        { $set: { balanceMinor: 0n, creditLimitMinor: 100000n, monthlyLimitMinor: 5000n, currentMonthSpendMinor: 4000n } }
      );

      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 2000, // 4000 + 2000 > 5000 limit!
        currency: 'USD',
        resource: 'over_monthly_quota',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_monthly_exceeded_004')
        .set(headers)
        .send(body);

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('MONTHLY_LIMIT_EXCEEDED');
    });

    it('atomically resets currentMonthSpendMinor to the new transaction amount on calendar month rollover', async () => {
      // Simulate account state from a prior month (e.g. 2026-10) with near-exhausted quota
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        {
          $set: {
            currentMonth: '2026-10', // Prior month!
            currentMonthSpendMinor: 4900n,
            monthlyLimitMinor: 5000n,
            creditLimitMinor: 100000n,
          },
        }
      );

      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 3000, // In prior month, 4900 + 3000 would exceed 5000. But in new month, 3000 <= 5000!
        currency: 'USD',
        resource: 'rollover_charge',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_rollover_test_005')
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('POSTED');

      // Verify that currentMonth was updated to current month and spend was RESET to 3000 (not incremented to 7900)
      const currentMonthStr = new Date().toISOString().slice(0, 7);
      const acc = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });

      expect(acc!.currentMonth).toBe(currentMonthStr);
      expect(acc!.currentMonthSpendMinor).toBe(3000n);
    });
  });

  describe('5. Financial Precision & 64-Bit Boundaries', () => {
    it('processes amounts exceeding Number.MAX_SAFE_INTEGER (> 2^53 - 1) with exact precision and safe string serialization', async () => {
      // Expand credit and monthly limits to accommodate 10 quadrillion minor units
      const hugeAmount = '10000000000000000'; // 10^16 minor units
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        {
          $set: {
            creditLimitMinor: 50_000_000_000_000_000n,
            monthlyLimitMinor: 50_000_000_000_000_000n,
          },
        }
      );

      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: hugeAmount,
        currency: 'USD',
        resource: 'quantum_compute_cluster',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_huge_amount_006')
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      // Serializes as string to prevent IEEE 754 precision truncation in JSON
      expect(res.body.amountMinor).toBe(hugeAmount);

      // Verify in MongoDB: exact 64-bit integer
      const txn = await tenantModels.Transaction.findById(res.body._id);
      expect(txn!.amountMinor).toBe(10_000_000_000_000_000n);
    });
  });

  describe('6. Refund Lineage & Concurrent Refund Race Protection', () => {
    let chargeTxnId: string;

    beforeAll(async () => {
      // Create a posted charge of 10,000 cents (100.00 USD)
      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 10000,
        currency: 'USD',
        resource: 'refundable_service',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_charge_for_refund')
        .set(headers)
        .send(body);

      chargeTxnId = res.body._id;
    });

    it('processes partial refund and updates account balances inversely', async () => {
      const primaryBefore = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      const balanceBefore = primaryBefore!.balanceMinor;

      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'refund',
        amountMinor: 3000, // 30.00 USD
        currency: 'USD',
        resource: 'refundable_service',
        originalTransactionId: chargeTxnId,
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_partial_refund_1')
        .set(headers)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('POSTED');
      expect(res.body.originalTransactionId).toBe(chargeTxnId);

      // Customer account balance increases by 3000
      const primaryAfter = await tenantModels.Account.findOne({ accountRef: 'PRIMARY' });
      expect(primaryAfter!.balanceMinor).toBe(balanceBefore + 3000n);

      // Original charge has refundedAmountMinor incremented
      const originalCharge = await tenantModels.Transaction.findById(chargeTxnId);
      expect(originalCharge!.refundedAmountMinor).toBe(3000n);
    });

    it('atomically enforces refund ceiling under 5 concurrent refund attempts racing for remainder', async () => {
      // Original charge was 10000; already refunded 3000; Remaining refundable quota is 7000.
      // Launch 5 concurrent refunds each trying to refund 3000 (total requested: 15,000 > 7,000).
      const path = '/api/v1/ledger/transactions';
      const promises = Array.from({ length: 5 }, (_, i) => {
        const body = {
          type: 'refund',
          amountMinor: 3000,
          currency: 'USD',
          resource: 'refundable_service',
          originalTransactionId: chargeTxnId,
        };
        const headers = signRequest('POST', path, body);
        return request(app)
          .post(path)
          .set('Authorization', `Bearer ${validAccessToken}`)
          .set('Idempotency-Key', `idem_concurrent_refund_${i}`)
          .set(headers)
          .send(body);
      });

      const responses = await Promise.all(promises);
      const succeeded = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 422);

      // Exactly 2 can succeed (3000 * 2 = 6000 <= 7000 quota), 3 must be rejected
      expect(succeeded).toHaveLength(2);
      expect(rejected).toHaveLength(3);

      for (const rej of rejected) {
        expect(rej.body.error.code).toBe('REFUND_EXCEEDS_ORIGINAL_AMOUNT');
      }

      // Total refunded amount on original charge must be exactly 9000 (3000 initial + 6000 concurrent)
      const finalCharge = await tenantModels.Transaction.findById(chargeTxnId);
      expect(finalCharge!.refundedAmountMinor).toBe(9000n);
    });
  });

  describe('7. Out-of-Session Failure Persistence & Failure Simulation Guard', () => {
    it('persists FAILED transaction record in MongoDB outside aborted transaction session', async () => {
      // Reset credit limit so that 99999999 exceeds available balance
      await tenantModels.Account.updateOne(
        { accountRef: 'PRIMARY' },
        { $set: { balanceMinor: 0n, creditLimitMinor: 50000n, monthlyLimitMinor: 1000000n } }
      );

      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 99999999, // Exceeds available balance
        currency: 'USD',
        resource: 'impossible_charge',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_persisted_failure_007')
        .set(headers)
        .send(body);

      expect(res.status).toBe(402);

      // Verify that despite the transaction failure, a FAILED record was permanently written to MongoDB
      const failedRecord = await tenantModels.Transaction.findOne({ idempotencyKey: 'idem_persisted_failure_007' });
      expect(failedRecord).not.toBeNull();
      expect(failedRecord!.status).toBe('FAILED');
      expect(failedRecord!.failureReason).toContain('INSUFFICIENT_FUNDS');
    });

    it('executes X-Simulate-Failure in development/test environment and marks transaction as ROLLED_BACK', async () => {
      const path = '/api/v1/ledger/transactions';
      const body = {
        type: 'charge',
        amountMinor: 100,
        currency: 'USD',
        resource: 'simulated_test',
      };
      const headers = signRequest('POST', path, body);

      const res = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set('Idempotency-Key', 'idem_sim_fail_008')
        .set('X-Simulate-Failure', 'network_disconnect')
        .set(headers)
        .send(body);

      expect(res.status).toBe(400);

      // Verify persisted as ROLLED_BACK
      const simRecord = await tenantModels.Transaction.findOne({ idempotencyKey: 'idem_sim_fail_008' });
      expect(simRecord).not.toBeNull();
      expect(simRecord!.status).toBe('ROLLED_BACK');
      expect(simRecord!.failureReason).toContain('NETWORK_ERROR');
    });

    it('strictly rejects X-Simulate-Failure in production environment (400 SIMULATION_PROHIBITED_IN_PRODUCTION)', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';

        const path = '/api/v1/ledger/transactions';
        const body = {
          type: 'charge',
          amountMinor: 100,
          currency: 'USD',
          resource: 'prod_simulation_attack',
        };
        const headers = signRequest('POST', path, body);

        const res = await request(app)
          .post(path)
          .set('Authorization', `Bearer ${validAccessToken}`)
          .set('Idempotency-Key', 'idem_prod_sim_009')
          .set('X-Simulate-Failure', 'database_error')
          .set(headers)
          .send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('SIMULATION_PROHIBITED_IN_PRODUCTION');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  describe('8. Read APIs: Balance Query & Transaction History', () => {
    it('returns current balance summary (GET /api/v1/ledger/balance)', async () => {
      const path = '/api/v1/ledger/balance';
      const headers = signRequest('GET', path);

      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.currency).toBe('USD');
      expect(res.body.creditLimitMinor).toBeDefined();
      expect(res.body.availableMinor).toBeDefined();
      expect(res.body.currentMonth).toBeDefined();
      expect(res.body.currentMonthSpendMinor).toBeDefined();
    });

    it('returns paginated transactions (GET /api/v1/ledger/transactions)', async () => {
      const path = '/api/v1/ledger/transactions?page=1&limit=5';
      const headers = signRequest('GET', path);

      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${validAccessToken}`)
        .set(headers);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toBeInstanceOf(Array);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(5);
    });
  });
});
