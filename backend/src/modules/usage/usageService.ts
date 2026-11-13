import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  RecordUsageInput,
  BatchRecordUsageInput,
  AggregateAndSettleInput,
  UsageRecordsQueryInput,
  AnalyticsQueryInput,
  AuditLogQueryInput,
  toBigIntMinor,
  serializeMinorUnit,
} from '@ledgerguard/shared';
import { TenantModels } from '../../models/tenant/index.js';
import { IUsageRecord } from '../../models/tenant/UsageRecord.js';
import { ITransaction } from '../../models/tenant/Transaction.js';
import { ledgerService, LedgerService } from '../ledger/ledgerService.js';
import { defaultPricingEngine, PricingEngine } from './pricingEngine.js';
import { acquireDistributedLock, releaseDistributedLock } from '../../redis/lock.js';
import { getRedisClient } from '../../redis/client.js';
import { broadcastUsageUpdated } from '../../websocket/index.js';

export interface RecordUsageParams {
  input: RecordUsageInput;
  actorId: string;
  orgId: string;
  signatureKeyId: string;
  models: TenantModels;
  requestId: string;
  clientIp: string;
  redisClient?: Redis;
}

export interface BatchRecordUsageParams {
  input: BatchRecordUsageInput;
  actorId: string;
  orgId: string;
  signatureKeyId: string;
  models: TenantModels;
  requestId: string;
  clientIp: string;
  redisClient?: Redis;
}

export interface AggregateAndSettleParams {
  input: AggregateAndSettleInput;
  actorId: string;
  orgId: string;
  signatureKeyId: string;
  models: TenantModels;
  requestId: string;
  clientIp: string;
  redisClient?: Redis;
}

export class UsageService {
  constructor(
    private readonly pricingEngine: PricingEngine = defaultPricingEngine,
    private readonly ledger: LedgerService = ledgerService
  ) {}

  /**
   * Computes the cumulative units consumed for a given resource within the current calendar month.
   */
  async getCumulativeMonthlyUnits(models: TenantModels, resource: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const agg = await models.UsageRecord.aggregate([
      {
        $match: {
          resource,
          ts: { $gte: startOfMonth },
        },
      },
      {
        $group: {
          _id: null,
          totalUnits: { $sum: '$units' },
        },
      },
    ]);

    return agg[0]?.totalUnits || 0;
  }

