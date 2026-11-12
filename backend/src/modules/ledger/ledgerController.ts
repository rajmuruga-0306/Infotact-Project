import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { createTransactionSchema, transactionQuerySchema } from '@ledgerguard/shared';
import { LedgerService, ledgerService } from './ledgerService.js';
import { Redis } from 'ioredis';

export class LedgerController {
  constructor(
    private service: LedgerService = ledgerService,
    private redisClient?: Redis
  ) {}

  setRedisClient(client: Redis) {
    this.redisClient = client;
  }

  createTransaction = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.auth || !req.tenant) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication and tenant context required', requestId },
      });
      return;
    }

    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || (req.headers['x-idempotency-key'] as string);

    if (!idempotencyKey || !idempotencyKey.trim()) {
      res.status(400).json({
        error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required', requestId },
      });
      return;
    }

    // Validate body
    const parseResult = createTransactionSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.errors.map((e) => e.message).join(', '),
          requestId,
        },
      });
      return;
    }

    // Compute request payload hash (using rawBody buffer or canonical JSON)
    const rawBody = req.rawBody ? req.rawBody.toString('utf-8') : JSON.stringify(req.body);
    const requestHash = createHash('sha256').update(rawBody).digest('hex');

    const signatureKeyId = (req.headers['x-key-id'] as string) || 'default_key';
    const simulateFailureHeader = req.headers['x-simulate-failure'] as string | undefined;

    try {
      const transaction = await this.service.processTransaction({
        input: parseResult.data,
        idempotencyKey: idempotencyKey.trim(),
        requestHash,
        signatureKeyId,
        actorId: req.auth.userId,
        orgId: req.auth.orgId,
        models: req.tenant.models,
        simulateFailureHeader,
        clientIp: req.ip || '127.0.0.1',
        requestId,
        redisClient: this.redisClient,
      });

      res.status(transaction.status === 'POSTED' ? 201 : 200).json(transaction);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      let statusCode = 400;
      let errorCode = 'TRANSACTION_FAILED';

      if (message.includes('SIMULATION_PROHIBITED_IN_PRODUCTION')) {
        statusCode = 400;
        errorCode = 'SIMULATION_PROHIBITED_IN_PRODUCTION';
      } else if (message.includes('IDEMPOTENCY_PAYLOAD_MISMATCH')) {
        statusCode = 409;
        errorCode = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
      } else if (message.includes('TRANSACTION_IN_FLIGHT')) {
        statusCode = 409;
        errorCode = 'TRANSACTION_IN_FLIGHT';
      } else if (message.includes('INSUFFICIENT_FUNDS')) {
        statusCode = 402;
        errorCode = 'INSUFFICIENT_FUNDS';
      } else if (message.includes('MONTHLY_LIMIT_EXCEEDED')) {
        statusCode = 402;
        errorCode = 'MONTHLY_LIMIT_EXCEEDED';
      } else if (message.includes('REFUND_EXCEEDS_ORIGINAL_AMOUNT')) {
        statusCode = 422;
        errorCode = 'REFUND_EXCEEDS_ORIGINAL_AMOUNT';
      } else if (message.includes('INVALID_REFUND_TARGET')) {
        statusCode = 422;
        errorCode = 'INVALID_REFUND_TARGET';
      } else if (message.includes('ORIGINAL_TRANSACTION_NOT_FOUND')) {
        statusCode = 404;
        errorCode = 'ORIGINAL_TRANSACTION_NOT_FOUND';
      } else if (message.includes('LOCK_LOST')) {
        statusCode = 500;
        errorCode = 'LOCK_LOST';
      }

      res.status(statusCode).json({
        error: {
          code: errorCode,
          message,
          requestId,
        },
      });
    }
  };

  getTransactions = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.tenant) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required', requestId },
      });
      return;
    }

    const queryParse = transactionQuerySchema.safeParse(req.query);
    if (!queryParse.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: queryParse.error.message, requestId },
      });
      return;
    }

    try {
      const result = await this.service.getTransactions(req.tenant.models, queryParse.data);
      res.status(200).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: { code: 'QUERY_FAILED', message, requestId },
      });
    }
  };

  getTransactionById = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.tenant) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required', requestId },
      });
      return;
    }

    try {
      const result = await this.service.getTransactionById(req.tenant.models, req.params.id!);
      res.status(200).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isNotFound = message.includes('NOT_FOUND');
      res.status(isNotFound ? 404 : 500).json({
        error: { code: isNotFound ? 'NOT_FOUND' : 'QUERY_FAILED', message, requestId },
      });
    }
  };

  getBalance = async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId || 'unknown';

    if (!req.tenant) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required', requestId },
      });
      return;
    }

    try {
      const balance = await this.service.getBalance(req.tenant.models);
      res.status(200).json(balance);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: { code: 'BALANCE_FETCH_FAILED', message, requestId },
      });
    }
  };
}

export const ledgerController = new LedgerController();
