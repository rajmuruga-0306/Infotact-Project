import { ClientSession, Types } from 'mongoose';
import { Redis } from 'ioredis';
import {
  CreateTransactionInput,
  TransactionQueryInput,
  VIRTUAL_CLEARING_ACCOUNT,
  toBigIntMinor,
  serializeMinorUnit,
} from '@ledgerguard/shared';
import { TenantModels } from '../../models/tenant/index.js';
import { ITransaction } from '../../models/tenant/Transaction.js';
import {
  acquireDistributedLock,
  startLockWatchdog,
  verifyLockOwnership,
  releaseDistributedLock,
} from '../../redis/lock.js';
import { getRedisClient } from '../../redis/client.js';

export interface ProcessTransactionParams {
  input: CreateTransactionInput;
  idempotencyKey: string;
  requestHash: string;
  signatureKeyId: string;
  actorId: string;
  orgId: string;
  models: TenantModels;
  simulateFailureHeader?: string | undefined;
  clientIp?: string | undefined;
  requestId?: string | undefined;
  redisClient?: Redis | undefined;
}

export class LedgerService {
  /**
   * Executes a financial transaction (charge or refund) idempotently, inside a MongoDB ACID session,
   * protected by a lease-renewing Redis distributed lock and atomic balance/refund checks.
   */
  async processTransaction(params: ProcessTransactionParams): Promise<ITransaction> {
    const {
      input,
      idempotencyKey,
      requestHash,
      signatureKeyId,
      actorId,
      orgId,
      models,
      simulateFailureHeader,
      redisClient = getRedisClient(),
    } = params;

    // 1. Strict Production Simulation Guard
    const isProd = process.env.NODE_ENV === 'production';
    if (simulateFailureHeader && isProd) {
      throw new Error('SIMULATION_PROHIBITED_IN_PRODUCTION: Failure simulation headers are prohibited in production environments');
    }

    // 2. Pre-Lock Idempotency Check
    const existingBefore = await models.Transaction.findOne({ idempotencyKey });
    if (existingBefore) {
      if (existingBefore.requestHash !== requestHash) {
        throw new Error(
          `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${idempotencyKey}' was previously used with a different request payload`
        );
      }
      return existingBefore;
    }

    // 3. Acquire Distributed Lock with Heartbeat Watchdog
    const lockKey = `lock:txn:${orgId}:${idempotencyKey}`;
    const lock = await acquireDistributedLock(lockKey, 15000, redisClient);

    if (!lock.acquired) {
      // Re-check idempotency in case it committed right as lock was contested
      const postContest = await models.Transaction.findOne({ idempotencyKey });
      if (postContest) {
        if (postContest.requestHash !== requestHash) {
          throw new Error(
            `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${idempotencyKey}' was previously used with a different request payload`
          );
        }
        return postContest;
      }
      throw new Error(
        `TRANSACTION_IN_FLIGHT: Transaction with idempotency key '${idempotencyKey}' is currently processing`
      );
    }

    const watchdog = startLockWatchdog(
      lockKey,
      lock.token,
      15000,
      5000,
      undefined,
      redisClient
    );

    const amountMinor = toBigIntMinor(input.amountMinor);

    try {
      // 4. Post-Lock Idempotency Check
      const existingUnderLock = await models.Transaction.findOne({ idempotencyKey });
      if (existingUnderLock) {
        if (existingUnderLock.requestHash !== requestHash) {
          throw new Error(
            `IDEMPOTENCY_PAYLOAD_MISMATCH: Idempotency key '${idempotencyKey}' was previously used with a different request payload`
          );
        }
        return existingUnderLock;
      }

      // 5. Start MongoDB ACID Transaction Session with automatic write-conflict retries
      const session: ClientSession = await models.Account.db.startSession();
      let committedTxn: ITransaction | null = null;

      try {
        await session.withTransaction(async () => {
          // Test Failure Simulation Hooks (allowed only in non-production)
          if (simulateFailureHeader === 'insufficient_funds') {
            throw new Error('INSUFFICIENT_FUNDS: Simulated insufficient funds balance error');
          }
          if (simulateFailureHeader === 'network_disconnect') {
            throw new Error('NETWORK_ERROR: Simulated network failure during transaction execution');
          }
          if (simulateFailureHeader === 'database_error') {
            throw new Error('DATABASE_ERROR: Simulated database commit error');
          }

          if (input.type === 'charge') {
            const currentMonthStr = new Date().toISOString().slice(0, 7);

            // Atomic MongoDB Aggregation Update Pipeline on PRIMARY Account:
            // Validates available balance ($add: [balance, creditLimit] >= amount)
            // Validates monthly limit with atomic rollover reset if currentMonth differs
            const updatedAccount = await models.Account.findOneAndUpdate(
              {
                accountRef: 'PRIMARY',
                $expr: {
                  $and: [
                    { $gte: [{ $add: ['$balanceMinor', '$creditLimitMinor'] }, amountMinor] },
                    {
                      $lte: [
                        {
                          $cond: {
                            if: { $eq: ['$currentMonth', currentMonthStr] },
                            then: { $add: ['$currentMonthSpendMinor', amountMinor] },
                            else: amountMinor,
                          },
                        },
                        '$monthlyLimitMinor',
                      ],
                    },
                  ],
                },
              },
              [
                {
                  $set: {
                    balanceMinor: { $subtract: ['$balanceMinor', amountMinor] },
                    currentMonthSpendMinor: {
                      $cond: {
                        if: { $eq: ['$currentMonth', currentMonthStr] },
                        then: { $add: ['$currentMonthSpendMinor', amountMinor] },
                        else: amountMinor,
                      },
                    },
                    currentMonth: currentMonthStr,
                  },
                },
              ],
              { session, new: true }
            );

            if (!updatedAccount) {
              const current = await models.Account.findOne({ accountRef: 'PRIMARY' }).session(session);
              if (current && current.balanceMinor + current.creditLimitMinor < amountMinor) {
                throw new Error('INSUFFICIENT_FUNDS: Available balance and credit limit exceeded');
              }
              throw new Error('MONTHLY_LIMIT_EXCEEDED: Transaction exceeds monthly spending limit');
            }

            // Counterpart Virtual Clearing Account: balance increases
            const updatedClearing = await models.Account.findOneAndUpdate(
              { accountRef: VIRTUAL_CLEARING_ACCOUNT },
              { $inc: { balanceMinor: amountMinor } },
              { session, new: true, upsert: true }
            );

            // Record Transaction inside session
            const [txn] = await models.Transaction.create(
              [
                {
                  idempotencyKey,
                  requestHash,
                  type: 'charge',
                  amountMinor,
                  currency: input.currency,
                  resource: input.resource,
                  status: 'POSTED',
                  signatureKeyId,
                  createdBy: actorId,
                  refundedAmountMinor: 0n,
                },
              ],
              { session, ordered: true }
            );

            // Record balanced Double-Entry Lines:
            // 1. DEBIT PRIMARY (balance decreases)
            // 2. CREDIT PLATFORM_CLEARING (balance increases)
            await models.LedgerEntry.create(
              [
                {
                  transactionId: txn!._id,
                  accountRef: 'PRIMARY',
                  direction: 'DEBIT',
                  amountMinor,
                  balanceAfterMinor: updatedAccount.balanceMinor,
                },
                {
                  transactionId: txn!._id,
                  accountRef: VIRTUAL_CLEARING_ACCOUNT,
                  direction: 'CREDIT',
                  amountMinor,
                  balanceAfterMinor: updatedClearing.balanceMinor,
                },
              ],
              { session, ordered: true }
            );

            committedTxn = txn!;
          } else if (input.type === 'refund') {
            if (!input.originalTransactionId) {
              throw new Error('MISSING_ORIGINAL_TRANSACTION: Refund requires originalTransactionId');
            }

            // Atomic conditional increment on original charge:
            // Ensures cumulative refunds (refundedAmountMinor + amountMinor) <= amountMinor
            const updatedCharge = await models.Transaction.findOneAndUpdate(
              {
                _id: new Types.ObjectId(input.originalTransactionId),
                status: 'POSTED',
                type: 'charge',
                $expr: {
                  $lte: [{ $add: ['$refundedAmountMinor', amountMinor] }, '$amountMinor'],
                },
              },
              {
                $inc: { refundedAmountMinor: amountMinor },
              },
              { session, new: true }
            );

            if (!updatedCharge) {
              const existingCharge = await models.Transaction.findById(input.originalTransactionId).session(session);
              if (!existingCharge) {
                throw new Error('ORIGINAL_TRANSACTION_NOT_FOUND: Referenced original transaction does not exist');
              }
              if (existingCharge.status !== 'POSTED' || existingCharge.type !== 'charge') {
                throw new Error('INVALID_REFUND_TARGET: Only posted charge transactions can be refunded');
              }
              throw new Error(
                `REFUND_EXCEEDS_ORIGINAL_AMOUNT: Cumulative refunds (${existingCharge.refundedAmountMinor} + ${amountMinor}) exceed original charge amount (${existingCharge.amountMinor})`
              );
            }

            // Refund credits customer account (balance increases)
            const updatedAccount = await models.Account.findOneAndUpdate(
              { accountRef: 'PRIMARY' },
              { $inc: { balanceMinor: amountMinor } },
              { session, new: true }
            );

            // Virtual clearing account debited (balance decreases)
            const updatedClearing = await models.Account.findOneAndUpdate(
              { accountRef: VIRTUAL_CLEARING_ACCOUNT },
              { $inc: { balanceMinor: -amountMinor } },
              { session, new: true, upsert: true }
            );

            // Record Refund Transaction inside session
            const [txn] = await models.Transaction.create(
              [
                {
                  idempotencyKey,
                  requestHash,
                  type: 'refund',
                  amountMinor,
                  currency: input.currency,
                  resource: input.resource,
                  status: 'POSTED',
                  signatureKeyId,
                  createdBy: actorId,
                  originalTransactionId: updatedCharge._id,
                  refundedAmountMinor: 0n,
                },
              ],
              { session, ordered: true }
            );

            // Record balanced Double-Entry Lines:
            // 1. CREDIT PRIMARY (customer balance credited)
            // 2. DEBIT PLATFORM_CLEARING (clearing account debited)
            await models.LedgerEntry.create(
              [
                {
                  transactionId: txn!._id,
                  accountRef: 'PRIMARY',
                  direction: 'CREDIT',
                  amountMinor,
                  balanceAfterMinor: updatedAccount!.balanceMinor,
                },
                {
                  transactionId: txn!._id,
                  accountRef: VIRTUAL_CLEARING_ACCOUNT,
                  direction: 'DEBIT',
                  amountMinor,
                  balanceAfterMinor: updatedClearing.balanceMinor,
                },
              ],
              { session, ordered: true }
            );

            committedTxn = txn!;
          }

          // 6. Pre-Commit Distributed Lock Ownership Check
          const isLockOwned = await verifyLockOwnership(lockKey, lock.token, watchdog, redisClient);
          if (!isLockOwned) {
            throw new Error('LOCK_LOST: Redis distributed lock ownership was lost during processing. Transaction aborted.');
          }
        });

        return committedTxn!;
      } catch (err: unknown) {
        // 8. Persist Failure Outside the Aborted Session
        const errMsg = err instanceof Error ? err.message : String(err);
        const isSimulationOrDbError =
          errMsg.includes('Simulated') || errMsg.includes('NETWORK_ERROR') || errMsg.includes('DATABASE_ERROR');
        const failureStatus = isSimulationOrDbError ? 'ROLLED_BACK' : 'FAILED';

        try {
          await models.Transaction.create({
            idempotencyKey,
            requestHash,
            type: input.type,
            amountMinor,
            currency: input.currency,
            resource: input.resource,
            status: failureStatus,
            failureReason: errMsg,
            signatureKeyId,
            createdBy: actorId,
            originalTransactionId: input.originalTransactionId ? new Types.ObjectId(input.originalTransactionId) : undefined,
            refundedAmountMinor: 0n,
          });
        } catch {
          // If already inserted or concurrent record exists
        }

        throw err;
      } finally {
        await session.endSession();
      }
    } finally {
      // 9. Clean up watchdog and release distributed lock
      await releaseDistributedLock(lockKey, lock.token, watchdog, redisClient);
    }
  }

