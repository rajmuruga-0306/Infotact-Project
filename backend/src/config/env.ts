import { z } from 'zod';
import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(7860),
  DEMO_MODE: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Database
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  CONTROL_DB_NAME: z.string().default('ledgerguard_control'),
  MAX_TENANT_CONNECTIONS: z.coerce.number().int().positive().default(10),
  IDLE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // API Gateway JWT (RS256)
  JWT_KEY_ID: z.string().default('lg-gw-1'),
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY (Base64 PEM) is required'),
  JWT_PUBLIC_KEY: z.string().min(1, 'JWT_PUBLIC_KEY (Base64 PEM) is required'),
  JWT_PREVIOUS_KEY_ID: z.string().optional(),
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  JWT_ISSUER: z.string().default('ledgerguard-gateway'),
  JWT_AUDIENCE: z.string().default('ledgerguard-api'),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(900),

  // CORS
  CORS_ORIGINS: z
    .string()
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0, 'At least one CORS origin must be specified')
    .refine((origins) => !origins.includes('*'), 'CORS wildcard (*) is strictly prohibited'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates arbitrary environment variables.
 * Used for both runtime initialization and isolated unit testing.
 */
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const effectiveEnv = { ...raw };
  const targetEnv = raw.NODE_ENV ?? (process.env.NODE_ENV === 'test' ? 'test' : 'development');

  if (targetEnv === 'test') {
    effectiveEnv.NODE_ENV = 'test';
    effectiveEnv.MONGODB_URI = effectiveEnv.MONGODB_URI || 'mongodb://localhost:27017/test';
    effectiveEnv.REDIS_URL = effectiveEnv.REDIS_URL || 'redis://localhost:6379';
    effectiveEnv.JWT_PRIVATE_KEY = effectiveEnv.JWT_PRIVATE_KEY || 'dGVzdC1wcml2YXRlLWtleQ==';
    effectiveEnv.JWT_PUBLIC_KEY = effectiveEnv.JWT_PUBLIC_KEY || 'dGVzdC1wdWJsaWMta2V5';
    effectiveEnv.CORS_ORIGINS = effectiveEnv.CORS_ORIGINS || 'http://localhost:5173';
  }

  const result = envSchema.safeParse(effectiveEnv);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => ` - [${issue.path.join('.')}]: ${issue.message}`)
      .join('\n');
    throw new Error(`CRITICAL: Environment validation failed:\n${issues}`);
  }

  return result.data;
}

// Export singleton validated config
export const env: Env = validateEnv(process.env);
