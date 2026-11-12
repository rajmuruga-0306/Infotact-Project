import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { RedisMemoryServer } from 'redis-memory-server';
import { Redis } from 'ioredis';
import {
  JwtService,
  createAuthenticateMiddleware,
  requireRole,
  createRateLimiter,
  csrfProtect,
} from '../src/gateway/index.js';
import { getRedisClient, revokeFamily } from '../src/redis/client.js';

describe('Gateway Security & Authentication Tests (Phase 2 Gate)', () => {
  let redisServer: RedisMemoryServer;
  let redisClient: Redis;
  let jwtService: JwtService;

  // Active keypair
  const activeKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Previous keypair (for rotation testing)
  const prevKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Untrusted attacker keypair (for forgery testing)
  const attackerKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let app: express.Express;

  beforeAll(async () => {
    redisServer = new RedisMemoryServer();
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    redisClient = getRedisClient(`redis://${host}:${port}`);

    jwtService = new JwtService({
      keyId: 'key-active-1',
      privateKeyPem: activeKeys.privateKey,
      publicKeys: {
        'key-active-1': activeKeys.publicKey,
        'key-prev-0': prevKeys.publicKey,
      },
    });

    const authenticate = createAuthenticateMiddleware(jwtService, redisClient);

    app = express();
    app.use(express.json());

    // Public test route
    app.get('/test/public', (_req, res) => res.json({ status: 'public' }));

    // Protected test route
    app.get('/test/protected', authenticate, (req: Request, res: Response) => {
      res.json({ status: 'ok', auth: req.auth });
    });

    // Admin-only test route (requires ORG_ADMIN)
    app.get('/test/admin', authenticate, requireRole('ORG_ADMIN'), (_req, res) => {
      res.json({ status: 'admin-ok' });
    });

    // Rate-limited test route (limit: 3 requests per 10s)
    const testLimiter = createRateLimiter({
      windowMs: 10000,
      maxLimit: 3,
      keyPrefix: 'ratelimit:test',
      client: redisClient,
    });
    app.get('/test/ratelimited', testLimiter, (_req, res) => res.json({ status: 'rate-limited-ok' }));

    // CSRF-protected test route
    app.post('/test/csrf-endpoint', csrfProtect, (_req, res) => res.json({ status: 'csrf-passed' }));
  });

  afterAll(async () => {
    await redisClient.quit();
    await redisServer.stop();
  });

  describe('RS256 JWT Security Defenses', () => {
    it('accepts a valid RS256 token signed by the active key', async () => {
      const validToken = jwtService.signAccessToken({
        userId: 'usr_valid_1',
        orgId: 'org_1',
        role: 'ORG_ADMIN',
        email: 'alice@acme.com',
        familyId: 'fam_valid_1',
      });

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.auth.userId).toBe('usr_valid_1');
      expect(res.body.auth.role).toBe('ORG_ADMIN');
    });

    it('rejects a forged token signed by an untrusted attacker private key (401)', async () => {
      const forgedToken = jwt.sign(
        {
          orgId: 'org_1',
          role: 'PLATFORM_ADMIN',
          email: 'hacker@evil.com',
          familyId: 'fam_evil',
        },
        attackerKeys.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'key-active-1',
          issuer: 'ledgerguard-gateway',
          audience: 'ledgerguard-api',
          subject: 'usr_evil',
          expiresIn: 900,
        }
      );

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects token with alg: none attack (401)', async () => {
      // Construct unsigned token with alg: none
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'usr_admin',
          orgId: 'org_1',
          role: 'ORG_ADMIN',
          iss: 'ledgerguard-gateway',
          aud: 'ledgerguard-api',
          exp: Math.floor(Date.now() / 1000) + 900,
        })
      ).toString('base64url');

      const noneToken = `${header}.${payload}.`;

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${noneToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects HMAC algorithm confusion attack (HS256 using RSA public key) (401)', async () => {
      // Attacker signs using HS256 with the server's public key as the secret
      const confusedToken = jwt.sign(
        {
          orgId: 'org_1',
          role: 'PLATFORM_ADMIN',
          email: 'hacker@evil.com',
          familyId: 'fam_evil',
        },
        activeKeys.publicKey, // Public key treated as HMAC secret!
        {
          algorithm: 'HS256',
          keyid: 'key-active-1',
          issuer: 'ledgerguard-gateway',
          audience: 'ledgerguard-api',
          subject: 'usr_evil',
          expiresIn: 900,
        }
      );

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${confusedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects expired token (401)', async () => {
      const expiredToken = jwt.sign(
        {
          orgId: 'org_1',
          role: 'ORG_ADMIN',
          email: 'alice@acme.com',
          familyId: 'fam_expired',
        },
        activeKeys.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'key-active-1',
          issuer: 'ledgerguard-gateway',
          audience: 'ledgerguard-api',
          subject: 'usr_alice',
          expiresIn: -10, // Expired 10 seconds ago
        }
      );

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('supports key rotation: accepts token signed with previously valid key (key-prev-0)', async () => {
      const prevKeyToken = jwt.sign(
        {
          orgId: 'org_1',
          role: 'BILLING_USER',
          email: 'bob@acme.com',
          familyId: 'fam_prev_key',
        },
        prevKeys.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'key-prev-0', // Previous key ID registered in service
          issuer: 'ledgerguard-gateway',
          audience: 'ledgerguard-api',
          subject: 'usr_bob',
          expiresIn: 900,
        }
      );

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${prevKeyToken}`);

      expect(res.status).toBe(200);
      expect(res.body.auth.role).toBe('BILLING_USER');
    });

    it('rejects token with unknown kid (401)', async () => {
      const unknownKidToken = jwt.sign(
        {
          orgId: 'org_1',
          role: 'ORG_ADMIN',
          email: 'alice@acme.com',
          familyId: 'fam_unknown',
        },
        activeKeys.privateKey,
        {
          algorithm: 'RS256',
          keyid: 'key-non-existent-99',
          issuer: 'ledgerguard-gateway',
          audience: 'ledgerguard-api',
          subject: 'usr_alice',
          expiresIn: 900,
        }
      );

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${unknownKidToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('UNKNOWN_KEY_ID');
    });
  });

  describe('Immediate Invalidation & Logout Protection', () => {
    it('immediately rejects access token after family is revoked (401 TOKEN_REVOKED)', async () => {
      const familyId = 'fam_immediate_logout_test';
      const token = jwtService.signAccessToken({
        userId: 'usr_logout_test',
        orgId: 'org_logout_test',
        role: 'ORG_ADMIN',
        email: 'logout@test.com',
        familyId,
      });

      // 1. Initial request succeeds
      const beforeRes = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${token}`);
      expect(beforeRes.status).toBe(200);

      // 2. User logs out -> family is revoked in Redis
      await revokeFamily(familyId, 900, redisClient);

      // 3. Subsequent request with the same access token is immediately rejected!
      const afterRes = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(afterRes.status).toBe(401);
      expect(afterRes.body.error.code).toBe('TOKEN_REVOKED');
    });
  });

  describe('Role-Based Access Control (RBAC)', () => {
    it('rejects access with 403 FORBIDDEN when user has insufficient role', async () => {
      const viewerToken = jwtService.signAccessToken({
        userId: 'usr_viewer_1',
        orgId: 'org_1',
        role: 'VIEWER', // VIEWER attempting ORG_ADMIN route
        email: 'viewer@acme.com',
        familyId: 'fam_viewer',
      });

      const res = await request(app)
        .get('/test/admin')
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('permits access when user possesses the required ORG_ADMIN role', async () => {
      const adminToken = jwtService.signAccessToken({
        userId: 'usr_admin_1',
        orgId: 'org_1',
        role: 'ORG_ADMIN',
        email: 'admin@acme.com',
        familyId: 'fam_admin',
      });

      const res = await request(app)
        .get('/test/admin')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('admin-ok');
    });
  });

  describe('Rate Limiting Middleware', () => {
    it('returns 429 TOO_MANY_REQUESTS with Retry-After when limit is exceeded', async () => {
      // Limit is 3 requests
      const r1 = await request(app).get('/test/ratelimited');
      expect(r1.status).toBe(200);

      const r2 = await request(app).get('/test/ratelimited');
      expect(r2.status).toBe(200);

      const r3 = await request(app).get('/test/ratelimited');
      expect(r3.status).toBe(200);

      // 4th request must be rate-limited
      const r4 = await request(app).get('/test/ratelimited');
      expect(r4.status).toBe(429);
      expect(r4.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(r4.headers['retry-after']).toBeDefined();
    });
  });

  describe('CSRF Protection Middleware', () => {
    it('rejects request when custom CSRF header is missing (403)', async () => {
      const res = await request(app)
        .post('/test/csrf-endpoint')
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_HEADER_MISSING');
    });

    it('rejects request when Origin is not allowed (403)', async () => {
      const res = await request(app)
        .post('/test/csrf-endpoint')
        .set('Origin', 'https://malicious-website.com')
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('accepts request when Origin is allowed and custom header is provided (200)', async () => {
      const res = await request(app)
        .post('/test/csrf-endpoint')
        .set('Origin', 'http://localhost:5173')
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('csrf-passed');
    });
  });
});
