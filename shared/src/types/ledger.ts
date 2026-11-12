/**
 * VIRTUAL CLEARING ACCOUNT IDENTIFIER
 * PLATFORM_CLEARING is a virtual counterpart account inside each tenant's ledger database.
 * Every transaction creates balanced double-entry records (one DEBIT, one CREDIT).
 * Platform-wide multi-cluster reconciliation is completely separate; no atomic cross-cluster
 * operations are assumed or implied.
 */
export const VIRTUAL_CLEARING_ACCOUNT = 'PLATFORM_CLEARING';

export type TransactionType = 'charge' | 'refund';

export type TransactionStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'ROLLED_BACK' | 'SUCCEEDED';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface Account {
  _id: string;
  balanceMinor: number | string;
  creditLimitMinor: number | string;
  monthlyLimitMinor: number | string;
  currentMonth: string;
  currentMonthSpendMinor: number | string;
  currency: string;
  version: number;
  updatedAt: string;
}

export interface Transaction {
  _id: string;
  idempotencyKey: string;
  requestHash: string;
  type: TransactionType;
  amountMinor: number | string;
  currency: string;
  resource: string;
  status: TransactionStatus;
  failureReason?: string;
  signatureKeyId: string;
  createdBy: string;
  createdAt: string;
  /**
   * For refunds: points to the original succeeded charge.
   * Total refunds cannot exceed original transaction amount.
   */
  originalTransactionId?: string;
  refundedAmountMinor?: number | string;
}

export interface LedgerEntry {
  _id: string;
  transactionId: string;
  /**
   * Account identifier within this tenant DB:
   * Either the tenant's account ID or VIRTUAL_CLEARING_ACCOUNT.
   */
  accountRef: string;
  direction: LedgerDirection;
  amountMinor: number | string;
  balanceAfterMinor: number | string;
  createdAt: string;
}

export interface BalanceResponse {
  balanceMinor: number | string;
  creditLimitMinor: number | string;
  monthlyLimitMinor: number | string;
  currentMonth: string;
  currentMonthSpendMinor: number | string;
  availableMinor: number | string;
  currency: string;
  asOf: string;
}

/**
 * Safely converts a number, bigint, or numeric string to native BigInt.
 */
export function toBigIntMinor(val: bigint | number | string): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isInteger(val)) {
      throw new Error(`Invalid minor currency unit: floating point numbers are prohibited (${val})`);
    }
    return BigInt(val);
  }
  if (typeof val === 'string') {
    if (!/^-?\d+$/.test(val.trim())) {
      throw new Error(`Invalid minor currency unit string: '${val}'`);
    }
    return BigInt(val.trim());
  }
  throw new Error(`Unsupported type for minor unit: ${typeof val}`);
}

/**
 * Serializes a BigInt minor unit safely:
 * Returns number if within IEEE 754 safe integer range, or string otherwise.
 */
export function serializeMinorUnit(val: bigint | number | string): number | string {
  const b = toBigIntMinor(val);
  if (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(b);
  }
  return b.toString();
}
