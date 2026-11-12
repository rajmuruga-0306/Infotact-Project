import { z } from 'zod';

export const updateLimitsSchema = z
  .object({
    creditLimitMinor: z.number().int().nonnegative('Credit limit must be non-negative'),
    monthlyLimitMinor: z.number().int().positive('Monthly limit must be positive'),
  })
  .strict();

export type UpdateLimitsInput = z.infer<typeof updateLimitsSchema>;

export const createUserSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(12, 'Password must be at least 12 characters'),
    role: z.enum(['ORG_ADMIN', 'BILLING_USER', 'VIEWER']),
  })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const rotateKeySchema = z
  .object({
    publicKeyPem: z.string().optional(),
  })
  .strict();

export type RotateKeyInput = z.infer<typeof rotateKeySchema>;
