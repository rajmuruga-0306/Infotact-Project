import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usageApi } from '../api/apiClient';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, Calendar } from 'lucide-react';

type TimeRange = '7d' | '30d' | '12m';

export const SpendChart: React.FC = () => {
  const [range, setRange] = useState<TimeRange>('30d');

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', range],
    queryFn: () => usageApi.getAnalytics(range),
    refetchInterval: 30000,
  });

  const chartData = (data?.spendOverTime || []).map((point) => ({
    date: point.date,
    spend: Number(point.spendMinor) / 100,
    count: point.count,
  }));

  const totalPeriodSpend = chartData.reduce((acc, curr) => acc + curr.spend, 0);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">Spend & Billing Trends</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Total for period:{' '}
            <span className="font-mono font-medium text-slate-200">
              ${totalPeriodSpend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </p>
        </div>

        {/* Range Selector */}
        <div className="flex items-center rounded-lg bg-slate-800 p-0.5 border border-slate-700/60 self-start sm:self-auto">
          {(['7d', '30d', '12m'] as TimeRange[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                range === r
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Canvas */}
      <div className="h-64 w-full">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            Loading analytics data...
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-xs text-slate-500">
            <Calendar className="h-8 w-8 text-slate-600 mb-2" />
            <span>No transaction data available for this range</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
              <XAxis
                dataKey="date"
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                tickFormatter={(val: string) => {
                  if (range === '12m') return val;
                  const parts = val.split('-');
                  return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : val;
                }}
              />
              <YAxis
                stroke="#64748b"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => `$${val}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  borderColor: '#334155',
                  borderRadius: '0.75rem',
                  fontSize: '12px',
                  boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.5)',
                }}
                formatter={(val: number) => [
                  `$${val.toFixed(2)}`,
                  'Spend',
                ]}
                labelFormatter={(label) => `Date: ${label}`}
              />
              <Area
                type="monotone"
                dataKey="spend"
                stroke="#6366f1"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#spendGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
