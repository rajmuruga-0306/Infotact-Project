import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  authApi,
  getAccessToken,
  setAccessToken as setStoredToken,
} from '../api/apiClient';
import {
  generateClientKeyPair,
  getStoredKeyPair,
  saveStoredKeyPair,
  TenantKeyPair,
} from '../utils/crypto';
import type { RegisterOrgInput, LoginInput } from '@ledgerguard/shared';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
}

export interface OrganizationContext {
  id: string;
  name: string;
  slug: string;
  role: string;
  isCurrent?: boolean;
}

interface AuthContextType {
  user: UserProfile | null;
  currentOrg: OrganizationContext | null;
  organizations: OrganizationContext[];
  accessToken: string | null;
  keyPair: TenantKeyPair | null;
  isLoading: boolean;
  error: string | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: Omit<RegisterOrgInput, 'publicKeyPem'>) => Promise<void>;
  switchOrg: (targetOrgId: string) => Promise<void>;
  logout: () => Promise<void>;
  generateNewKeyPair: () => Promise<TenantKeyPair>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [currentOrg, setCurrentOrg] = useState<OrganizationContext | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationContext[]>([]);
  const [accessToken, setAccessTokenState] = useState<string | null>(getAccessToken());
  const [keyPair, setKeyPair] = useState<TenantKeyPair | null>(getStoredKeyPair());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize session on mount
  useEffect(() => {
    let mounted = true;

    async function initSession() {
      const token = getAccessToken();
      if (!token) {
        if (mounted) {
          setIsLoading(false);
        }
        return;
      }

      try {
        const me = await authApi.getMe();
        if (mounted) {
          setUser(me.user);
          setCurrentOrg(me.currentOrganization);
          setOrganizations(me.organizations);
          setAccessTokenState(token);
        }
      } catch {
        // Token expired or invalid
        if (mounted) {
          setStoredToken(null);
          setAccessTokenState(null);
          setUser(null);
          setCurrentOrg(null);
          setOrganizations([]);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    initSession();

    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.login(input);
      setUser(res.user);
      setCurrentOrg(res.organization);
      setAccessTokenState(res.accessToken);

      // Refresh me to get full accessible org list
      try {
        const me = await authApi.getMe();
        setOrganizations(me.organizations);
      } catch {
        setOrganizations([{ ...res.organization, isCurrent: true }]);
      }

      // Check if client keypair exists, if not generate one locally for zero-knowledge signing
      let kp = getStoredKeyPair();
      if (!kp) {
        kp = await generateClientKeyPair(`key_${res.organization.id.substring(0, 8)}`);
        saveStoredKeyPair(kp);
      }
      setKeyPair(kp);
    } catch (err: any) {
      setError(err.message || 'Login failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const register = useCallback(
    async (input: Omit<RegisterOrgInput, 'publicKeyPem'>) => {
      setIsLoading(true);
      setError(null);
      try {
        // 1. Generate client-side RSA keypair locally inside the browser sandbox
        const kp = await generateClientKeyPair(`key_${input.slug}`);
        saveStoredKeyPair(kp);
        setKeyPair(kp);

        // 2. Register organization with server (sending only public key PEM)
        await authApi.registerOrg({
          ...input,
          publicKeyPem: kp.publicKeyPem,
        });

        // 3. Automatically log in with newly created admin credentials
        await login({
          email: input.adminEmail,
          password: input.adminPassword,
        });
      } catch (err: any) {
        setError(err.message || 'Registration failed');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [login]
  );

  const switchOrg = useCallback(async (targetOrgId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.switchOrg(targetOrgId);
      setCurrentOrg(res.organization);
      setAccessTokenState(res.accessToken);

      // Refresh accessible orgs
      const me = await authApi.getMe();
      setOrganizations(me.organizations);
    } catch (err: any) {
      setError(err.message || 'Failed to switch organization');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setIsLoading(true);
    try {
      await authApi.logout();
    } catch {
      // Best-effort logout
    } finally {
      setUser(null);
      setCurrentOrg(null);
      setOrganizations([]);
      setAccessTokenState(null);
      setIsLoading(false);
    }
  }, []);

  const generateNewKeyPair = useCallback(async () => {
    const orgSlug = currentOrg?.slug || 'client';
    const kp = await generateClientKeyPair(`key_${orgSlug}_${Date.now()}`);
    saveStoredKeyPair(kp);
    setKeyPair(kp);
    return kp;
  }, [currentOrg]);

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        currentOrg,
        organizations,
        accessToken,
        keyPair,
        isLoading,
        error,
        login,
        register,
        switchOrg,
        logout,
        generateNewKeyPair,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
