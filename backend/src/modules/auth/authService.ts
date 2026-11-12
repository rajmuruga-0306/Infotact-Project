import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import {
  RegisterOrgInput,
  LoginInput,
  SwitchOrgInput,
  RegisterOrgResponse,
  LoginResponse,
} from '@ledgerguard/shared';
import { getControlModels, ControlModels, getControlDbConnection } from '../../models/control/index.js';
import {
  getRedisClient,
  storeInitialRefreshToken,
  rotateRefreshToken,
  revokeFamily,
} from '../../redis/client.js';
import { jwtService, JwtService } from '../../gateway/jwt/jwtService.js';

export interface AuthServiceConfig {
  dbConn?: Connection;
  redisClient?: Redis;
  jwtService?: JwtService;
}

export class AuthService {
  private models: ControlModels;
  private dbConn: Connection;
  private redis: Redis;
  private jwt: JwtService;

  constructor(config?: AuthServiceConfig) {
    this.dbConn = config?.dbConn || getControlDbConnection();
    this.models = getControlModels(this.dbConn);
    this.redis = config?.redisClient || getRedisClient();
    this.jwt = config?.jwtService || jwtService;
  }

  /**
   * Registers a new organization, admin user, and membership inside an atomic MongoDB transaction.
   * Enforces zero-knowledge: only publicKeyPem is received and stored.
   */
  async registerOrg(input: RegisterOrgInput, clientIp: string, requestId: string): Promise<RegisterOrgResponse> {
    const session = await this.dbConn.startSession();
    session.startTransaction();

    try {
      // 1. Enforce unique slug
      const existingOrg = await this.models.Organization.findOne({ slug: input.slug }).session(session);
      if (existingOrg) {
        throw new Error(`SLUG_ALREADY_EXISTS: Organization slug '${input.slug}' is already registered`);
      }

      // 2. Enforce unique user email
      const existingUser = await this.models.User.findOne({ email: input.adminEmail.toLowerCase() }).session(session);
      if (existingUser) {
        throw new Error(`EMAIL_ALREADY_EXISTS: User email '${input.adminEmail}' is already registered`);
      }

      // 3. Hash admin password with bcrypt cost 12
      const passwordHash = await bcrypt.hash(input.adminPassword, 12);

      // 4. Create Organization record
      const keyId = 'key_' + randomUUID().replace(/-/g, '').slice(0, 16);
      const [org] = await this.models.Organization.create(
        [
          {
            name: input.name,
            slug: input.slug,
            dbName: `lg_tenant_${input.slug}`,
            status: 'ACTIVE',
            publicKeyPem: input.publicKeyPem,
            keyId,
            keyStatus: 'ACTIVE',
          },
        ],
        { session }
      );

      // 5. Create User record
      const [user] = await this.models.User.create(
        [
          {
            email: input.adminEmail.toLowerCase(),
            fullName: input.adminFullName,
            passwordHash,
            isActive: true,
          },
        ],
        { session }
      );

      // 6. Create OrganizationMembership record with ORG_ADMIN role
      const [membership] = await this.models.OrganizationMembership.create(
        [
          {
            userId: user!._id,
            orgId: org!._id,
            role: 'ORG_ADMIN',
            status: 'ACTIVE',
          },
        ],
        { session }
      );

      // 7. Write Platform Audit Log
      await this.models.PlatformAuditLog.create(
        [
          {
            actorId: user!._id.toString(),
            orgId: org!._id.toString(),
            action: 'AUTH_REGISTER_ORG',
            ip: clientIp,
            requestId,
            outcome: 'SUCCESS',
            details: { orgSlug: org!.slug, email: user!.email },
          },
        ],
        { session }
      );

      await session.commitTransaction();

      return {
        organization: {
          id: org!._id.toString(),
          name: org!.name,
          slug: org!.slug,
          keyId: org!.keyId,
        },
        user: {
          id: user!._id.toString(),
          email: user!.email,
          fullName: user!.fullName,
        },
        membership: {
          role: membership!.role,
          status: membership!.status,
        },
      };
    } catch (err: unknown) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Authenticates user, verifies bcrypt hash, and issues RS256 access token + refresh token family.
   */
  async login(
    input: LoginInput,
    clientIp: string,
    requestId: string
  ): Promise<LoginResponse & { refreshToken: string }> {
    const user = await this.models.User.findOne({ email: input.email.toLowerCase() });
    if (!user) {
      await this.logAuditFailure('AUTH_LOGIN_FAILED', clientIp, requestId, { email: input.email, reason: 'USER_NOT_FOUND' });
      throw new Error('INVALID_CREDENTIALS: Email or password incorrect');
    }

    if (!user.isActive) {
      await this.logAuditFailure('AUTH_LOGIN_BLOCKED', clientIp, requestId, { userId: user._id.toString(), reason: 'USER_INACTIVE' });
      throw new Error('USER_INACTIVE: This account has been deactivated');
    }

    const passwordMatch = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordMatch) {
      await this.logAuditFailure('AUTH_LOGIN_FAILED', clientIp, requestId, { userId: user._id.toString(), reason: 'PASSWORD_MISMATCH' });
      throw new Error('INVALID_CREDENTIALS: Email or password incorrect');
    }

    // Resolve primary active organization membership
    const memberships = await this.models.OrganizationMembership.find({
      userId: user._id,
      status: 'ACTIVE',
    }).populate<{ orgId: { _id: string; name: string; slug: string; status: string } }>('orgId');

    if (!memberships.length || !memberships[0] || !memberships[0].orgId) {
      throw new Error('NO_ACTIVE_MEMBERSHIP: User does not belong to any active organization');
    }

    const primaryMembership = memberships[0];
    const org = primaryMembership.orgId;

    // Issue fresh refresh token family
    const familyId = this.jwt.generateFamilyId();
    const refreshToken = this.jwt.generateRefreshToken();
    const tokenHash = this.jwt.hashToken(refreshToken);

    const sessionData = {
      userId: user._id.toString(),
      orgId: org._id.toString(),
      role: primaryMembership.role,
      email: user.email,
    };

    // Store hashed token in Redis family set
    await storeInitialRefreshToken(tokenHash, familyId, sessionData, 604800, this.redis);

    // Issue RS256 access token (15m expiry) embedding familyId
    const accessToken = this.jwt.signAccessToken({
      userId: user._id.toString(),
      orgId: org._id.toString(),
      role: primaryMembership.role,
      email: user.email,
      familyId,
    });

    // Update lastLoginAt
    user.lastLoginAt = new Date();
    await user.save();

    // Audit log
    await this.models.PlatformAuditLog.create({
      actorId: user._id.toString(),
      orgId: org._id.toString(),
      action: 'AUTH_LOGIN_SUCCESS',
      ip: clientIp,
      requestId,
      outcome: 'SUCCESS',
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        id: user._id.toString(),
        email: user.email,
        fullName: user.fullName,
      },
      organization: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        role: primaryMembership.role,
      },
    };
  }

  /**
   * Rotates a refresh token with atomic tripwire reuse detection.
   */
  async refresh(
    refreshToken: string,
    clientIp: string,
    requestId: string
  ): Promise<{ accessToken: string; newRefreshToken: string; expiresIn: number }> {
    const oldTokenHash = this.jwt.hashToken(refreshToken);
    const newRefreshToken = this.jwt.generateRefreshToken();
    const newTokenHash = this.jwt.hashToken(newRefreshToken);

    const rotateResult = await rotateRefreshToken(
      oldTokenHash,
      newTokenHash,
      {}, // Data updated by Lua script from old key
      604800, // 7-day refresh TTL
      300,    // 5-min rotated tripwire marker TTL
      900,    // 15-min access token revocation TTL
      this.redis
    );

    if (rotateResult.status === 'REUSE_DETECTED') {
      // SECURITY INCIDENT: Token was previously rotated and replayed!
      await this.models.PlatformAuditLog.create({
        action: 'TOKEN_REUSE_DETECTED',
        ip: clientIp,
        requestId,
        outcome: 'BLOCKED',
        details: { familyId: rotateResult.familyId },
      });
      throw new Error('TOKEN_REUSE_DETECTED: Stolen or duplicate refresh token replayed. Session terminated.');
    }

    if (rotateResult.status !== 'OK') {
      throw new Error('INVALID_REFRESH_TOKEN: Refresh token is expired or invalid');
    }

    const sessionData = rotateResult.data as {
      userId: string;
      orgId: string;
      role: string;
      email: string;
      familyId: string;
    };

    // Issue fresh RS256 access token
    const accessToken = this.jwt.signAccessToken({
      userId: sessionData.userId,
      orgId: sessionData.orgId,
      role: sessionData.role as any,
      email: sessionData.email,
      familyId: sessionData.familyId,
    });

    return {
      accessToken,
      newRefreshToken,
      expiresIn: 900,
    };
  }

  /**
   * Logs out user: immediately revokes token family in Redis and clears access tokens.
   */
  async logout(familyId: string, clientIp: string, requestId: string, refreshToken?: string): Promise<void> {
    await revokeFamily(familyId, 900, this.redis);

    if (refreshToken) {
      const tokenHash = this.jwt.hashToken(refreshToken);
      await this.redis.del(`refresh_token:${tokenHash}`);
    }

    await this.models.PlatformAuditLog.create({
      action: 'AUTH_LOGOUT',
      ip: clientIp,
      requestId,
      outcome: 'SUCCESS',
      details: { familyId },
    });
  }

  /**
   * Switches organization context: revokes previous family and issues a fresh family for the target org.
   */
  async switchOrg(
    input: SwitchOrgInput,
    userId: string,
    oldFamilyId: string,
    clientIp: string,
    requestId: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    organization: { id: string; name: string; slug: string; role: string };
  }> {
    // 1. Verify active membership in target organization
    const membership = await this.models.OrganizationMembership.findOne({
      userId,
      orgId: input.targetOrgId,
      status: 'ACTIVE',
    }).populate<{ orgId: { _id: string; name: string; slug: string } }>('orgId');

    if (!membership || !membership.orgId) {
      throw new Error('FORBIDDEN: User does not hold an active membership in the target organization');
    }

    const org = membership.orgId;
    const user = await this.models.User.findById(userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    // 2. Immediately revoke old family in Redis
    await revokeFamily(oldFamilyId, 900, this.redis);

    // 3. Issue fresh token family for target organization
    const newFamilyId = this.jwt.generateFamilyId();
    const newRefreshToken = this.jwt.generateRefreshToken();
    const newTokenHash = this.jwt.hashToken(newRefreshToken);

    const sessionData = {
      userId,
      orgId: org._id.toString(),
      role: membership.role,
      email: user.email,
    };

    await storeInitialRefreshToken(newTokenHash, newFamilyId, sessionData, 604800, this.redis);

    const accessToken = this.jwt.signAccessToken({
      userId,
      orgId: org._id.toString(),
      role: membership.role,
      email: user.email,
      familyId: newFamilyId,
    });

    await this.models.PlatformAuditLog.create({
      actorId: userId,
      orgId: org._id.toString(),
      action: 'AUTH_SWITCH_ORG',
      ip: clientIp,
      requestId,
      outcome: 'SUCCESS',
      details: { targetOrgId: org._id.toString() },
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 900,
      organization: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        role: membership.role,
      },
    };
  }

  /**
   * Retrieves user profile and accessible organization memberships.
   */
  async getMe(userId: string, currentOrgId: string) {
    const user = await this.models.User.findById(userId);
    if (!user) throw new Error('USER_NOT_FOUND');

    const memberships = await this.models.OrganizationMembership.find({
      userId,
      status: 'ACTIVE',
    }).populate<{ orgId: { _id: string; name: string; slug: string; status: string } }>('orgId');

    const activeOrgs = memberships
      .filter((m) => m.orgId && m.orgId.status === 'ACTIVE')
      .map((m) => ({
        id: m.orgId._id.toString(),
        name: m.orgId.name,
        slug: m.orgId.slug,
        role: m.role,
        isCurrent: m.orgId._id.toString() === currentOrgId,
      }));

    const currentMembership = activeOrgs.find((o) => o.isCurrent) || activeOrgs[0];

    return {
      user: {
        id: user._id.toString(),
        email: user.email,
        fullName: user.fullName,
      },
      currentOrganization: currentMembership,
      organizations: activeOrgs,
    };
  }

  private async logAuditFailure(
    action: string,
    ip: string,
    requestId: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.models.PlatformAuditLog.create({
        action,
        ip,
        requestId,
        outcome: 'FAILURE',
        details,
      });
    } catch {
      // Best-effort audit logging
    }
  }
}
