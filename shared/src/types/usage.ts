export interface UsageRecord {
  _id: string;
  resource: string;
  units: number;
  costMinor: number | string;
  ts: string;
  idempotencyKey?: string;
  billed: boolean;
  transactionId?: string;
  rateTierApplied?: unknown;
  metadata?: Record<string, unknown>;
}

export interface PricingTier {
  upToUnits: number | null; // null means Infinity (unlimited / top tier)
  unitPriceMinor: number | string; // cost per 1 unit in minor currency units
}

export interface ResourcePricingPlan {
  resource: string;
  pricingModel: 'GRADUATED' | 'VOLUME' | 'FLAT';
  tiers: PricingTier[];
  currency: string;
}

export interface TierBreakdownItem {
  tierIndex: number;
  unitsInTier: number;
  unitPriceMinor: number | string;
  tierCostMinor: number | string;
}

export interface TierCalculationResult {
  totalCostMinor: number | string;
  breakdown: TierBreakdownItem[];
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
