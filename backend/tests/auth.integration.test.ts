import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';
import mongoose, { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import { generateKeyPairSync } from 'node:crypto';
import { getControlModels, ControlModels, setControlDbConnection } from '../src/models/control/index.js';
import { getRedisClient, setRedisClient } from '../src/redis/client.js';
import { JwtService, createAuthenticateMiddleware } from '../src/gateway/index.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { AuthController } from '../src/modules/auth/authController.js';
import { createAuthRouter } from '../src/modules/auth/authRoutes.js';

describe('Authentication Module & Multi-Tenancy Integration Tests', () => {
  let replSet: MongoMemoryReplSet;
  let redisServer: RedisMemoryServer;
  let mongoConn: Connection;
  let redisClient: Redis;
  let models: ControlModels;
  let jwtService: JwtService;
  let app: Express;

  // Active Gateway RSA Keys
  const gatewayKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Sample Tenant RSA Keys
  const tenant1Keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const tenant2Keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeAll(async () => {
    // 1. In-memory MongoDB Replica Set for ACID transactions
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const mongoUri = replSet.getUri();
    mongoConn = mongoose.createConnection(mongoUri, { autoIndex: true });
    setControlDbConnection(mongoConn);
    models = getControlModels(mongoConn);
    await Promise.all([
      models.Organization.init(),
      models.User.init(),
      models.OrganizationMembership.init(),
      models.PlatformAuditLog.init(),
    ]);

    // 2. In-memory Redis for tokens, rate limits, and Lua scripts
    redisServer = new RedisMemoryServer();
    const redisHost = await redisServer.getHost();
    const redisPort = await redisServer.getPort();
    redisClient = getRedisClient(`redis://${redisHost}:${redisPort}`);
    setRedisClient(redisClient);

    // 3. JWT Service
    jwtService = new JwtService({
      keyId: 'test-gw-1',
      privateKeyPem: gatewayKeys.privateKey,
      publicKeys: {
        'test-gw-1': gatewayKeys.publicKey,
      },
    });

    // 4. Auth Service and Controller
    const authService = new AuthService({
      dbConn: mongoConn,
      redisClient,
      jwtService,
    });
    const authController = new AuthController(authService);
    const testAuthenticate = createAuthenticateMiddleware(jwtService, redisClient);
    const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
    const authRouter = createAuthRouter(authController, testAuthenticate, noopLimiter);

    // 5. Test Express App
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', authRouter);
  }, 30000);

  afterAll(async () => {
    setControlDbConnection(null);
    setRedisClient(null);
    await mongoConn.close();
    await replSet.stop();
    await redisClient.quit();
    await redisServer.stop();
  });

  describe('1. Organization Registration (POST /api/v1/auth/register-org)', () => {
    it('atomically registers an organization, admin user, and membership', async () => {
      const payload = {
        name: 'Stark Industries',
        slug: 'stark-industries',
        adminEmail: 'tony@stark.com',
        adminPassword: 'SuperSecretPassword123!',
        adminFullName: 'Tony Stark',
        publicKeyPem: tenant1Keys.publicKey,
      };

      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.organization.slug).toBe('stark-industries');
      expect(res.body.user.email).toBe('tony@stark.com');
      expect(res.body.membership.role).toBe('ORG_ADMIN');
      expect(res.body.membership.status).toBe('ACTIVE');

      // Verify zero-knowledge in DB: only public key stored, no private key
      const dbOrg = await models.Organization.findById(res.body.organization.id);
      expect(dbOrg).not.toBeNull();
      expect(dbOrg!.publicKeyPem).toContain('BEGIN PUBLIC KEY');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((dbOrg as any).privateKeyPem).toBeUndefined();

      // Verify bcrypt cost 12 on user password
      const dbUser = await models.User.findById(res.body.user.id);
      expect(dbUser).not.toBeNull();
      expect(dbUser!.passwordHash.startsWith('$2b$12$')).toBe(true);

      // Verify audit log entry was created
      const auditLog = await models.PlatformAuditLog.findOne({
        action: 'AUTH_REGISTER_ORG',
        actorId: res.body.user.id,
      });
      expect(auditLog).not.toBeNull();
      expect(auditLog!.outcome).toBe('SUCCESS');
    });

    it('rejects duplicate organization slug with 409 SLUG_ALREADY_EXISTS', async () => {
      const payload = {
        name: 'Stark Industries Duplicate',
        slug: 'stark-industries', // Duplicate slug!
        adminEmail: 'tony2@stark.com',
        adminPassword: 'SuperSecretPassword123!',
        adminFullName: 'Tony Stark Duplicate',
        publicKeyPem: tenant1Keys.publicKey,
      };

      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLUG_ALREADY_EXISTS');
    });

    it('rejects duplicate user email with 409 EMAIL_ALREADY_EXISTS', async () => {
      const payload = {
        name: 'Stark Labs',
        slug: 'stark-labs',
        adminEmail: 'tony@stark.com', // Duplicate email!
        adminPassword: 'SuperSecretPassword123!',
        adminFullName: 'Tony Stark',
        publicKeyPem: tenant1Keys.publicKey,
      };

      const res = await request(app)
        .post('/api/v1/auth/register-org')
        .send(payload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });
  });

  describe('2. User Login & Cookie Issuance (POST /api/v1/auth/login)', () => {
    it('authenticates valid credentials, issues RS256 token and HttpOnly cookie', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'tony@stark.com',
          password: 'SuperSecretPassword123!',
        });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.user.email).toBe('tony@stark.com');
      expect(res.body.organization.slug).toBe('stark-industries');
      expect(res.body.organization.role).toBe('ORG_ADMIN');

      // Verify HttpOnly cookie header was set
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies).toBeDefined();
      const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('HttpOnly');
    });

    it('rejects incorrect password with 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'tony@stark.com',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects unknown email with 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@stark.com',
          password: 'AnyPassword123!',
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('3. User Profile (GET /api/v1/auth/me)', () => {
    it('returns user profile and active organization memberships', async () => {
      // 1. Log in to get access token
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'tony@stark.com', password: 'SuperSecretPassword123!' });

      const token = loginRes.body.accessToken;

      // 2. Fetch /me
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user.email).toBe('tony@stark.com');
      expect(meRes.body.currentOrganization.slug).toBe('stark-industries');
      expect(meRes.body.organizations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('4. Token Refresh & Tripwire Reuse Detection (POST /api/v1/auth/refresh)', () => {
    it('rotates refresh token via cookie and issues new access token', async () => {
      // 1. Log in to get initial cookie
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'tony@stark.com', password: 'SuperSecretPassword123!' });

      const initialCookie = loginRes.headers['set-cookie'] as unknown as string[];

      // 2. Refresh using the cookie + custom CSRF header
      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', initialCookie)
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.accessToken).toBeDefined();

      // Verify updated cookie is returned
      const newCookie = refreshRes.headers['set-cookie'] as unknown as string[];
      expect(newCookie).toBeDefined();
    });

    it('detects token reuse, revokes family, and immediately terminates sessions', async () => {
      // 1. Log in to get initial cookie
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'tony@stark.com', password: 'SuperSecretPassword123!' });

      const stolenCookie = loginRes.headers['set-cookie'] as unknown as string[];

      // 2. Legitimate user rotates token -> gets new cookie and new access token
      const legitimateRefreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', stolenCookie)
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(legitimateRefreshRes.status).toBe(200);
      const activeAccessToken = legitimateRefreshRes.body.accessToken;

      // 3. Attacker replays the OLD stolenCookie!
      const attackRes = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', stolenCookie)
        .set('X-Requested-With', 'XMLHttpRequest');

      // Tripwire fired!
      expect(attackRes.status).toBe(401);
      expect(attackRes.body.error.code).toBe('TOKEN_REUSE_DETECTED');

      // 4. Verify that the legitimate user's active access token is now immediately rejected!
      const verifyRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${activeAccessToken}`);

      expect(verifyRes.status).toBe(401);
      expect(verifyRes.body.error.code).toBe('TOKEN_REVOKED');

      // 5. Verify security incident audit log
      const incidentLog = await models.PlatformAuditLog.findOne({
        action: 'TOKEN_REUSE_DETECTED',
        outcome: 'BLOCKED',
      });
      expect(incidentLog).not.toBeNull();
    });
  });

  describe('5. Multi-Organization Switching (POST /api/v1/auth/switch-org)', () => {
    it('switches organization, immediately revoking old tokens and issuing new family', async () => {
      // 1. Register a second organization (Wayne Enterprises)
      const org2Res = await request(app)
        .post('/api/v1/auth/register-org')
        .send({
          name: 'Wayne Enterprises',
          slug: 'wayne-enterprises',
          adminEmail: 'bruce@wayne.com',
          adminPassword: 'BatPassword1234!',
          adminFullName: 'Bruce Wayne',
          publicKeyPem: tenant2Keys.publicKey,
        });
      expect(org2Res.status).toBe(201);
      const org2Id = org2Res.body.organization.id;

      // 2. Grant Tony Stark membership in Wayne Enterprises (BILLING_USER)
      const tonyUser = await models.User.findOne({ email: 'tony@stark.com' });
      await models.OrganizationMembership.create({
        userId: tonyUser!._id,
        orgId: org2Id,
        role: 'BILLING_USER',
        status: 'ACTIVE',
      });

      // 3. Tony logs in (starts in Stark Industries)
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'tony@stark.com', password: 'SuperSecretPassword123!' });

      const oldToken = loginRes.body.accessToken;
      expect(loginRes.body.organization.slug).toBe('stark-industries');

      // 4. Tony switches organization to Wayne Enterprises
      const switchRes = await request(app)
        .post('/api/v1/auth/switch-org')
        .set('Authorization', `Bearer ${oldToken}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ targetOrgId: org2Id });

      expect(switchRes.status).toBe(200);
      expect(switchRes.body.organization.name).toBe('Wayne Enterprises');
      expect(switchRes.body.organization.role).toBe('BILLING_USER');
      const newToken = switchRes.body.accessToken;

      // 5. Verify oldToken is immediately revoked!
      const oldCheckRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${oldToken}`);
      expect(oldCheckRes.status).toBe(401);
      expect(oldCheckRes.body.error.code).toBe('TOKEN_REVOKED');

      // 6. Verify newToken works and reflects the new organization
      const newCheckRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${newToken}`);
      expect(newCheckRes.status).toBe(200);
      expect(newCheckRes.body.currentOrganization.slug).toBe('wayne-enterprises');
      expect(newCheckRes.body.currentOrganization.role).toBe('BILLING_USER');
    });

    it('rejects switch to an organization where user has no membership with 403', async () => {
      // Create third unjoined organization
      const unjoinedOrg = await models.Organization.create({
        name: 'Oscorp',
        slug: 'oscorp',
        dbName: 'lg_tenant_oscorp',
        publicKeyPem: tenant1Keys.publicKey,
        keyId: 'key_oscorp_1',
      });

      // Login as Bruce Wayne
      const bruceLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'bruce@wayne.com', password: 'BatPassword1234!' });

      const res = await request(app)
        .post('/api/v1/auth/switch-org')
        .set('Authorization', `Bearer ${bruceLogin.body.accessToken}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ targetOrgId: unjoinedOrg._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('6. Logout (POST /api/v1/auth/logout)', () => {
    it('immediately revokes token family and clears refresh cookie', async () => {
      // 1. Log in
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'tony@stark.com', password: 'SuperSecretPassword123!' });

      const token = loginRes.body.accessToken;

      // 2. Call logout
      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Requested-With', 'XMLHttpRequest');

      expect(logoutRes.status).toBe(200);

      // Verify cookie is cleared (expires in past / empty)
      const cookies = logoutRes.headers['set-cookie'] as unknown as string[];
      expect(cookies).toBeDefined();
      const clearedCookie = cookies.find((c) => c.startsWith('refreshToken=;'));
      expect(clearedCookie).toBeDefined();

      // 3. Immediate check: token is instantly revoked!
      const afterRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(afterRes.status).toBe(401);
      expect(afterRes.body.error.code).toBe('TOKEN_REVOKED');
    });
  });
});
