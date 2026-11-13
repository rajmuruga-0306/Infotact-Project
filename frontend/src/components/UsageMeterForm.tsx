import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usageApi } from '../api/apiClient';
import { Play, Sparkles, Layers, CheckCircle, AlertCircle, ArrowRight } from 'lucide-react';

interface Tier {
  upToUnits: number | null;
  unitPriceMinor: number | string;
}

export const UsageMeterForm: React.FC = () => {
  const queryClient = useQueryClient();
  const [resource, setResource] = useState<string>('api_calls');
  const [units, setUnits] = useState<number>(2500);
  const [settleImmediately, setSettleImmediately] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Fetch active graduated pricing plans
  const { data: pricingData } = useQuery({
    queryKey: ['pricingPlans'],
    queryFn: usageApi.getPricingPlans,
    staleTime: 300000,
  });

  const selectedPlan = pricingData?.plans.find((p) => p.resource === resource);

  // Calculate live client-side graduated pricing preview
  const calculatePreview = (inputUnits: number, tiers: Tier[] = []) => {
    let remaining = inputUnits;
    let totalCostMinor = 0;
    const breakdown: Array<{ tierIndex: number; units: number; price: number; cost: number }> = [];

    let previousBound = 0;
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i]!;
      const tierLimit = tier.upToUnits;
      const tierCapacity = tierLimit === null ? Infinity : tierLimit - previousBound;
      const unitsInTier = Math.min(Math.max(0, remaining), tierCapacity);
      const unitPrice = Number(tier.unitPriceMinor);
      const tierCost = unitsInTier * unitPrice;

      if (unitsInTier > 0) {
        breakdown.push({
          tierIndex: i + 1,
          units: unitsInTier,
          price: unitPrice / 100,
          cost: tierCost / 100,
        });
      }

      totalCostMinor += tierCost;
      remaining -= unitsInTier;
      if (tierLimit !== null) previousBound = tierLimit;
      if (remaining <= 0) break;
    }

    return { totalCost: totalCostMinor / 100, breakdown };
  };

  const preview = calculatePreview(units, selectedPlan?.tiers as Tier[]);

  // Mutation: Record usage
  const recordMutation = useMutation({
    mutationFn: async () => {
      setFeedback(null);
      return usageApi.recordUsage({
        resource,
        units,
        settleImmediately,
        metadata: { source: 'dashboard_playground' },
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['balance'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['usageRecords'] });

      const costStr = (Number(data.tierCalculation.totalCostMinor) / 100).toFixed(2);
      setFeedback({
        type: 'success',
        message: data.settled
          ? `Settled $${costStr} for ${units} ${resource} (TX: ${data.transaction?._id?.substring(0, 8)}...)`
          : `Ingested ${units} unbilled ${resource} units ($${costStr} accrued)`,
      });
    },
    onError: (err: any) => {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to record usage event',
      });
    },
  });

  // Mutation: Batch settle
  const settleMutation = useMutation({
    mutationFn: async () => {
      setFeedback(null);
      return usageApi.aggregateAndSettle();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['balance'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['usageRecords'] });

      const costStr = (data.totalAmountMinor / 100).toFixed(2);
      setFeedback({
        type: 'success',
        message: `Settled ${data.settledCount} records totaling $${costStr} in atomic transaction`,
      });
    },
    onError: (err: any) => {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to settle unbilled usage',
      });
    },
  });

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Play className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Usage Ingestion Playground</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Test real-time graduated tier calculation and zero-knowledge request signing
          </p>
        </div>

        <button
          type="button"
          onClick={() => settleMutation.mutate()}
          disabled={settleMutation.isPending}
          className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-750 hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <Layers className="h-3.5 w-3.5 text-indigo-400" />
          <span>{settleMutation.isPending ? 'Settling...' : 'Batch Settle Unbilled'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Resource Selection */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Resource Metric
          </label>
          <select
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="api_calls">API Calls (Graduated Tier)</option>
            <option value="compute_minutes">Compute Minutes (CPU/RAM)</option>
            <option value="storage_gb">Storage GB (Disk Usage)</option>
            <option value="ai_tokens">AI Tokens (LLM Inference)</option>
          </select>
        </div>

        {/* Units Input */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Usage Quantity (Units)
          </label>
          <input
            type="number"
            min={1}
            max={1000000}
            step={100}
            value={units}
            onChange={(e) => setUnits(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono font-medium text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Immediate Settlement Toggle */}
        <div className="flex flex-col justify-end">
          <label className="flex items-center gap-2 cursor-pointer mb-2.5">
            <input
              type="checkbox"
              checked={settleImmediately}
              onChange={(e) => setSettleImmediately(e.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900"
            />
            <span className="text-xs text-slate-300 font-medium">Settle into Ledger Immediately</span>
          </label>

          <button
            type="button"
            onClick={() => recordMutation.mutate()}
            disabled={recordMutation.isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500 transition-colors disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            <span>{recordMutation.isPending ? 'Signing & Ingesting...' : 'Record & Post Transaction'}</span>
          </button>
        </div>
      </div>

      {/* Live Graduated Tier Pricing Preview */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="font-semibold text-slate-300 flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-indigo-400" />
            Graduated Tier Preview
          </span>
          <span className="font-mono font-bold text-emerald-400 text-sm">
            Total Cost: ${preview.totalCost.toFixed(2)}
          </span>
        </div>

        {preview.breakdown.length === 0 ? (
          <p className="text-[11px] text-slate-500">Enter a unit quantity above to calculate cost.</p>
        ) : (
          <div className="space-y-1">
            {preview.breakdown.map((item) => (
              <div key={item.tierIndex} className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-slate-300">
                    Tier {item.tierIndex}
                  </span>
                  <span>{item.units.toLocaleString()} units @ ${item.price.toFixed(4)}/unit</span>
                </div>
                <div className="flex items-center gap-1.5 font-medium text-slate-200">
                  <ArrowRight className="h-3 w-3 text-slate-600" />
                  <span>${item.cost.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Result / Error Notification */}
      {feedback && (
        <div
          className={`mt-3 flex items-center gap-2 rounded-xl border p-3 text-xs ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle className="h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          )}
          <span className="leading-snug">{feedback.message}</span>
        </div>
      )}
    </div>
  );
};
