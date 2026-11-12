export type KeyStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';

export interface Organization {
  _id: string;
  name: string;
  slug: string;
  dbName: string;
  /**
   * Optional dedicated cluster override.
   * Designed to be encrypted at rest and never exposed in normal API responses or logs.
   */
  dbUri?: string;
  status: 'ACTIVE' | 'SUSPENDED';
  publicKeyPem: string;
  keyId: string;
  keyStatus: KeyStatus;
  createdAt: string;
}

export interface OrgLimits {
  creditLimitMinor: number;
  monthlyLimitMinor: number;
}