  /**
   * Records a single usage event with graduated tiered pricing and optional immediate ledger settlement.
   */
  async recordUsage(params: RecordUsageParams): Promise<{ usageRecord: IUsageRecord; transaction: ITransaction | null }> {
    const { input, actorId, orgId, signatureKeyId, models, requestId, clientIp, redisClient = getRedisClient() } = params;

    // 1. Idempotency Check
    if (input.idempotencyKey) {
      const existing = await models.UsageRecord.findOne({ idempotencyKey: input.idempotencyKey });
      if (existing) {
        let existingTxn: ITransaction | null = null;
        if (existing.transactionId) {
          existingTxn = await models.Transaction.findById(existing.transactionId);
        }
        return { usageRecord: existing, transaction: existingTxn };
      }
    }

    // 2. Concurrency Lock per Tenant Resource to safely serialize cumulative tier threshold transitions
    const meterLockKey = `lock:meter:${orgId}:${input.resource}`;
    const meterLock = await acquireDistributedLock(meterLockKey, 10000, redisClient);

    let costMinor: bigint;
    let rateTierApplied: unknown = null;

    try {
      // 3. Determine cumulative units in current billing month
      const currentUnits = await this.getCumulativeMonthlyUnits(models, input.resource);

      // 4. Calculate tiered cost
      if (input.costMinor !== undefined) {
        costMinor = toBigIntMinor(input.costMinor);
      } else {
        const calculated = this.pricingEngine.calculateCost(input.resource, currentUnits, input.units);
        costMinor = calculated.totalCostMinor;
        rateTierApplied = calculated.breakdown;
      }
    } finally {
      if (meterLock.acquired && meterLock.token) {
        await releaseDistributedLock(meterLockKey, meterLock.token, undefined, redisClient);
      }
    }

    let postedTxn: ITransaction | null = null;
    const shouldSettle = input.settleImmediately !== false;

    // 5. Immediate Settlement via Double-Entry Ledger Engine
    if (shouldSettle && costMinor > 0n) {
      const txnIdempotencyKey = input.idempotencyKey
        ? `txn:meter:${input.idempotencyKey}`
        : `txn:meter:${randomUUID()}`;

      const requestHash = createHash('sha256')
        .update(JSON.stringify({ resource: input.resource, units: input.units, costMinor: costMinor.toString() }))
        .digest('hex');

      postedTxn = await this.ledger.processTransaction({
        input: {
          type: 'charge',
          amountMinor: serializeMinorUnit(costMinor),
          currency: 'USD',
          resource: input.resource,
        },
        idempotencyKey: txnIdempotencyKey,
        requestHash,
        signatureKeyId,
        actorId,
        orgId,
        models,
        clientIp,
        requestId,
        redisClient,
      });
    }

    // 6. Persist UsageRecord
    const usageDoc = new models.UsageRecord({
      resource: input.resource,
      units: input.units,
      costMinor,
      ts: input.ts ? new Date(input.ts) : new Date(),
      idempotencyKey: input.idempotencyKey,
      billed: shouldSettle,
      transactionId: postedTxn?._id,
      rateTierApplied,
      metadata: input.metadata,
    });

    await usageDoc.save();

    // Broadcast WebSocket usage update
    try {
      broadcastUsageUpdated(orgId, {
        resource: input.resource,
        units: input.units,
        costMinor: Number(costMinor),
        ts: usageDoc.ts.toISOString(),
      });
    } catch {
      // Non-blocking socket broadcast
    }

    // 7. Write to TenantAuditLog
    await models.TenantAuditLog.create({
      ts: new Date(),
      actorId,
      action: 'USAGE_RECORDED',
      requestId,
      ip: clientIp,
      outcome: 'SUCCESS',
      details: {
        usageRecordId: usageDoc._id.toString(),
        resource: input.resource,
        units: input.units,
        costMinor: serializeMinorUnit(costMinor),
        billed: shouldSettle,
        transactionId: postedTxn?._id?.toString(),
      },
    });

    return { usageRecord: usageDoc, transaction: postedTxn };
  }

  /**
   * Records a batch of usage records.
   */
  async recordUsageBatch(params: BatchRecordUsageParams): Promise<{ count: number; totalCostMinor: number | string; records: IUsageRecord[] }> {
    const { input, actorId, orgId, signatureKeyId, models, requestId, clientIp, redisClient = getRedisClient() } = params;

    const records: IUsageRecord[] = [];
    let cumulativeCostMinor = 0n;

    for (const item of input.records) {
      const res = await this.recordUsage({
        input: item,
        actorId,
        orgId,
        signatureKeyId,
        models,
        requestId,
        clientIp,
        redisClient,
      });
      records.push(res.usageRecord);
      cumulativeCostMinor += res.usageRecord.costMinor;
    }

    return {
      count: records.length,
      totalCostMinor: serializeMinorUnit(cumulativeCostMinor),
      records,
    };
  }

