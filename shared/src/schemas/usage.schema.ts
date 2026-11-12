import { z } from 'zod';

export const recordUsageSchema = z
  .object({
    resource: z.string().min(1, 'Resource identifier is required').max(100),
    units: z.number().positive('Units must be positive'),
    costMinor: z.number().int().nonnegative('Cost must be non-negative integer in minor units'),
    ts: z.string().datetime().optional(),
  })
  .strict();

export type RecordUsageInput = z.infer<typeof recordUsageSchema>;

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
