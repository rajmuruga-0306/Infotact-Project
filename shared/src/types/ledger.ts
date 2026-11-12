/**
 * VIRTUAL CLEARING ACCOUNT IDENTIFIER
 * PLATFORM_CLEARING is a virtual counterpart account inside each tenant's ledger database.
 * Every transaction creates balanced double-entry records (one DEBIT, one CREDIT).
 * Platform-wide multi-cluster reconciliation is completely separate; no atomic cross-cluster
 * operations are assumed or implied.
 */
export const VIRTUAL_CLEARING_ACCOUNT = 'PLATFORM_CLEARING';

export type TransactionType = 'charge' | 'refund';

export type TransactionStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface Account {
  _id: string;
  balanceMinor: number;
  creditLimitMinor: number;
  monthlyLimitMinor: number;
  currency: string;
  version: number;
  updatedAt: string;
}

export interface Transaction {
  _id: string;
  idempotencyKey: string;
  requestHash: string;
  type: TransactionType;
  amountMinor: number;
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
  refundedAmountMinor?: number;
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
  amountMinor: number;
  balanceAfterMinor: number;
  createdAt: string;
}

export interface BalanceResponse {
  balanceMinor: number;
  creditLimitMinor: number;
  monthlyLimitMinor: number;
  availableMinor: number;
  currency: string;
  asOf: string;
}
