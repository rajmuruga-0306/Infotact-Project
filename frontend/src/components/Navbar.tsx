import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { Shield, Key, Radio, Building2, LogOut, ChevronDown, Check, UserCircle } from 'lucide-react';

export const Navbar: React.FC = () => {
  const { user, currentOrg, organizations, switchOrg, logout, keyPair } = useAuth();
  const { isConnected } = useSocket();
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  const handleSwitch = async (orgId: string) => {
    if (orgId === currentOrg?.id) {
      setOrgDropdownOpen(false);
      return;
    }
    try {
      setIsSwitching(true);
      await switchOrg(orgId);
    } finally {
      setIsSwitching(false);
      setOrgDropdownOpen(false);
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 text-white shadow-lg shadow-indigo-500/25">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-white sm:text-lg">LedgerGuard</span>
              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                PROD
              </span>
            </div>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              Zero-Knowledge Multi-Tenant Billing Engine
            </p>
          </div>
        </div>

        {/* Center / Status Pills */}
        <div className="flex items-center gap-3">
          {/* WebSocket Status Indicator */}
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
              isConnected
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-400'
                : 'bg-rose-950/40 border-rose-500/30 text-rose-400'
            }`}
          >
            <Radio className={`h-3 w-3 ${isConnected ? 'animate-pulse text-emerald-400' : 'text-rose-400'}`} />
            <span>{isConnected ? 'LIVE WS' : 'WS OFFLINE'}</span>
          </div>

          {/* Zero-Knowledge Key Status */}
          <div
            title={`Client-Side Key: ${keyPair?.keyId || 'None'} (Private key never leaves browser)`}
            className="hidden md:flex items-center gap-1.5 rounded-full bg-slate-900 border border-slate-700/60 px-3 py-1 text-xs font-mono text-slate-300"
          >
            <Key className="h-3 w-3 text-indigo-400" />
            <span>ZK-RSA2048</span>
          </div>
        </div>

        {/* Right Action Section */}
        <div className="flex items-center gap-3">
          {/* Organization Switcher Dropdown */}
          {currentOrg && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
                disabled={isSwitching}
                className="flex items-center gap-2 rounded-lg bg-slate-900 border border-slate-700/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-850 hover:border-slate-600 transition-colors"
              >
                <Building2 className="h-3.5 w-3.5 text-slate-400" />
                <span className="max-w-[120px] truncate">{currentOrg.name}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {orgDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setOrgDropdownOpen(false)}
                  />
                  <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-slate-800 bg-slate-900 p-1 shadow-2xl backdrop-blur-xl">
                    <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      Switch Organization
                    </div>
                    {organizations.map((org) => (
                      <button
                        key={org.id}
                        type="button"
                        onClick={() => handleSwitch(org.id)}
                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                          org.id === currentOrg.id
                            ? 'bg-indigo-600/20 text-indigo-300 font-semibold'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <div className="truncate">
                          <div className="font-medium truncate">{org.name}</div>
                          <div className="text-[10px] text-slate-400 font-mono">slug: {org.slug}</div>
                        </div>
                        {org.id === currentOrg.id && <Check className="h-4 w-4 text-indigo-400 shrink-0" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* User Info & Logout */}
          <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
            <div className="hidden lg:flex flex-col text-right">
              <span className="text-xs font-medium text-slate-200">{user?.fullName || 'User'}</span>
              <span className="text-[10px] text-slate-400 font-mono">{currentOrg?.role || 'VIEWER'}</span>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800 text-slate-300">
              <UserCircle className="h-5 w-5" />
            </div>
            <button
              type="button"
              onClick={() => logout()}
              title="Log out"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 text-slate-400 hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/30 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
