import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { Redis } from 'ioredis';
import {
  recordUsageSchema,
  batchRecordUsageSchema,
  aggregateAndSettleSchema,
  usageRecordsQuerySchema,
  analyticsQuerySchema,
  auditLogQuerySchema,
} from '@ledgerguard/shared';
import { usageService, UsageService } from './usageService.js';
import { getRedisClient } from '../../redis/client.js';

export class UsageController {
  constructor(
    private readonly service: UsageService = usageService,
    private readonly redisClient: Redis = getRedisClient()
  ) {}

  /**
   * POST /api/v1/usage/record
   * Ingests a single usage record, computes tiered pricing, and optionally settles immediately into the ledger.
   */
  recordUsage = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = recordUsageSchema.parse(req.body);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const actorId = req.auth?.userId || 'system_api';
      const orgId = req.auth?.orgId || req.tenant.org._id.toString();
      const signatureKeyId = (req.headers['x-key-id'] as string) || req.tenant.org.keyId;
      const clientIp = req.ip || '127.0.0.1';
      const requestId = req.requestId || 'unknown';

      const result = await this.service.recordUsage({
        input,
        actorId,
        orgId,
        signatureKeyId,
        models: req.tenant.models,
        requestId,
        clientIp,
        redisClient: this.redisClient,
      });

      res.status(201).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  /**
   * POST /api/v1/usage/batch
   * Ingests a batch of usage records.
   */
  recordUsageBatch = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = batchRecordUsageSchema.parse(req.body);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const actorId = req.auth?.userId || 'system_api';
      const orgId = req.auth?.orgId || req.tenant.org._id.toString();
      const signatureKeyId = (req.headers['x-key-id'] as string) || req.tenant.org.keyId;
      const clientIp = req.ip || '127.0.0.1';
      const requestId = req.requestId || 'unknown';

      const result = await this.service.recordUsageBatch({
        input,
        actorId,
        orgId,
        signatureKeyId,
        models: req.tenant.models,
        requestId,
        clientIp,
        redisClient: this.redisClient,
      });

      res.status(201).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  /**
   * POST /api/v1/usage/aggregate-and-settle
   * Aggregates unbilled usage and creates a consolidated double-entry ledger transaction.
   */
  aggregateAndSettle = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = aggregateAndSettleSchema.parse(req.body);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const actorId = req.auth?.userId || 'system_api';
      const orgId = req.auth?.orgId || req.tenant.org._id.toString();
      const signatureKeyId = (req.headers['x-key-id'] as string) || req.tenant.org.keyId;
      const clientIp = req.ip || '127.0.0.1';
      const requestId = req.requestId || 'unknown';

      const result = await this.service.aggregateAndSettle({
        input,
        actorId,
        orgId,
        signatureKeyId,
        models: req.tenant.models,
        requestId,
        clientIp,
        redisClient: this.redisClient,
      });

      res.status(200).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  /**
   * GET /api/v1/usage/analytics
   * Returns spend summary, spend trends, resource breakdown, and status breakdown.
   */
  getAnalytics = async (req: Request, res: Response): Promise<void> => {
    try {
      const query = analyticsQuerySchema.parse(req.query);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const result = await this.service.getAnalytics(req.tenant.models, query);
      res.status(200).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  /**
   * GET /api/v1/usage/records
   * Returns paginated list of usage records.
   */
  getUsageRecords = async (req: Request, res: Response): Promise<void> => {
    try {
      const query = usageRecordsQuerySchema.parse(req.query);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const result = await this.service.getUsageRecords(req.tenant.models, query);
      res.status(200).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  /**
   * GET /api/v1/usage/pricing-plans
   * Returns active pricing plans and tiers.
   */
  getPricingPlans = async (_req: Request, res: Response): Promise<void> => {
    try {
      const plans = this.service.getPricingPlans();
      res.status(200).json({ plans });
    } catch (err: unknown) {
      this.handleError(err, _req, res);
    }
  };

  /**
   * GET /api/v1/usage/audit-logs
   * Returns paginated tenant audit logs.
   */
  getTenantAuditLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      const query = auditLogQuerySchema.parse(req.query);

      if (!req.tenant) {
        res.status(500).json({
          error: {
            code: 'TENANT_CONTEXT_MISSING',
            message: 'Tenant context was not initialized for this request',
          },
        });
        return;
      }

      const result = await this.service.getTenantAuditLogs(req.tenant.models, query);
      res.status(200).json(result);
    } catch (err: unknown) {
      this.handleError(err, req, res);
    }
  };

  private handleError(err: unknown, req: Request, res: Response): void {
    const requestId = req.requestId || 'unknown';

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request payload or query parameters',
          details: err.errors,
          requestId,
        },
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);

    if (message.startsWith('INSUFFICIENT_FUNDS')) {
      res.status(402).json({
        error: {
          code: 'INSUFFICIENT_FUNDS',
          message: 'Transaction rejected: Available balance and credit limit exceeded',
          requestId,
        },
      });
      return;
    }

    if (message.startsWith('MONTHLY_LIMIT_EXCEEDED')) {
      res.status(402).json({
        error: {
          code: 'MONTHLY_LIMIT_EXCEEDED',
          message: 'Transaction rejected: Monthly spending limit exceeded',
          requestId,
        },
      });
      return;
    }

    if (message.startsWith('CONCURRENT_SETTLEMENT_IN_PROGRESS')) {
      res.status(409).json({
        error: {
          code: 'CONCURRENT_SETTLEMENT_IN_PROGRESS',
          message: 'A billing settlement run is currently in progress for this tenant',
          requestId,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message,
        requestId,
      },
    });
  }
}

export const usageController = new UsageController();
