import { Request, Response, NextFunction } from 'express';
import { createHash, createSign, createVerify, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { getRedisClient } from '../redis/client.js';
import { broadcastSecurityAlert } from '../websocket/index.js';

export interface TenantSignatureHeaders {
  signature: string;
  keyId: string;
  timestamp: string;
  nonce: string;
}

export interface SignTenantRequestParams {
  privateKeyPem: string;
  keyId: string;
  method: string;
  path: string;
  body?: unknown;
  timestamp?: string | number;
  nonce?: string;
}

/**
 * Builds the canonical request string for cryptographic RSA-SHA256 signing and verification.
 * Format:
 * <METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<SHA256_HEX(BODY)>
 */
export function buildCanonicalRequestString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string | undefined
): string {
  let bodyBuffer: Buffer;
  if (Buffer.isBuffer(rawBody)) {
    bodyBuffer = rawBody;
  } else if (typeof rawBody === 'string') {
    bodyBuffer = Buffer.from(rawBody, 'utf-8');
  } else {
    bodyBuffer = Buffer.from('', 'utf-8');
  }

  const bodyHash = createHash('sha256').update(bodyBuffer).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/**
 * Client helper to cryptographically sign a tenant API request using the tenant's RSA private key.
 * (Zero-knowledge: executed exclusively on client/browser side).
 */
export function signTenantRequest(params: SignTenantRequestParams): {
  'X-Signature': string;
  'X-Key-Id': string;
  'X-Timestamp': string;
  'X-Nonce': string;
} {
  const timestamp = (params.timestamp ?? Date.now()).toString();
  const nonce = params.nonce ?? randomUUID();

  let rawBody: Buffer;
  if (Buffer.isBuffer(params.body)) {
    rawBody = params.body;
  } else if (typeof params.body === 'string') {
    rawBody = Buffer.from(params.body, 'utf-8');
  } else if (params.body !== undefined) {
    rawBody = Buffer.from(JSON.stringify(params.body), 'utf-8');
  } else {
    rawBody = Buffer.from('', 'utf-8');
  }

  const canonical = buildCanonicalRequestString(
    params.method,
    params.path,
    timestamp,
    nonce,
    rawBody
  );

  const signer = createSign('RSA-SHA256');
  signer.update(canonical);
  const signature = signer.sign(params.privateKeyPem, 'base64');

  return {
    'X-Signature': signature,
    'X-Key-Id': params.keyId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

export interface VerifyTenantSignatureOptions {
  redisClient?: Redis;
  maxClockSkewMs?: number; // Default 300,000ms (5 minutes)
}

/**
 * Middleware factory to verify tenant RSA-SHA256 request signatures.
 * Enforces zero-knowledge: verifies solely against tenant's stored publicKeyPem.
 * Enforces replay protection: single-use nonces stored in Redis with 300s TTL.
 * Enforces clock-skew bounds: rejects requests older or newer than 300 seconds.
 */
export function createVerifyTenantSignatureMiddleware(options: VerifyTenantSignatureOptions = {}) {
  const maxClockSkewMs = options.maxClockSkewMs || 300000;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = req.requestId || 'unknown';
    const redis = options.redisClient || getRedisClient();

    // 1. Extract signature headers
    const signature = req.headers['x-signature'] as string | undefined;
    const keyId = req.headers['x-key-id'] as string | undefined;
    const timestampStr = req.headers['x-timestamp'] as string | undefined;
    const nonce = req.headers['x-nonce'] as string | undefined;

    if (!signature || !keyId || !timestampStr || !nonce) {
      res.status(401).json({
        error: {
          code: 'MISSING_SIGNATURE_HEADERS',
          message: 'Missing required signature headers: X-Signature, X-Key-Id, X-Timestamp, X-Nonce',
          requestId,
        },
      });
      return;
    }

    // 2. Validate clock skew
    const timestampMs = Number(timestampStr);
    const parsedTime = isNaN(timestampMs) ? new Date(timestampStr).getTime() : timestampMs;

    if (isNaN(parsedTime)) {
      res.status(401).json({
        error: {
          code: 'INVALID_TIMESTAMP',
          message: 'Invalid X-Timestamp format',
          requestId,
        },
      });
      return;
    }

    const clockDelta = Math.abs(Date.now() - parsedTime);
    if (clockDelta > maxClockSkewMs) {
      res.status(401).json({
        error: {
          code: 'TIMESTAMP_EXPIRED',
          message: `Request timestamp is stale or skewed by more than ${Math.round(maxClockSkewMs / 1000)} seconds`,
          requestId,
        },
      });
      return;
    }

    // 3. Resolve tenant public key from request context
    // req.tenant?.org is attached by tenantContext middleware, or req.auth.orgId
    const org = req.tenant?.org;
    if (!org) {
      res.status(401).json({
        error: {
          code: 'TENANT_CONTEXT_REQUIRED',
          message: 'Tenant context must be resolved prior to signature verification',
          requestId,
        },
      });
      return;
    }

    // 4. Verify Key ID
    if (org.keyId !== keyId) {
      res.status(401).json({
        error: {
          code: 'UNKNOWN_KEY_ID',
          message: `Provided keyId '${keyId}' does not match active tenant key '${org.keyId}'`,
          requestId,
        },
      });
      return;
    }

    // 5. Anti-Replay: Atomically check and store nonce in Redis
    const orgId = typeof org._id === 'string' ? org._id : org._id.toString();
    const nonceKey = `nonce:${orgId}:${nonce}`;
    const ttlSeconds = Math.ceil(maxClockSkewMs / 1000);

    try {
      const setSuccess = await redis.set(nonceKey, '1', 'EX', ttlSeconds, 'NX');
      if (!setSuccess) {
        try {
          broadcastSecurityAlert(orgId, {
            type: 'REPLAY_ATTACK',
            severity: 'high',
            message: `Replay attack detected: nonce '${nonce}' has already been used`,
            requestId,
            occurredAt: new Date().toISOString(),
          });
        } catch {
          // Non-blocking
        }

        res.status(401).json({
          error: {
            code: 'REPLAY_ATTACK_DETECTED',
            message: 'Replay attack detected: nonce has already been used within active window',
            requestId,
          },
        });
        return;
      }
    } catch (err: unknown) {
      // Fail closed if Redis is unreachable
      // eslint-disable-next-line no-console
      console.error('[Security Fail-Closed]: Redis unreachable for nonce check', err);
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Security validation service temporarily unavailable',
          requestId,
        },
      });
      return;
    }

    // 6. Build canonical request string
    let rawBodyBuffer: Buffer;
    if (req.rawBody && req.rawBody.length > 0) {
      rawBodyBuffer = req.rawBody;
    } else if (req.body && Object.keys(req.body).length > 0) {
      rawBodyBuffer = Buffer.from(JSON.stringify(req.body));
    } else {
      rawBodyBuffer = Buffer.from('');
    }

    const canonical = buildCanonicalRequestString(
      req.method,
      req.originalUrl || req.url,
      timestampStr,
      nonce,
      rawBodyBuffer
    );

    // 7. Verify RSA-SHA256 cryptographic signature
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(canonical);
      const isValid = verifier.verify(org.publicKeyPem, signature, 'base64');

      if (!isValid) {
        try {
          broadcastSecurityAlert(orgId, {
            type: 'INVALID_SIGNATURE',
            severity: 'high',
            message: 'Cryptographic request signature verification failed',
            requestId,
            occurredAt: new Date().toISOString(),
          });
        } catch {
          // Non-blocking
        }

        res.status(401).json({
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Cryptographic request signature verification failed',
            requestId,
          },
        });
        return;
      }
    } catch (err: unknown) {
      res.status(401).json({
        error: {
          code: 'INVALID_SIGNATURE',
          message: err instanceof Error ? err.message : 'Signature verification error',
          requestId,
        },
      });
      return;
    }

    // Signature verified successfully
    next();
  };
}

export const verifyTenantSignature = createVerifyTenantSignatureMiddleware();
