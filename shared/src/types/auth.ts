export type UserRole = 'PLATFORM_ADMIN' | 'ORG_ADMIN' | 'BILLING_USER' | 'VIEWER';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
  familyId: string;
}

export interface User {
  _id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

export interface OrganizationMembership {
  _id: string;
  userId: string;
  orgId: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken?: string; // May also be set purely via HttpOnly cookie
  expiresIn: number;
  user: {
    id: string;
    email: string;
    fullName: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    role: UserRole;
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
    fullName: string;
  };
  membership: {
    role: UserRole;
    status: 'ACTIVE' | 'SUSPENDED';
  };
}
