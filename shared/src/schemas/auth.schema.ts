import { z } from 'zod';

export const registerOrgSchema = z.object({
  name: z.string().min(2, 'Organization name must be at least 2 characters').max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase alphanumeric characters and hyphens'),
  adminEmail: z.string().email('Invalid email address'),
  adminPassword: z.string().min(12, 'Password must be at least 12 characters'),
  adminFullName: z.string().min(2, 'Full name must be at least 2 characters').max(100),
  /**
   * Client-generated RSA-256 public key in PEM format.
   * Generated client-side using Web Crypto. Server never receives private key.
   */
  publicKeyPem: z.string().min(50, 'Valid RSA public key in PEM format is required'),
});

export type RegisterOrgInput = z.infer<typeof registerOrgSchema>;

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export const switchOrgSchema = z.object({
  targetOrgId: z.string().min(1, 'Target organization ID is required'),
});

export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;
