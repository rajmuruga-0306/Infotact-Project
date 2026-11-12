import mongoose, { Connection } from 'mongoose';
import { getAccountModel, IAccount, initializeTenantAccounts } from './Account.js';
import { getTransactionModel, ITransaction } from './Transaction.js';
import { getLedgerEntryModel, ILedgerEntry } from './LedgerEntry.js';
import { getUsageRecordModel, IUsageRecord } from './UsageRecord.js';
import { getTenantAuditLogModel, ITenantAuditLog } from './TenantAuditLog.js';

export * from './Account.js';
export * from './Transaction.js';
export * from './LedgerEntry.js';
export * from './UsageRecord.js';
export * from './TenantAuditLog.js';

export interface TenantModels {
  Account: mongoose.Model<IAccount>;
  Transaction: mongoose.Model<ITransaction>;
  LedgerEntry: mongoose.Model<ILedgerEntry>;
  UsageRecord: mongoose.Model<IUsageRecord>;
  TenantAuditLog: mongoose.Model<ITenantAuditLog>;
  initializeAccounts: (currency?: string, creditLimitMinor?: number, monthlyLimitMinor?: number) => Promise<{
    primary: IAccount;
    virtualClearing: IAccount;
  }>;
}

/**
 * Returns initialized tenant models bound to the specified tenant database connection.
 */
export function getTenantModels(conn: Connection): TenantModels {
  return {
    Account: getAccountModel(conn),
    Transaction: getTransactionModel(conn),
    LedgerEntry: getLedgerEntryModel(conn),
    UsageRecord: getUsageRecordModel(conn),
    TenantAuditLog: getTenantAuditLogModel(conn),
    initializeAccounts: (currency?: string, creditLimitMinor?: number, monthlyLimitMinor?: number) =>
      initializeTenantAccounts(conn, currency, creditLimitMinor, monthlyLimitMinor),
  };
}
