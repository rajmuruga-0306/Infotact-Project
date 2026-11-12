import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { getTenantModels, TenantModels, VIRTUAL_CLEARING_ACCOUNT } from '../src/models/tenant/index.js';

describe('Tenant Database Models Unit Tests', () => {
  let mongoServer: MongoMemoryServer;
  let conn: Connection;
  let models: TenantModels;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    conn = mongoose.createConnection(uri, { autoIndex: true });
    models = getTenantModels(conn);

    // Initialize indexes
    await Promise.all([
      models.Account.init(),
      models.Transaction.init(),
      models.LedgerEntry.init(),
      models.UsageRecord.init(),
      models.TenantAuditLog.init(),
    ]);
  }, 30000);

  afterAll(async () => {
    if (conn) {
      await conn.close();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  describe('1. Account Model', () => {
    it('initializes PRIMARY and VIRTUAL_CLEARING accounts with integer balances', async () => {
      const { primary, virtualClearing } = await models.initializeAccounts('USD', 50000, 1000000);

      expect(primary.accountRef).toBe('PRIMARY');
      expect(primary.balanceMinor).toBe(0);
      expect(primary.creditLimitMinor).toBe(50000);
      expect(primary.currency).toBe('USD');

      expect(virtualClearing.accountRef).toBe(VIRTUAL_CLEARING_ACCOUNT);
      expect(virtualClearing.balanceMinor).toBe(0);

      // Verify idempotency of account initialization
      const reinit = await models.initializeAccounts('USD', 50000, 1000000);
      expect(reinit.primary._id.toString()).toBe(primary._id.toString());
      expect(reinit.virtualClearing._id.toString()).toBe(virtualClearing._id.toString());
    });

    it('rejects floating-point balanceMinor with validation error', async () => {
      await expect(
        models.Account.create({
          accountRef: 'FLOAT_TEST',
          balanceMinor: 123.45, // Prohibited! Must be integer minor units
          currency: 'USD',
        })
      ).rejects.toThrow(/balanceMinor must be an integer/);
    });

    it('rejects negative creditLimitMinor', async () => {
      await expect(
        models.Account.create({
          accountRef: 'NEG_CREDIT_TEST',
          creditLimitMinor: -500, // Prohibited!
          currency: 'USD',
        })
      ).rejects.toThrow(/creditLimitMinor must be a non-negative integer/);
    });

    it('enforces optimistic concurrency versioning on Account', async () => {
      const acc = await models.Account.create({
        accountRef: 'CONCURRENCY_TEST',
        balanceMinor: 1000,
        currency: 'USD',
      });
      expect(acc.version).toBe(0);

      // Retrieve two instances
      const instance1 = await models.Account.findById(acc._id);
      const instance2 = await models.Account.findById(acc._id);

      // First update succeeds and increments version
      instance1!.balanceMinor = 2000;
      await instance1!.save();
      expect(instance1!.version).toBe(1);

      // Stale instance2 update fails due to version mismatch
      instance2!.balanceMinor = 3000;
      await expect(instance2!.save()).rejects.toThrow(/No matching document found for id/);
    });
  });

  describe('2. Transaction Model', () => {
    it('creates transaction with positive integer amount and tracks status', async () => {
      const txn = await models.Transaction.create({
        idempotencyKey: 'idem_test_001',
        requestHash: 'hash_abc123',
        type: 'charge',
        amountMinor: 5000, // 50.00 USD
        currency: 'USD',
        resource: 'api_tokens',
        status: 'PENDING',
        signatureKeyId: 'key_tenant_1',
        createdBy: 'user_123',
      });

      expect(txn.idempotencyKey).toBe('idem_test_001');
      expect(txn.amountMinor).toBe(5000);
      expect(txn.status).toBe('PENDING');
      expect(txn.refundedAmountMinor).toBe(0);
    });

    it('enforces unique idempotencyKey per tenant', async () => {
      await expect(
        models.Transaction.create({
          idempotencyKey: 'idem_test_001', // Duplicate!
          requestHash: 'hash_different',
          type: 'charge',
          amountMinor: 1000,
          currency: 'USD',
          resource: 'api_tokens',
          signatureKeyId: 'key_tenant_1',
          createdBy: 'user_123',
        })
      ).rejects.toThrow();
    });

    it('rejects zero or negative amountMinor', async () => {
      await expect(
        models.Transaction.create({
          idempotencyKey: 'idem_neg_test',
          requestHash: 'hash_xyz',
          type: 'charge',
          amountMinor: 0, // Prohibited!
          currency: 'USD',
          resource: 'api_tokens',
          signatureKeyId: 'key_tenant_1',
          createdBy: 'user_123',
        })
      ).rejects.toThrow(/amountMinor must be a positive integer/);
    });
  });

  describe('3. LedgerEntry Model', () => {
    it('creates DEBIT and CREDIT double-entry records with integer balances', async () => {
      const txn = await models.Transaction.create({
        idempotencyKey: 'idem_ledger_entry_test',
        requestHash: 'hash_entry',
        type: 'charge',
        amountMinor: 2500,
        currency: 'USD',
        resource: 'compute_time',
        signatureKeyId: 'key_tenant_1',
        createdBy: 'user_123',
      });

      // Entry 1: DEBIT PRIMARY
      const debitEntry = await models.LedgerEntry.create({
        transactionId: txn._id,
        accountRef: 'PRIMARY',
        direction: 'DEBIT',
        amountMinor: 2500,
        balanceAfterMinor: 2500,
      });

      // Entry 2: CREDIT PLATFORM_CLEARING
      const creditEntry = await models.LedgerEntry.create({
        transactionId: txn._id,
        accountRef: VIRTUAL_CLEARING_ACCOUNT,
        direction: 'CREDIT',
        amountMinor: 2500,
        balanceAfterMinor: -2500,
      });

      expect(debitEntry.direction).toBe('DEBIT');
      expect(debitEntry.amountMinor).toBe(2500);
      expect(creditEntry.direction).toBe('CREDIT');
      expect(creditEntry.amountMinor).toBe(2500);
    });

    it('rejects floating-point balanceAfterMinor', async () => {
      const dummyId = new mongoose.Types.ObjectId();
      await expect(
        models.LedgerEntry.create({
          transactionId: dummyId,
          accountRef: 'PRIMARY',
          direction: 'DEBIT',
          amountMinor: 1000,
          balanceAfterMinor: 1000.75, // Prohibited!
        })
      ).rejects.toThrow(/balanceAfterMinor must be an integer/);
    });
  });

  describe('4. UsageRecord Model', () => {
    it('records metric usage with positive units and integer costMinor', async () => {
      const usage = await models.UsageRecord.create({
        resource: 'storage_gb',
        units: 250.5,
        costMinor: 1250, // 12.50 USD
        metadata: { region: 'us-east-1' },
      });

      expect(usage.resource).toBe('storage_gb');
      expect(usage.units).toBe(250.5);
      expect(usage.costMinor).toBe(1250);
      expect(usage.ts).toBeDefined();
    });

    it('rejects negative costMinor', async () => {
      await expect(
        models.UsageRecord.create({
          resource: 'compute_hours',
          units: 10,
          costMinor: -50,
        })
      ).rejects.toThrow(/costMinor must be a non-negative integer/);
    });
  });

  describe('5. TenantAuditLog Model', () => {
    it('records tenant-isolated audit log event', async () => {
      const audit = await models.TenantAuditLog.create({
        actorId: 'user_456',
        action: 'LEDGER_TRANSACTION_CREATED',
        requestId: 'req_test_abc',
        ip: '10.0.0.1',
        outcome: 'SUCCESS',
        details: { amountMinor: 5000 },
      });

      expect(audit.action).toBe('LEDGER_TRANSACTION_CREATED');
      expect(audit.outcome).toBe('SUCCESS');
      expect(audit.ip).toBe('10.0.0.1');
    });
  });
});
