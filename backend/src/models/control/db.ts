import mongoose, { Connection } from 'mongoose';
import { env } from '../../config/env.js';
import { getOrganizationModel, IOrganization } from './Organization.js';
import { getUserModel, IUser } from './User.js';
import { getOrganizationMembershipModel, IOrganizationMembership } from './OrganizationMembership.js';
import { getPlatformAuditLogModel, IPlatformAuditLog } from './PlatformAuditLog.js';

let controlConn: Connection | null = null;

export interface ControlModels {
  Organization: mongoose.Model<IOrganization>;
  User: mongoose.Model<IUser>;
  OrganizationMembership: mongoose.Model<IOrganizationMembership>;
  PlatformAuditLog: mongoose.Model<IPlatformAuditLog>;
}

export function setControlDbConnection(conn: Connection | null): void {
  controlConn = conn;
}

/**
 * Returns the singleton connection to the control database (ledgerguard_control).
 * If a custom URI is provided (e.g. during integration tests), it creates or reuses a dedicated connection.
 */
export function getControlDbConnection(customUri?: string): Connection {
  if (customUri) {
    return mongoose.createConnection(customUri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      autoIndex: true,
    });
  }

  if (!controlConn) {
    controlConn = mongoose.createConnection(env.MONGODB_URI, {
      dbName: env.CONTROL_DB_NAME,
      maxPoolSize: 5,
      minPoolSize: 0,
      autoIndex: true,
    });
  }

  return controlConn;
}

/**
 * Returns initialized control models bound to the specified or default control connection.
 */
export function getControlModels(conn?: Connection): ControlModels {
  const activeConn = conn || getControlDbConnection();
  return {
    Organization: getOrganizationModel(activeConn),
    User: getUserModel(activeConn),
    OrganizationMembership: getOrganizationMembershipModel(activeConn),
    PlatformAuditLog: getPlatformAuditLogModel(activeConn),
  };
}

/**
 * Closes the control database connection.
 */
export async function closeControlDbConnection(): Promise<void> {
  if (controlConn) {
    await controlConn.close();
    controlConn = null;
  }
}