  /**
   * Retrieves paginated transactions with optional status, type, and date filters.
   */
  async getTransactions(models: TenantModels, query: TransactionQueryInput) {
    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }
    if (query.type) {
      filter.type = query.type;
    }
    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate) {
        (filter.createdAt as Record<string, unknown>).$gte = new Date(query.startDate);
      }
      if (query.endDate) {
        (filter.createdAt as Record<string, unknown>).$lte = new Date(query.endDate);
      }
    }

    const skip = (query.page - 1) * query.limit;

    const [transactions, total] = await Promise.all([
      models.Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
      models.Transaction.countDocuments(filter),
    ]);

    return {
      transactions,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * Retrieves a single transaction with its associated double-entry ledger lines.
   */
  async getTransactionById(models: TenantModels, id: string) {
    const txn = await models.Transaction.findById(id);
    if (!txn) {
      throw new Error('NOT_FOUND: Transaction not found');
    }

    const entries = await models.LedgerEntry.find({ transactionId: txn._id }).sort({ createdAt: 1 });

    return {
      transaction: txn,
      entries,
    };
  }

  /**
   * Retrieves current balance, credit limits, monthly spending, and available credit.
   */
  async getBalance(models: TenantModels) {
    const account = await models.Account.findOne({ accountRef: 'PRIMARY' });
    if (!account) {
      throw new Error('NOT_FOUND: Primary account not initialized');
    }

    const availableMinor = account.balanceMinor + account.creditLimitMinor;

    return {
      balanceMinor: serializeMinorUnit(account.balanceMinor),
      creditLimitMinor: serializeMinorUnit(account.creditLimitMinor),
      monthlyLimitMinor: serializeMinorUnit(account.monthlyLimitMinor),
      currentMonth: account.currentMonth,
      currentMonthSpendMinor: serializeMinorUnit(account.currentMonthSpendMinor),
      availableMinor: serializeMinorUnit(availableMinor),
      currency: account.currency,
      asOf: new Date().toISOString(),
    };
  }
}

export const ledgerService = new LedgerService();