  /**
   * Aggregates all unbilled usage records and settles them into a single consolidated ledger charge.
   */
  async aggregateAndSettle(params: AggregateAndSettleParams): Promise<{
    settledCount: number;
    totalAmountMinor: number | string;
    transaction: ITransaction | null;
  }> {
    const { input, actorId, orgId, signatureKeyId, models, requestId, clientIp, redisClient = getRedisClient() } = params;

    // Acquire lock on billing settlement
    const settleLockKey = `lock:settle:${orgId}:${input.resource || 'all'}`;
    const settleLock = await acquireDistributedLock(settleLockKey, 30000, redisClient);

    if (!settleLock.acquired) {
      throw new Error('CONCURRENT_SETTLEMENT_IN_PROGRESS: A billing settlement run is already in progress for this tenant');
    }

    try {
      const filter: Record<string, unknown> = { billed: false };
      if (input.resource) {
        filter.resource = input.resource;
      }
      if (input.startDate || input.endDate) {
        filter.ts = {};
        if (input.startDate) (filter.ts as Record<string, unknown>).$gte = new Date(input.startDate);
        if (input.endDate) (filter.ts as Record<string, unknown>).$lte = new Date(input.endDate);
      }

      const unbilledRecords = await models.UsageRecord.find(filter);

      if (unbilledRecords.length === 0) {
        return { settledCount: 0, totalAmountMinor: 0, transaction: null };
      }

      let totalCostMinor = 0n;
      for (const rec of unbilledRecords) {
        totalCostMinor += rec.costMinor;
      }

      let postedTxn: ITransaction | null = null;

      if (totalCostMinor > 0n) {
        const txnIdempotencyKey = `settle:${orgId}:${new Date().toISOString()}:${randomUUID()}`;
        const requestHash = createHash('sha256')
          .update(JSON.stringify({ unbilledCount: unbilledRecords.length, totalCostMinor: totalCostMinor.toString() }))
          .digest('hex');

        postedTxn = await this.ledger.processTransaction({
          input: {
            type: 'charge',
            amountMinor: serializeMinorUnit(totalCostMinor),
            currency: 'USD',
            resource: input.resource || 'aggregated_usage_settlement',
          },
          idempotencyKey: txnIdempotencyKey,
          requestHash,
          signatureKeyId,
          actorId,
          orgId,
          models,
          clientIp,
          requestId,
          redisClient,
        });

        // Mark records as billed with the transaction ID
        const unbilledIds = unbilledRecords.map((r) => r._id);
        await models.UsageRecord.updateMany(
          { _id: { $in: unbilledIds } },
          { $set: { billed: true, transactionId: postedTxn._id } }
        );
      }

      await models.TenantAuditLog.create({
        ts: new Date(),
        actorId,
        action: 'USAGE_SETTLED',
        requestId,
        ip: clientIp,
        outcome: 'SUCCESS',
        details: {
          settledCount: unbilledRecords.length,
          totalAmountMinor: serializeMinorUnit(totalCostMinor),
          transactionId: postedTxn?._id?.toString(),
        },
      });

      return {
        settledCount: unbilledRecords.length,
        totalAmountMinor: serializeMinorUnit(totalCostMinor),
        transaction: postedTxn,
      };
    } finally {
      if (settleLock.token) {
        await releaseDistributedLock(settleLockKey, settleLock.token, undefined, redisClient);
      }
    }
  }

