import { z } from 'zod';

export const createTransactionSchema = z
  .object({
    type: z.enum(['charge', 'refund']),
    amountMinor: z.union([
      z.number().int('Amount must be an integer in minor units').positive('Amount must be greater than zero'),
      z.string().regex(/^\d+$/, 'Amount string must be positive numeric digits'),
    ]),
    currency: z.string().length(3, 'Currency must be a 3-letter ISO code').toUpperCase(),
    resource: z.string().min(1, 'Resource identifier is required').max(100),
    originalTransactionId: z.string().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.type === 'refund' && !data.originalTransactionId) {
        return false;
      }
      return true;
    },
    {
      message: 'originalTransactionId is required for refund transactions',
      path: ['originalTransactionId'],
    }
  );

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const transactionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'POSTED', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK']).optional(),
  type: z.enum(['charge', 'refund']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type TransactionQueryInput = z.infer<typeof transactionQuerySchema>;
