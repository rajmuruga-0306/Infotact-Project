export interface UsageRecord {
  _id: string;
  resource: string;
  units: number;
  costMinor: number;
  ts: string;
}

export interface AuditLog {
  _id: string;
  ts: string;
  actorId: string;
  action: string;
  requestId: string;
  ip: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  details?: Record<string, unknown>;
}

export interface PlatformAuditLog extends AuditLog {
  orgId?: string;
}

export interface AnalyticsSummary {
  totalSpendMinor: number;
  balanceMinor: number;
  creditLimitMinor: number;
  monthlyLimitMinor: number;
  limitUsedPercent: number;
  transactionSuccessRate: number;
  totalTransactions: number;
  currency: string;
}

export interface SpendOverTimePoint {
  date: string;
  spendMinor: number;
  count: number;
}

export interface ResourceUsageBreakdown {
  resource: string;
  totalUnits: number;
  totalCostMinor: number;
  percentage: number;
}

export interface StatusBreakdown {
  status: string;
  count: number;
  percentage: number;
}
