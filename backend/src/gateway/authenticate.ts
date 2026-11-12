import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { AuthContext } from '@ledgerguard/shared';
import { jwtService, JwtService } from './jwt/jwtService.js';
import { isFamilyRevoked } from '../redis/client.js';

// Extend Express Request interface to include auth context
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Factory for authenticate middleware supporting custom jwtService or redis client (for testing).
 */
export function createAuthenticateMiddleware(customJwtService?: JwtService, customRedisClient?: Redis) {
  const service = customJwtService || jwtService;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    const requestId = req.requestId || 'unknown';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header',
          requestId,
        },
      });
      return;
    }

    const token = authHeader.slice(7).trim();

    try {
      // 1. Verify RS256 signature and token claims
      const payload = service.verifyAccessToken(token);

      // 2. Immediate Revocation Check in Redis (Fail-Closed with 503 on Redis failure)
      if (payload.familyId) {
        try {
          const revoked = await isFamilyRevoked(payload.familyId, customRedisClient);
          if (revoked) {
            res.status(401).json({
              error: {
                code: 'TOKEN_REVOKED',
                message: 'Session has been logged out or terminated',
                requestId,
              },
            });
            return;
          }
        } catch (redisErr: unknown) {
          // Fail closed with controlled 503 Service Unavailable response:
          // Differentiates infrastructure failure from an invalid token
          // eslint-disable-next-line no-console
          console.error(`[Security Fail-Closed]: Redis unreachable for family check '${payload.familyId}'`, redisErr);
          res.status(503).json({
            error: {
              code: 'AUTH_SERVICE_UNAVAILABLE',
              message: 'Authentication verification service temporarily unavailable',
              requestId,
            },
          });
          return;
        }
      }

      // 3. Attach authenticated context to request
      req.auth = payload;
      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid or expired access token';
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message,
          requestId,
        },
      });
    }
  };
}

export const authenticate = createAuthenticateMiddleware();
