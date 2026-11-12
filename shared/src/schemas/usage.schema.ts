import { z } from 'zod';

export const recordUsageSchema = z
  .object({
    resource: z.string().min(1, 'Resource identifier is required').max(100),
    units: z.number().positive('Units must be positive'),
    costMinor: z
      .union([
        z.number().int().nonnegative('Cost must be non-negative integer in minor units'),
        z.string().regex(/^\d+$/, 'costMinor string must contain digits only'),
      ])
      .optional(),
    idempotencyKey: z.string().min(1).max(100).optional(),
    settleImmediately: z.boolean().default(true),
    metadata: z.record(z.unknown()).optional(),
    ts: z.string().datetime().optional(),
  })
  .strict();

export type RecordUsageInput = z.infer<typeof recordUsageSchema>;

export const batchRecordUsageSchema = z
  .object({
    records: z.array(recordUsageSchema).min(1, 'At least 1 usage record is required').max(100, 'Maximum 100 records per batch'),
    idempotencyKey: z.string().min(1).max(100).optional(),
  })
  .strict();

export type BatchRecordUsageInput = z.infer<typeof batchRecordUsageSchema>;

export const aggregateAndSettleSchema = z
  .object({
    resource: z.string().min(1).max(100).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .strict();

export type AggregateAndSettleInput = z.infer<typeof aggregateAndSettleSchema>;

export const usageRecordsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  resource: z.string().optional(),
  billed: z
    .enum(['true', 'false'])
    .transform((val) => val === 'true')
    .optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type UsageRecordsQueryInput = z.infer<typeof usageRecordsQuerySchema>;

export const analyticsQuerySchema = z.object({
  range: z.enum(['7d', '30d', '12m']).default('30d'),
});

export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE', 'BLOCKED']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;
