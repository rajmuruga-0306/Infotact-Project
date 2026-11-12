import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.js';

describe('Environment Configuration Validation', () => {
  const validProductionEnv = {
    NODE_ENV: 'production',
    PORT: '7860',
    DEMO_MODE: 'false',
    MONGODB_URI: 'mongodb+srv://admin:pass@cluster0.example.net/?retryWrites=true&w=majority',
    REDIS_URL: 'rediss://default:token@host.upstash.io:6379',
    JWT_PRIVATE_KEY: 'LS0tLS1CRUdJTi...Key',
    JWT_PUBLIC_KEY: 'LS0tLS1CRUdJTi...Pub',
    CORS_ORIGINS: 'https://ledgerguard.vercel.app,https://admin.ledgerguard.vercel.app',
  };

  it('successfully validates complete production environment configuration', () => {
    const config = validateEnv(validProductionEnv);
    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(7860);
    expect(config.DEMO_MODE).toBe(false);
    expect(config.CORS_ORIGINS).toEqual([
      'https://ledgerguard.vercel.app',
      'https://admin.ledgerguard.vercel.app',
    ]);
  });

  it('rejects CORS wildcard in configuration', () => {
    const invalidEnv = {
      ...validProductionEnv,
      CORS_ORIGINS: '*',
    };
    expect(() => validateEnv(invalidEnv)).toThrow(/CORS wildcard \(\*\) is strictly prohibited/);
  });

  it('rejects missing MONGODB_URI in production', () => {
    const invalidEnv = {
      ...validProductionEnv,
      MONGODB_URI: '',
    };
    expect(() => validateEnv(invalidEnv)).toThrow(/MONGODB_URI is required/);
  });

  it('rejects missing JWT keys in production', () => {
    const invalidEnv = {
      ...validProductionEnv,
      JWT_PRIVATE_KEY: '',
    };
    expect(() => validateEnv(invalidEnv)).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('allows safe test configuration defaults in test mode', () => {
    const testConfig = validateEnv({ NODE_ENV: 'test' });
    expect(testConfig.NODE_ENV).toBe('test');
    expect(testConfig.MONGODB_URI).toBeDefined();
    expect(testConfig.REDIS_URL).toBeDefined();
    expect(testConfig.JWT_PRIVATE_KEY).toBeDefined();
  });
});
