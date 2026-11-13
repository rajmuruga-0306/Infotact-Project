import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ledgerApi, usageApi } from '../api/apiClient';
import { Wallet, ShieldCheck, Gauge, Activity, ArrowUpRight, ArrowDownRight, RefreshCw } from 'lucide-react';

function formatCurrency(minor: number | string | undefined): string {
  if (minor === undefined || minor === null) return '$0.00';
  const val = Number(minor) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export const KpiCards: React.FC = () => {
  const { data: balance, isLoading: isBalanceLoading, isFetching: isBalanceFetching } = useQuery({
    queryKey: ['balance'],
    queryFn: ledgerApi.getBalance,
    refetchInterval: 30000,
  });

  const { data: analytics, isLoading: isAnalyticsLoading } = useQuery({
    queryKey: ['analytics', '30d'],
    queryFn: () => usageApi.getAnalytics('30d'),
    refetchInterval: 30000,
  });

  const isLoading = isBalanceLoading || isAnalyticsLoading;

  // Monthly limit progress calculation
  const monthlySpendMinor = Number(balance?.currentMonthSpendMinor || 0);
  const monthlyLimitMinor = Number(balance?.monthlyLimitMinor || 0);
  const limitUsedPercent =
    monthlyLimitMinor > 0 ? Math.min(100, Math.round((monthlySpendMinor / monthlyLimitMinor) * 100)) : 0;

  let limitBarColor = 'bg-emerald-500';
  let limitTextColor = 'text-emerald-400';
  if (limitUsedPercent >= 90) {
    limitBarColor = 'bg-rose-500 animate-pulse';
    limitTextColor = 'text-rose-400 font-bold';
  } else if (limitUsedPercent >= 80) {
    limitBarColor = 'bg-amber-500';
    limitTextColor = 'text-amber-400 font-semibold';
  }

  const successRate = analytics?.summary?.transactionSuccessRate ?? 100;
  const totalTxCount = analytics?.summary?.totalTransactions ?? 0;
  const balanceVal = Number(balance?.balanceMinor || 0);
  const isNegative = balanceVal < 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
      {/* 1. Current Account Balance */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Ledger Balance</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Wallet className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-white font-mono">
              {isLoading ? '...' : formatCurrency(balance?.balanceMinor)}
            </span>
            <span
              className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                isNegative
                  ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              }`}
            >
              {isNegative ? (
                <>
                  <ArrowDownRight className="h-3 w-3 mr-0.5" /> DEBIT
                </>
              ) : (
                <>
                  <ArrowUpRight className="h-3 w-3 mr-0.5" /> CREDIT
                </>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Double-entry posted account balance
          </p>
        </div>
        {isBalanceFetching && !isBalanceLoading && (
          <div className="absolute top-2 right-2">
            <RefreshCw className="h-3 w-3 animate-spin text-slate-500" />
          </div>
        )}
      </div>

      {/* 2. Available Credit Buffer */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Available Buffer</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <ShieldCheck className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3">
          <div className="text-2xl font-bold tracking-tight text-white font-mono">
            {isLoading ? '...' : formatCurrency(balance?.availableMinor)}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Balance + {formatCurrency(balance?.creditLimitMinor)} credit limit
          </p>
        </div>
      </div>

      {/* 3. Monthly Spend & Quota Warning */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Monthly Quota</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Gauge className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-white font-mono">
              {isLoading ? '...' : formatCurrency(balance?.currentMonthSpendMinor)}
            </span>
            <span className={`text-xs font-mono ${limitTextColor}`}>
              {limitUsedPercent}%
            </span>
          </div>
          {/* Progress Bar */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full transition-all duration-500 rounded-full ${limitBarColor}`}
              style={{ width: `${limitUsedPercent}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
            <span>{balance?.currentMonth || 'Current month'}</span>
            <span>Limit: {formatCurrency(balance?.monthlyLimitMinor)}</span>
          </div>
        </div>
      </div>

      {/* 4. Transaction Success Rate */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Ledger Health</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Activity className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-white font-mono">
              {isLoading ? '...' : `${successRate}%`}
            </span>
            <span className="text-xs text-slate-400">success rate</span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Across {totalTxCount} total transactions (30d)
          </p>
        </div>
      </div>
    </div>
  );
};
