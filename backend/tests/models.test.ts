import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { getControlModels, ControlModels } from '../src/models/control/index.js';

describe('Control Database Models (ledgerguard_control)', () => {
  let mongoServer: MongoMemoryServer;
  let testConn: Connection;
  let models: ControlModels;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    testConn = mongoose.createConnection(uri, { autoIndex: true });
    models = getControlModels(testConn);
    // Ensure all indexes are built
    await Promise.all([
      models.Organization.init(),
      models.User.init(),
      models.OrganizationMembership.init(),
      models.PlatformAuditLog.init(),
    ]);
  });

  afterAll(async () => {
    await testConn.close();
    await mongoServer.stop();
  });

  describe('Organization Model', () => {
    it('creates an organization and enforces unique slug', async () => {
      const orgData = {
        name: 'Acme Corp',
        slug: 'acme-corp',
        dbName: 'lg_tenant_acme-corp',
        dbUri: 'mongodb://secret-db-cluster:27017',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBIjAN...\n-----END PUBLIC KEY-----',
        keyId: 'key_123',
      };

      const org = await models.Organization.create(orgData);
      expect(org.slug).toBe('acme-corp');
      expect(org.status).toBe('ACTIVE');

      // Verify toJSON strips sensitive dbUri
      const json = org.toJSON();
      expect(json.dbUri).toBeUndefined();
      expect(json.__v).toBeUndefined();

      // Enforce duplicate slug error
      await expect(
        models.Organization.create({
          ...orgData,
          name: 'Duplicate Acme',
        })
      ).rejects.toThrow();
    });
  });

  describe('User Model', () => {
    it('creates a user and enforces unique email and toJSON hash removal', async () => {
      const userData = {
        email: 'alice@example.com',
        fullName: 'Alice Smith',
        passwordHash: '$2b$12$eX4mPl3H4sHw0rKf4ct0r12vAl1d4t10n...',
      };

      const user = await models.User.create(userData);
      expect(user.email).toBe('alice@example.com');
      expect(user.isActive).toBe(true);

      // Verify toJSON strips passwordHash
      const json = user.toJSON();
      expect(json.passwordHash).toBeUndefined();
      expect(json.__v).toBeUndefined();

      // Enforce duplicate email error
      await expect(
        models.User.create({
          ...userData,
          fullName: 'Alice Duplicate',
        })
      ).rejects.toThrow();
    });
  });

  describe('OrganizationMembership Model', () => {
    it('enforces compound uniqueness on { userId, orgId }', async () => {
      const user = await models.User.create({
        email: 'bob@example.com',
        fullName: 'Bob Builder',
        passwordHash: '$2b$12$anotherhash...',
      });

      const org = await models.Organization.create({
        name: 'Bob Construction',
        slug: 'bob-construction',
        dbName: 'lg_tenant_bob-construction',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBIjAN...\n-----END PUBLIC KEY-----',
        keyId: 'key_bob_1',
      });

      const membership = await models.OrganizationMembership.create({
        userId: user._id,
        orgId: org._id,
        role: 'ORG_ADMIN',
      });

      expect(membership.role).toBe('ORG_ADMIN');
      expect(membership.status).toBe('ACTIVE');

      // Enforce duplicate membership error for the same user and org
      await expect(
        models.OrganizationMembership.create({
          userId: user._id,
          orgId: org._id,
          role: 'VIEWER',
        })
      ).rejects.toThrow();
    });
  });

  describe('PlatformAuditLog Model', () => {
    it('creates platform audit log records with indexed timestamps', async () => {
      const log = await models.PlatformAuditLog.create({
        actorId: 'user_123',
        orgId: 'org_456',
        action: 'AUTH_LOGIN',
        ip: '127.0.0.1',
        requestId: 'req_test_001',
        outcome: 'SUCCESS',
        details: { method: 'password' },
      });

      expect(log.action).toBe('AUTH_LOGIN');
      expect(log.outcome).toBe('SUCCESS');
      expect(log.ts).toBeInstanceOf(Date);
    });
  });
});
