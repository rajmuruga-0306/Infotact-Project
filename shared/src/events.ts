/**
 * Socket.IO event names and strongly-typed payload contracts.
 * Rooms are scoped per tenant as `tenant:<orgId>`.
 */

export const SOCKET_EVENTS = {
  TRANSACTION_CREATED: 'transaction:created',
  TRANSACTION_POSTED: 'transaction:posted',
  TRANSACTION_SUCCEEDED: 'transaction:succeeded',
  TRANSACTION_FAILED: 'transaction:failed',
  TRANSACTION_ROLLED_BACK: 'transaction:rolled_back',
  LIMIT_WARNING: 'limit:warning',
  SECURITY_ALERT: 'security:alert',
  USAGE_UPDATED: 'usage:updated',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export interface TransactionCreatedPayload {
  transactionId: string;
  idempotencyKey: string;
  type: 'charge' | 'refund';
  amountMinor: number | string;
  currency: string;
  resource: string;
  status: 'PENDING';
  createdAt: string;
}

export interface TransactionSucceededPayload {
  transactionId: string;
  idempotencyKey: string;
  type: 'charge' | 'refund';
  amountMinor: number | string;
  currency: string;
  balanceAfterMinor: number | string;
  status: 'POSTED' | 'SUCCEEDED';
  completedAt: string;
}

export interface TransactionFailedPayload {
  transactionId: string;
  idempotencyKey: string;
  status: 'FAILED';
  failureReason: string;
  failedAt: string;
}

export interface TransactionRolledBackPayload {
  transactionId?: string;
  idempotencyKey: string;
  status: 'ROLLED_BACK';
  reason: string;
  rolledBackAt: string;
}

export interface LimitWarningPayload {
  orgId: string;
  currentSpendMinor: number;
  monthlyLimitMinor: number;
  percentUsed: number;
  warnedAt: string;
}

export interface SecurityAlertPayload {
  type: 'REPLAY_ATTACK' | 'INVALID_SIGNATURE' | 'CROSS_TENANT_ATTEMPT' | 'RATE_LIMIT_EXCEEDED';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  requestId: string;
  occurredAt: string;
}

export interface UsageUpdatedPayload {
  resource: string;
  units: number;
  costMinor: number;
  ts: string;
}

export interface ServerToClientEvents {
  [SOCKET_EVENTS.TRANSACTION_CREATED]: (payload: TransactionCreatedPayload) => void;
  [SOCKET_EVENTS.TRANSACTION_SUCCEEDED]: (payload: TransactionSucceededPayload) => void;
  [SOCKET_EVENTS.TRANSACTION_FAILED]: (payload: TransactionFailedPayload) => void;
  [SOCKET_EVENTS.TRANSACTION_ROLLED_BACK]: (payload: TransactionRolledBackPayload) => void;
  [SOCKET_EVENTS.LIMIT_WARNING]: (payload: LimitWarningPayload) => void;
  [SOCKET_EVENTS.SECURITY_ALERT]: (payload: SecurityAlertPayload) => void;
  [SOCKET_EVENTS.USAGE_UPDATED]: (payload: UsageUpdatedPayload) => void;
}

export interface ClientToServerEvents {
  ping: () => void;
}
