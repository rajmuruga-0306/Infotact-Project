import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ledgerApi } from '../api/apiClient';
import { useSocket } from '../context/SocketContext';
import { Transaction } from '@ledgerguard/shared';
import {
  ListFilter,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Hash,
} from 'lucide-react';

function formatCurrency(minor: number | string): string {
  const val = Number(minor) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export const LiveLedgerFeed: React.FC = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { lastEvent } = useSocket();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => ledgerApi.getTransactions({ limit: 10 }),
    refetchInterval: 15000,
  });

  const transactions: Transaction[] = data?.transactions || [];

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">Live Double-Entry Ledger Feed</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Cryptographically sealed and balanced journal entries
          </p>
        </div>

        <div className="flex items-center gap-2">
          {lastEvent && (
            <span className="hidden sm:inline-flex items-center text-[10px] text-emerald-400 font-mono bg-emerald-950/40 border border-emerald-500/20 px-2 py-0.5 rounded">
              ⚡ {lastEvent.name}
            </span>
          )}
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/60 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Refresh feed"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-xs text-slate-500">Loading ledger feed...</div>
      ) : transactions.length === 0 ? (
        <div className="py-12 text-center text-xs text-slate-500">
          No transactions posted yet. Ingest usage or trigger a settlement below.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Resource / Type</th>
                <th className="py-3 px-3 font-mono">Amount</th>
                <th className="py-3 px-3">Timestamp</th>
                <th className="py-3 px-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {transactions.map((tx) => {
                const isExpanded = expandedId === tx._id;
                const isSuccess = tx.status === 'POSTED' || tx.status === 'SUCCEEDED';
                const isFailed = tx.status === 'FAILED';
                const isCharge = tx.type === 'charge';

                return (
                  <React.Fragment key={tx._id}>
                    <tr
                      onClick={() => toggleExpand(tx._id)}
                      className="cursor-pointer hover:bg-slate-800/40 transition-colors"
                    >
                      {/* Status */}
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-1.5">
                          {isSuccess && <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />}
                          {isFailed && <XCircle className="h-4 w-4 text-rose-400 shrink-0" />}
                          {!isSuccess && !isFailed && <Clock className="h-4 w-4 text-amber-400 shrink-0" />}
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              isSuccess
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : isFailed
                                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            }`}
                          >
                            {tx.status}
                          </span>
                        </div>
                      </td>

                      {/* Resource / Type */}
                      <td className="py-3 px-3 font-sans">
                        <div className="font-medium text-slate-200 capitalize">
                          {tx.resource.replace(/_/g, ' ')}
                        </div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider font-mono">
                          {tx.type}
                        </div>
                      </td>

                      {/* Amount */}
                      <td className="py-3 px-3 font-bold text-white">
                        <span className={isCharge ? 'text-slate-200' : 'text-emerald-400'}>
                          {isCharge ? '-' : '+'}
                          {formatCurrency(tx.amountMinor)}
                        </span>
                      </td>

                      {/* Timestamp */}
                      <td className="py-3 px-3 text-[11px] text-slate-400 font-sans">
                        {new Date(tx.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </td>

                      {/* Expand Toggle */}
                      <td className="py-3 px-3 text-right">
                        <button
                          type="button"
                          className="text-slate-400 hover:text-white transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                    </tr>

                    {/* Expanded Double-Entry Details */}
                    {isExpanded && (
                      <tr className="bg-slate-950/60 font-sans">
                        <td colSpan={5} className="p-4 border-l-2 border-indigo-500">
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-semibold text-white flex items-center gap-1.5">
                                <Hash className="h-3.5 w-3.5 text-indigo-400" />
                                Balanced Double-Entry Journal
                              </span>
                              <span className="text-[10px] font-mono text-slate-400">
                                TX ID: {tx._id}
                              </span>
                            </div>

                            {/* Double-Entry Balanced Pair */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
                              {/* Leg 1: Primary Tenant Account */}
                              <div className="rounded-lg bg-slate-900 border border-slate-800 p-2.5">
                                <div className="text-slate-400 text-[10px] uppercase tracking-wider">
                                  Primary Tenant Account
                                </div>
                                <div className="mt-1 flex items-center justify-between">
                                  <span className="text-rose-400 font-semibold">
                                    {isCharge ? 'DEBIT (-)' : 'CREDIT (+)'}
                                  </span>
                                  <span className="text-white font-bold">
                                    {formatCurrency(tx.amountMinor)}
                                  </span>
                                </div>
                              </div>

                              {/* Leg 2: Virtual Clearing Account */}
                              <div className="rounded-lg bg-slate-900 border border-slate-800 p-2.5">
                                <div className="text-slate-400 text-[10px] uppercase tracking-wider">
                                  Counterpart: PLATFORM_CLEARING
                                </div>
                                <div className="mt-1 flex items-center justify-between">
                                  <span className="text-emerald-400 font-semibold">
                                    {isCharge ? 'CREDIT (+)' : 'DEBIT (-)'}
                                  </span>
                                  <span className="text-white font-bold">
                                    {formatCurrency(tx.amountMinor)}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Cryptographic & Idempotency Metadata */}
                            <div className="rounded-lg bg-slate-900/80 border border-slate-800 p-2 text-[10px] font-mono text-slate-400 space-y-1">
                              <div>
                                <span className="text-slate-500">Idempotency-Key:</span>{' '}
                                <span className="text-slate-300">{tx.idempotencyKey}</span>
                              </div>
                              <div className="truncate">
                                <span className="text-slate-500">Request-Hash:</span>{' '}
                                <span className="text-slate-300">{tx.requestHash}</span>
                              </div>
                              <div>
                                <span className="text-slate-500">Signature Key ID:</span>{' '}
                                <span className="text-indigo-300">{tx.signatureKeyId}</span>
                              </div>
                              {tx.failureReason && (
                                <div className="text-rose-400 font-semibold">
                                  <span>Failure Reason:</span> {tx.failureReason}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
