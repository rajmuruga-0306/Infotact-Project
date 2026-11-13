import { getStoredKeyPair, signClientRequest } from '../utils/crypto';
import type {
  LoginInput,
  LoginResponse,
  RegisterOrgInput,
  RegisterOrgResponse,
  BalanceResponse,
  Transaction,
  AnalyticsSummary,
  SpendOverTimePoint,
  ResourceUsageBreakdown,
  StatusBreakdown,
  UsageRecord,
  ResourcePricingPlan,
  CreateTransactionInput,
  RecordUsageInput,
} from '@ledgerguard/shared';

const TOKEN_KEY = 'lg_access_token';

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAccessToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Local storage unavailable
  }
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends RequestInit {
  body?: any;
  skipAuth?: boolean;
  skipSignature?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  // 1. Authorization header
  if (!options.skipAuth) {
    const token = getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  // 2. Prepare body
  let requestBody: string | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      requestBody = options.body;
    } else {
      requestBody = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }
  }

  // 3. Cryptographic Zero-Knowledge Signature for ledger and usage routes
  const requiresSignature =
    !options.skipSignature && (path.startsWith('/api/v1/ledger') || path.startsWith('/api/v1/usage'));

  if (requiresSignature) {
    const keyPair = getStoredKeyPair();
    if (keyPair) {
      const signedHeaders = await signClientRequest({
        method,
        path,
        body: options.body,
        privateKeyPem: keyPair.privateKeyPem,
        keyId: keyPair.keyId,
      });

      headers.set('X-Signature', signedHeaders['X-Signature']);
      headers.set('X-Key-Id', signedHeaders['X-Key-Id']);
      headers.set('X-Timestamp', signedHeaders['X-Timestamp']);
      headers.set('X-Nonce', signedHeaders['X-Nonce']);
    }
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    body: requestBody,
    credentials: 'include', // Sends HttpOnly refreshToken cookie
  });

  if (!response.ok) {
    let errorCode = 'REQUEST_FAILED';
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    let requestId: string | undefined;

    try {
      const errorJson = await response.json();
      if (errorJson?.error) {
        errorCode = errorJson.error.code || errorCode;
        errorMessage = errorJson.error.message || errorMessage;
        requestId = errorJson.error.requestId;
      }
    } catch {
      // Non-JSON response
    }

    throw new ApiError(errorCode, errorMessage, response.status, requestId);
  }

  // Parse JSON response
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

/* =========================================================
 * Auth API
 * ========================================================= */
export const authApi = {
  async registerOrg(input: RegisterOrgInput): Promise<RegisterOrgResponse> {
    return apiFetch<RegisterOrgResponse>('/api/v1/auth/register-org', {
      method: 'POST',
      body: input,
      skipAuth: true,
      skipSignature: true,
    });
  },

  async login(input: LoginInput): Promise<LoginResponse> {
    const res = await apiFetch<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: input,
      skipAuth: true,
      skipSignature: true,
    });
    if (res.accessToken) {
      setAccessToken(res.accessToken);
    }
    return res;
  },

  async getMe(): Promise<{
    user: { id: string; email: string; fullName: string };
    currentOrganization: { id: string; name: string; slug: string; role: string; isCurrent: boolean };
    organizations: Array<{ id: string; name: string; slug: string; role: string; isCurrent: boolean }>;
  }> {
    return apiFetch('/api/v1/auth/me', {
      skipSignature: true,
    });
  },

  async switchOrg(targetOrgId: string): Promise<{
    accessToken: string;
    expiresIn: number;
    organization: { id: string; name: string; slug: string; role: string };
  }> {
    const res = await apiFetch<{
      accessToken: string;
      expiresIn: number;
      organization: { id: string; name: string; slug: string; role: string };
    }>('/api/v1/auth/switch-org', {
      method: 'POST',
      body: { targetOrgId },
      skipSignature: true,
    });
    if (res.accessToken) {
      setAccessToken(res.accessToken);
    }
    return res;
  },

  async logout(): Promise<void> {
    try {
      await apiFetch('/api/v1/auth/logout', {
        method: 'POST',
        skipSignature: true,
      });
    } finally {
      setAccessToken(null);
    }
  },
};

/* =========================================================
 * Ledger API
 * ========================================================= */
export const ledgerApi = {
  async getBalance(): Promise<BalanceResponse> {
    return apiFetch<BalanceResponse>('/api/v1/ledger/balance');
  },

  async getTransactions(params?: {
    limit?: number;
    skip?: number;
    status?: string;
    type?: string;
    resource?: string;
  }): Promise<{
    transactions: Transaction[];
    total: number;
    limit: number;
    skip: number;
  }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.skip) query.set('skip', String(params.skip));
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.resource) query.set('resource', params.resource);

    const queryString = query.toString();
    const path = `/api/v1/ledger/transactions${queryString ? `?${queryString}` : ''}`;
    return apiFetch(path);
  },

  async createTransaction(
    input: CreateTransactionInput,
    idempotencyKey: string = window.crypto.randomUUID()
  ): Promise<Transaction> {
    return apiFetch<Transaction>('/api/v1/ledger/transactions', {
      method: 'POST',
      body: input,
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    });
  },
};

/* =========================================================
 * Usage & Analytics API
 * ========================================================= */
export interface AnalyticsData {
  range: '7d' | '30d' | '12m';
  summary: AnalyticsSummary;
  spendOverTime: SpendOverTimePoint[];
  resourceBreakdown: ResourceUsageBreakdown[];
  statusBreakdown: StatusBreakdown[];
}

export const usageApi = {
  async getAnalytics(range: '7d' | '30d' | '12m' = '30d'): Promise<AnalyticsData> {
    return apiFetch<AnalyticsData>(`/api/v1/usage/analytics?range=${range}`);
  },

  async getUsageRecords(params?: {
    resource?: string;
    billed?: boolean;
    limit?: number;
    skip?: number;
  }): Promise<{
    records: UsageRecord[];
    total: number;
    limit: number;
    skip: number;
  }> {
    const query = new URLSearchParams();
    if (params?.resource) query.set('resource', params.resource);
    if (params?.billed !== undefined) query.set('billed', String(params.billed));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.skip) query.set('skip', String(params.skip));

    const queryString = query.toString();
    const path = `/api/v1/usage/records${queryString ? `?${queryString}` : ''}`;
    return apiFetch(path);
  },

  async getPricingPlans(): Promise<{ plans: ResourcePricingPlan[] }> {
    return apiFetch<{ plans: ResourcePricingPlan[] }>('/api/v1/usage/pricing-plans');
  },

  async recordUsage(
    input: RecordUsageInput,
    idempotencyKey?: string
  ): Promise<{
    record: UsageRecord;
    settled: boolean;
    transaction?: Transaction;
    tierCalculation: {
      totalCostMinor: number | string;
      breakdown: Array<{
        tierIndex: number;
        unitsInTier: number;
        unitPriceMinor: number | string;
        tierCostMinor: number | string;
      }>;
    };
  }> {
    const payload = {
      ...input,
      idempotencyKey: idempotencyKey || input.idempotencyKey || window.crypto.randomUUID(),
    };
    return apiFetch('/api/v1/usage/record', {
      method: 'POST',
      body: payload,
    });
  },

  async aggregateAndSettle(resource?: string): Promise<{
    settledCount: number;
    totalAmountMinor: number;
    transactionId?: string;
    details: Array<{ resource: string; unbilledUnits: number; settledCostMinor: number }>;
  }> {
    return apiFetch('/api/v1/usage/aggregate-and-settle', {
      method: 'POST',
      body: { resource },
    });
  },
};
