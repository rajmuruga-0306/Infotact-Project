export type UserRole = 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'BILLING_USER' | 'VIEWER';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
}

export interface User {
  _id: string;
  orgId: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    role: UserRole;
    orgId: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
}

export interface RegisterOrgResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    keyId: string;
  };
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
  /**
   * Returned ONLY ONCE if the server generated the keypair upon registration.
   * The server never stores this private key.
   */
  privateKeyPem?: string;
}
