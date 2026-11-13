import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { RedisMemoryServer } from 'redis-memory-server';
import { Redis } from 'ioredis';
import { SOCKET_EVENTS } from '@ledgerguard/shared';
import { JwtService } from '../src/gateway/jwt/jwtService.js';
import { getRedisClient, setRedisClient } from '../src/redis/client.js';
import {
  initSocketServer,
  setSocketServer,
  broadcastTransactionPosted,
  broadcastLimitWarning,
  broadcastSecurityAlert,
  broadcastUsageUpdated,
  TypedSocketServer,
} from '../src/websocket/socketServer.js';

describe('Real-Time WebSockets & Tenant Room Isolation Tests (Phase 6 Gate)', () => {
  let httpServer: HttpServer;
  let ioServer: TypedSocketServer;
  let serverPort: number;
  let serverUrl: string;

  let redisServer: RedisMemoryServer;
  let redisClient: Redis;
  let jwtService: JwtService;

  // Keypair for test JWT verification
  const testKeys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const orgAlphaId = 'org_alpha_ws';
  const orgBetaId = 'org_beta_ws';

  let validAlphaToken: string;
  let validBetaToken: string;
  let revokedFamilyToken: string;

  beforeAll(async () => {
    // 1. In-memory Redis
    redisServer = new RedisMemoryServer();
    const redisHost = await redisServer.getHost();
    const redisPort = await redisServer.getPort();
    redisClient = getRedisClient(`redis://${redisHost}:${redisPort}`);
    setRedisClient(redisClient);

    // 2. JWT Service
    jwtService = new JwtService({
      keyId: 'key-ws-gateway',
      privateKeyPem: testKeys.privateKey,
      publicKeys: {
        'key-ws-gateway': testKeys.publicKey,
      },
    });

    // 3. HTTP Server and Socket.IO Server
    const app = express();
    httpServer = createServer(app);
    ioServer = initSocketServer(httpServer, {
      jwtService,
      redisClient,
      corsOrigins: ['*'],
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // 4. Generate Tokens
    validAlphaToken = jwtService.signAccessToken({
      userId: 'user_alpha',
      orgId: orgAlphaId,
      role: 'ORG_ADMIN',
      email: 'admin@alpha.com',
      familyId: 'fam_alpha_ws',
    });

    validBetaToken = jwtService.signAccessToken({
      userId: 'user_beta',
      orgId: orgBetaId,
      role: 'ORG_ADMIN',
      email: 'admin@beta.com',
      familyId: 'fam_beta_ws',
    });

    revokedFamilyToken = jwtService.signAccessToken({
      userId: 'user_revoked',
      orgId: orgAlphaId,
      role: 'ORG_ADMIN',
      email: 'revoked@alpha.com',
      familyId: 'fam_revoked_ws',
    });

    // Mark fam_revoked_ws as revoked in Redis
    await redisClient.set('token:family:revoked:fam_revoked_ws', '1');
  }, 30000);

  afterAll(async () => {
    setSocketServer(null);
    if (ioServer) {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (redisClient) await redisClient.quit();
    if (redisServer) await redisServer.stop();
  });

  describe('1. Handshake Authentication & Security Guards', () => {
    it('rejects connection when no access token is provided (AUTHENTICATION_REQUIRED)', async () => {
      const socket = ioClient(serverUrl, {
        transports: ['websocket'],
        reconnection: false,
      });

      const error = await new Promise<string>((resolve) => {
        socket.on('connect_error', (err) => {
          resolve(err.message);
        });
      });

      expect(error).toContain('AUTHENTICATION_REQUIRED');
      socket.close();
    });

    it('rejects connection when token is invalid or corrupted (UNAUTHORIZED)', async () => {
      const socket = ioClient(serverUrl, {
        auth: { token: 'invalid.jwt.token' },
        transports: ['websocket'],
        reconnection: false,
      });

      const error = await new Promise<string>((resolve) => {
        socket.on('connect_error', (err) => {
          resolve(err.message);
        });
      });

      expect(error).toContain('UNAUTHORIZED');
      socket.close();
    });

    it('rejects connection when token family has been revoked in Redis (SESSION_REVOKED)', async () => {
      const socket = ioClient(serverUrl, {
        auth: { token: revokedFamilyToken },
        transports: ['websocket'],
        reconnection: false,
      });

      const error = await new Promise<string>((resolve) => {
        socket.on('connect_error', (err) => {
          resolve(err.message);
        });
      });

      expect(error).toContain('SESSION_REVOKED');
      socket.close();
    });
  });

  describe('2. Tenant Room Scoping & Event Broadcasting', () => {
    let alphaSocket: ClientSocket;
    let betaSocket: ClientSocket;

    beforeAll(async () => {
      // Connect Tenant Alpha Socket
      alphaSocket = ioClient(serverUrl, {
        auth: { token: validAlphaToken },
        transports: ['websocket'],
      });
      await new Promise<void>((resolve) => alphaSocket.on('connect', () => resolve()));

      // Connect Tenant Beta Socket
      betaSocket = ioClient(serverUrl, {
        auth: { token: validBetaToken },
        transports: ['websocket'],
      });
      await new Promise<void>((resolve) => betaSocket.on('connect', () => resolve()));
    });

    afterAll(() => {
      if (alphaSocket) alphaSocket.close();
      if (betaSocket) betaSocket.close();
    });

    it('broadcasts transaction:posted strictly to tenant room without leaking to other tenants', async () => {
      const alphaReceived: unknown[] = [];
      const betaReceived: unknown[] = [];

      alphaSocket.on(SOCKET_EVENTS.TRANSACTION_POSTED, (data) => {
        alphaReceived.push(data);
      });

      betaSocket.on(SOCKET_EVENTS.TRANSACTION_POSTED, (data) => {
        betaReceived.push(data);
      });

      // Broadcast transaction posted for Tenant Alpha
      broadcastTransactionPosted(orgAlphaId, {
        transactionId: 'txn_ws_alpha_001',
        idempotencyKey: 'idem_ws_alpha_001',
        type: 'charge',
        amountMinor: 5000,
        currency: 'USD',
        balanceAfterMinor: -5000,
        status: 'POSTED',
        completedAt: new Date().toISOString(),
      });

      // Wait 100ms for websocket frame propagation
      await new Promise((r) => setTimeout(r, 100));

      expect(alphaReceived).toHaveLength(1);
      expect((alphaReceived[0] as any).transactionId).toBe('txn_ws_alpha_001');

      // Tenant Beta MUST receive 0 events!
      expect(betaReceived).toHaveLength(0);
    });

    it('broadcasts limit:warning when monthly spending reaches threshold', async () => {
      const limitPromise = new Promise<any>((resolve) => {
        alphaSocket.once(SOCKET_EVENTS.LIMIT_WARNING, (data) => {
          resolve(data);
        });
      });

      broadcastLimitWarning(orgAlphaId, {
        orgId: orgAlphaId,
        currentSpendMinor: 85000,
        monthlyLimitMinor: 100000,
        percentUsed: 85,
        warnedAt: new Date().toISOString(),
      });

      const warning = await limitPromise;
      expect(warning).toBeDefined();
      expect(warning.percentUsed).toBe(85);
      expect(warning.currentSpendMinor).toBe(85000);
    });

    it('broadcasts security:alert on suspicious replay or tampering', async () => {
      const alertPromise = new Promise<any>((resolve) => {
        alphaSocket.once(SOCKET_EVENTS.SECURITY_ALERT, (data) => {
          resolve(data);
        });
      });

      broadcastSecurityAlert(orgAlphaId, {
        type: 'REPLAY_ATTACK',
        severity: 'high',
        message: 'Replay attack detected for key key_alpha_1',
        requestId: 'req_alert_test',
        occurredAt: new Date().toISOString(),
      });

      const alert = await alertPromise;
      expect(alert).toBeDefined();
      expect(alert.type).toBe('REPLAY_ATTACK');
      expect(alert.severity).toBe('high');
    });

    it('broadcasts usage:updated when metered consumption occurs', async () => {
      const usagePromise = new Promise<any>((resolve) => {
        alphaSocket.once(SOCKET_EVENTS.USAGE_UPDATED, (data) => {
          resolve(data);
        });
      });

      broadcastUsageUpdated(orgAlphaId, {
        resource: 'compute_minutes',
        units: 250,
        costMinor: 2500,
        ts: new Date().toISOString(),
      });

      const usage = await usagePromise;
      expect(usage).toBeDefined();
      expect(usage.resource).toBe('compute_minutes');
      expect(usage.units).toBe(250);
      expect(usage.costMinor).toBe(2500);
    });
  });
});
