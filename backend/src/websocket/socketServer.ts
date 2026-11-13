import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { Redis } from 'ioredis';
import {
  SOCKET_EVENTS,
  TransactionSucceededPayload,
  LimitWarningPayload,
  SecurityAlertPayload,
  UsageUpdatedPayload,
  ServerToClientEvents,
  ClientToServerEvents,
} from '@ledgerguard/shared';
import { env } from '../config/env.js';
import { JwtService, jwtService as defaultJwtService, DecodedAccessToken } from '../gateway/jwt/jwtService.js';
import { getRedisClient } from '../redis/client.js';

export interface SocketData {
  user: {
    userId: string;
    orgId: string;
    role: string;
    email: string;
    familyId: string;
  };
}

export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type TypedSocketServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketServerOptions {
  jwtService?: JwtService;
  redisClient?: Redis;
  corsOrigins?: string[];
}

let ioInstance: TypedSocketServer | null = null;

/**
 * Initializes and configures the Socket.IO server on top of an existing Node HTTP server.
 */
export function initSocketServer(httpServer: HttpServer, options: SocketServerOptions = {}): TypedSocketServer {
  const jwt = options.jwtService || defaultJwtService;
  const redis = options.redisClient || getRedisClient();
  const allowedOrigins = options.corsOrigins || env.CORS_ORIGINS;

  const io: TypedSocketServer = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          return callback(null, true);
        }
        return callback(new Error(`WebSocket origin '${origin}' not allowed by CORS`));
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Handshake Authentication Middleware
  io.use(async (socket: TypedSocket, next) => {
    try {
      let token: string | undefined;

      // 1. Extract from auth payload
      if (socket.handshake.auth && typeof socket.handshake.auth.token === 'string') {
        token = socket.handshake.auth.token;
      }

      // 2. Extract from Authorization header
      if (!token && socket.handshake.headers.authorization) {
        const parts = socket.handshake.headers.authorization.split(' ');
        if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
          token = parts[1];
        }
      }

      // 3. Extract from cookie
      if (!token && socket.handshake.headers.cookie) {
        const cookies = socket.handshake.headers.cookie.split(';').map((c) => c.trim());
        for (const cookie of cookies) {
          if (cookie.startsWith('access_token=')) {
            token = cookie.substring('access_token='.length);
            break;
          }
        }
      }

      if (!token) {
        return next(new Error('AUTHENTICATION_REQUIRED: Valid access token must be provided'));
      }

      // Verify RS256 JWT
      let decoded: DecodedAccessToken;
      try {
        decoded = jwt.verifyAccessToken(token);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Invalid access token';
        return next(new Error(`UNAUTHORIZED: ${message}`));
      }

      // Check for revoked token family in Redis
      try {
        const isRevoked = await redis.get(`token:family:revoked:${decoded.familyId}`);
        if (isRevoked) {
          return next(new Error('SESSION_REVOKED: Token family has been revoked'));
        }
      } catch {
        // Fail closed if Redis is down
        return next(new Error('SERVICE_UNAVAILABLE: Authentication verification unavailable'));
      }

      // Attach user context to socket
      socket.data.user = {
        userId: decoded.userId,
        orgId: decoded.orgId,
        role: decoded.role,
        email: decoded.email,
        familyId: decoded.familyId,
      };

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authentication failure';
      next(new Error(`AUTHENTICATION_ERROR: ${message}`));
    }
  });

  io.on('connection', (socket: TypedSocket) => {
    const orgId = socket.data.user.orgId;
    const userId = socket.data.user.userId;

    // Join tenant private room
    const tenantRoom = `tenant:${orgId}`;
    socket.join(tenantRoom);

    // Join user room
    socket.join(`user:${userId}`);

    socket.on('ping', () => {
      socket.emit('ping' as any);
    });
  });

  ioInstance = io;
  return io;
}

/**
 * Returns the active Socket.IO server instance if initialized.
 */
export function getSocketServer(): TypedSocketServer | null {
  return ioInstance;
}

/**
 * Sets or mocks the active Socket.IO server instance (useful for testing).
 */
export function setSocketServer(io: TypedSocketServer | null): void {
  ioInstance = io;
}

/**
 * Broadcasts a successful posted transaction event to the tenant room.
 */
export function broadcastTransactionPosted(orgId: string, payload: TransactionSucceededPayload): void {
  if (!ioInstance) return;
  ioInstance.to(`tenant:${orgId}`).emit(SOCKET_EVENTS.TRANSACTION_POSTED, payload);
  ioInstance.to(`tenant:${orgId}`).emit(SOCKET_EVENTS.TRANSACTION_SUCCEEDED, payload);
}

/**
 * Broadcasts a monthly limit threshold warning to the tenant room.
 */
export function broadcastLimitWarning(orgId: string, payload: LimitWarningPayload): void {
  if (!ioInstance) return;
  ioInstance.to(`tenant:${orgId}`).emit(SOCKET_EVENTS.LIMIT_WARNING, payload);
}

/**
 * Broadcasts a security alert (replay attack, signature failure, etc.) to the tenant room.
 */
export function broadcastSecurityAlert(orgId: string, payload: SecurityAlertPayload): void {
  if (!ioInstance) return;
  ioInstance.to(`tenant:${orgId}`).emit(SOCKET_EVENTS.SECURITY_ALERT, payload);
}

/**
 * Broadcasts metered usage updates to the tenant room.
 */
export function broadcastUsageUpdated(orgId: string, payload: UsageUpdatedPayload): void {
  if (!ioInstance) return;
  ioInstance.to(`tenant:${orgId}`).emit(SOCKET_EVENTS.USAGE_UPDATED, payload);
}
