import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { UserRole } from '@ledgerguard/shared';
import { env } from '../../config/env.js';

export interface TokenPayload {
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
  familyId: string;
}

export interface DecodedAccessToken extends TokenPayload {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
}

export class JwtService {
  private activeKeyId: string;
  private activePrivateKeyPem: string;
  private publicKeysByKid: Map<string, string> = new Map();

  constructor(customConfig?: {
    keyId?: string;
    privateKeyPem?: string;
    publicKeys?: Record<string, string>;
  }) {
    this.activeKeyId = customConfig?.keyId || env.JWT_KEY_ID;

    // Decode active private key
    if (customConfig?.privateKeyPem) {
      this.activePrivateKeyPem = customConfig.privateKeyPem;
    } else {
      this.activePrivateKeyPem = Buffer.from(env.JWT_PRIVATE_KEY, 'base64').toString('utf-8');
    }

    // Register active public key
    const activePublicPem = customConfig?.publicKeys?.[this.activeKeyId]
      ? customConfig.publicKeys[this.activeKeyId]!
      : Buffer.from(env.JWT_PUBLIC_KEY, 'base64').toString('utf-8');
    this.publicKeysByKid.set(this.activeKeyId, activePublicPem);

    // Register previous public key if provided for rotation
    if (env.JWT_PREVIOUS_KEY_ID && env.JWT_PREVIOUS_PUBLIC_KEY) {
      const prevPublicPem = Buffer.from(env.JWT_PREVIOUS_PUBLIC_KEY, 'base64').toString('utf-8');
      this.publicKeysByKid.set(env.JWT_PREVIOUS_KEY_ID, prevPublicPem);
    }

    if (customConfig?.publicKeys) {
      for (const [kid, pem] of Object.entries(customConfig.publicKeys)) {
        this.publicKeysByKid.set(kid, pem);
      }
    }
  }

  /**
   * Signs an access token with RS256, embedding kid, issuer, audience, and familyId.
   */
  signAccessToken(payload: TokenPayload, overrideKeyId?: string, overridePrivatePem?: string): string {
    const kid = overrideKeyId || this.activeKeyId;
    const privateKey = overridePrivatePem || this.activePrivateKeyPem;

    return jwt.sign(
      {
        orgId: payload.orgId,
        role: payload.role,
        email: payload.email,
        familyId: payload.familyId,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        subject: payload.userId,
        expiresIn: env.JWT_EXPIRES_IN,
      }
    );
  }

  /**
   * Verifies an RS256 access token with pinned algorithm and key ID resolution.
   * Hard-rejects alg: none and HMAC algorithm confusion attacks.
   */
  verifyAccessToken(token: string): TokenPayload {
    // 1. Inspect header without verifying signature to resolve kid
    const decodedComplete = jwt.decode(token, { complete: true });
    if (!decodedComplete || typeof decodedComplete === 'string' || !decodedComplete.header) {
      throw new Error('MALFORMED_TOKEN: Unable to decode token header');
    }

    const { alg, kid } = decodedComplete.header;

    // Strict algorithm defense: pin to RS256
    if (alg !== 'RS256') {
      throw new Error(`ALGORITHM_NOT_ALLOWED: Expected RS256 but received ${alg}`);
    }

    // Resolve public key by kid
    const lookupKid = kid || this.activeKeyId;
    const publicKey = this.publicKeysByKid.get(lookupKid);
    if (!publicKey) {
      throw new Error(`UNKNOWN_KEY_ID: No public key registered for kid '${lookupKid}'`);
    }

    // 2. Cryptographic signature and claim verification pinned strictly to RS256
    const verified = jwt.verify(token, publicKey, {
      algorithms: ['RS256'], // Pinned algorithms prevent HMAC confusion
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as jwt.JwtPayload;

    return {
      userId: verified.sub as string,
      orgId: verified.orgId as string,
      role: verified.role as UserRole,
      email: verified.email as string,
      familyId: verified.familyId as string,
    };
  }

  /**
   * Generates a cryptographically random 80-character refresh token string.
   */
  generateRefreshToken(): string {
    return 'rt_' + randomBytes(40).toString('hex');
  }

  /**
   * Generates a unique family ID for token-family tracking.
   */
  generateFamilyId(): string {
    return 'fam_' + randomBytes(16).toString('hex');
  }

  /**
   * Hashes a refresh token with SHA-256 before storing or looking up in Redis.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

// Export singleton service
export const jwtService = new JwtService();