  /**
   * Executes high-performance MongoDB aggregation pipelines to compile analytics dashboard metrics.
   */
  async getAnalytics(models: TenantModels, query: AnalyticsQueryInput) {
    const range = query.range || '30d';
    let rangeDays = 30;
    let isMonthly = false;

    if (range === '7d') {
      rangeDays = 7;
    } else if (range === '12m') {
      rangeDays = 365;
      isMonthly = true;
    }

    const startDate = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    // 1. Account Summary
    const account = await models.Account.findOne({ accountRef: 'PRIMARY' });
    const balanceMinor = account?.balanceMinor ?? 0n;
    const creditLimitMinor = account?.creditLimitMinor ?? 0n;
    const monthlyLimitMinor = account?.monthlyLimitMinor ?? 0n;
    const currentMonthSpendMinor = account?.currentMonthSpendMinor ?? 0n;

    const limitUsedPercent =
      monthlyLimitMinor > 0n
        ? Math.min(100, Math.round(Number((currentMonthSpendMinor * 10000n) / monthlyLimitMinor) / 100))
        : 0;

    // 2. Transactions in range: Total Spend and Success Rate
    const txnsInRange = await models.Transaction.find({ createdAt: { $gte: startDate } });
    const totalTransactions = txnsInRange.length;
    let totalSpendMinor = 0n;
    let successfulCount = 0;

    for (const t of txnsInRange) {
      if (t.status === 'POSTED') {
        successfulCount++;
        if (t.type === 'charge') {
          totalSpendMinor += t.amountMinor;
        } else if (t.type === 'refund') {
          totalSpendMinor -= t.amountMinor;
        }
      }
    }

    const transactionSuccessRate =
      totalTransactions > 0 ? Math.round((successfulCount / totalTransactions) * 100) : 100;

    // 3. Spend Over Time Aggregation
    const dateFormat = isMonthly ? '%Y-%m' : '%Y-%m-%d';
    const spendOverTimeAgg = await models.Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          status: 'POSTED',
          type: 'charge',
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
          spendMinor: { $sum: '$amountMinor' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const spendOverTime = spendOverTimeAgg.map((item) => ({
      date: item._id as string,
      spendMinor: typeof item.spendMinor === 'bigint' ? serializeMinorUnit(item.spendMinor) : item.spendMinor,
      count: item.count as number,
    }));

    // 4. Resource Usage Breakdown Aggregation
    const resourceAgg = await models.UsageRecord.aggregate([
      {
        $match: {
          ts: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$resource',
          totalUnits: { $sum: '$units' },
          totalCostMinor: { $sum: '$costMinor' },
        },
      },
    ]);

    let grandTotalUsageCost = 0n;
    for (const r of resourceAgg) {
      grandTotalUsageCost += BigInt(r.totalCostMinor || 0);
    }

    const resourceBreakdown = resourceAgg.map((r) => {
      const cost = BigInt(r.totalCostMinor || 0);
      const percentage =
        grandTotalUsageCost > 0n
          ? Math.round(Number((cost * 10000n) / grandTotalUsageCost) / 100)
          : 0;

      return {
        resource: r._id as string,
        totalUnits: r.totalUnits as number,
        totalCostMinor: serializeMinorUnit(cost),
        percentage,
      };
    });

    // 5. Status Breakdown Aggregation
    const statusAgg = await models.Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const statusBreakdown = statusAgg.map((s) => ({
      status: s._id as string,
      count: s.count as number,
      percentage: totalTransactions > 0 ? Math.round((s.count / totalTransactions) * 100) : 0,
    }));

    return {
      summary: {
        totalSpendMinor: serializeMinorUnit(totalSpendMinor),
        balanceMinor: serializeMinorUnit(balanceMinor),
        creditLimitMinor: serializeMinorUnit(creditLimitMinor),
        monthlyLimitMinor: serializeMinorUnit(monthlyLimitMinor),
        limitUsedPercent,
        transactionSuccessRate,
        totalTransactions,
        currency: account?.currency || 'USD',
      },
      spendOverTime,
      resourceBreakdown,
      statusBreakdown,
    };
  }

  /**
   * Retrieves paginated usage records.
   */
  async getUsageRecords(models: TenantModels, query: UsageRecordsQueryInput) {
    const filter: Record<string, unknown> = {};
    if (query.resource) {
      filter.resource = query.resource;
    }
    if (query.billed !== undefined) {
      filter.billed = query.billed;
    }
    if (query.startDate || query.endDate) {
      filter.ts = {};
      if (query.startDate) (filter.ts as Record<string, unknown>).$gte = new Date(query.startDate);
      if (query.endDate) (filter.ts as Record<string, unknown>).$lte = new Date(query.endDate);
    }

    const skip = (query.page - 1) * query.limit;
    const [records, total] = await Promise.all([
      models.UsageRecord.find(filter).sort({ ts: -1 }).skip(skip).limit(query.limit),
      models.UsageRecord.countDocuments(filter),
    ]);

    return {
      records,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * Retrieves paginated tenant audit logs.
   */
  async getTenantAuditLogs(models: TenantModels, query: AuditLogQueryInput) {
    const filter: Record<string, unknown> = {};
    if (query.action) {
      filter.action = query.action;
    }
    if (query.outcome) {
      filter.outcome = query.outcome;
    }
    if (query.startDate || query.endDate) {
      filter.ts = {};
      if (query.startDate) (filter.ts as Record<string, unknown>).$gte = new Date(query.startDate);
      if (query.endDate) (filter.ts as Record<string, unknown>).$lte = new Date(query.endDate);
    }

    const skip = (query.page - 1) * query.limit;
    const [logs, total] = await Promise.all([
      models.TenantAuditLog.find(filter).sort({ ts: -1 }).skip(skip).limit(query.limit),
      models.TenantAuditLog.countDocuments(filter),
    ]);

    return {
      logs,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * Returns active pricing plans for resources.
   */
  getPricingPlans() {
    return [
      this.pricingEngine.getPlan('api_calls'),
      this.pricingEngine.getPlan('compute_minutes'),
      this.pricingEngine.getPlan('storage_gb'),
      this.pricingEngine.getPlan('bandwidth_egress'),
      this.pricingEngine.getPlan('ai_tokens'),
    ];
  }
}

export const usageService = new UsageService();
