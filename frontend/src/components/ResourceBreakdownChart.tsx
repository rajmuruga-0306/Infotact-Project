import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { usageApi } from '../api/apiClient';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Layers, Database } from 'lucide-react';

const RESOURCE_COLORS: Record<string, string> = {
  api_calls: '#6366f1', // Indigo
  compute_minutes: '#06b6d4', // Cyan
  storage_gb: '#10b981', // Emerald
  ai_tokens: '#a855f7', // Purple
  database_reads: '#f59e0b', // Amber
  network_egress_gb: '#f43f5e', // Rose
};

const DEFAULT_COLORS = ['#6366f1', '#06b6d4', '#10b981', '#a855f7', '#f59e0b', '#ec4899'];

export const ResourceBreakdownChart: React.FC = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', '30d'],
    queryFn: () => usageApi.getAnalytics('30d'),
    refetchInterval: 30000,
  });

  const rawBreakdown = data?.resourceBreakdown || [];

  const chartData = rawBreakdown.map((item, index) => ({
    name: item.resource.replace(/_/g, ' '),
    rawName: item.resource,
    units: item.totalUnits,
    cost: Number(item.totalCostMinor) / 100,
    percentage: item.percentage,
    color: RESOURCE_COLORS[item.resource] || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
  }));

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 shadow-lg backdrop-blur-sm flex flex-col justify-between">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Layers className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">Resource Spend Breakdown</h3>
        </div>
        <p className="text-xs text-slate-400 mb-4">
          Cost distribution across metered services (Last 30 Days)
        </p>
      </div>

      {isLoading ? (
        <div className="flex h-56 items-center justify-center text-xs text-slate-500">
          Loading breakdown...
        </div>
      ) : chartData.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center text-xs text-slate-500">
          <Database className="h-8 w-8 text-slate-600 mb-2" />
          <span>No resource usage logged yet</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
          {/* Donut Chart */}
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="cost"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} stroke="#0f172a" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#334155',
                    borderRadius: '0.75rem',
                    fontSize: '12px',
                    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.5)',
                  }}
                  formatter={(val: number) => [`$${val.toFixed(2)}`, 'Cost']}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Legend / Table */}
          <div className="space-y-2">
            {chartData.map((item) => (
              <div key={item.rawName} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 truncate">
                  <div
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="font-medium text-slate-300 capitalize truncate">{item.name}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-slate-400 font-mono text-[11px]">
                    {item.units.toLocaleString()} units
                  </span>
                  <span className="font-mono font-medium text-white">
                    ${item.cost.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-400 flex justify-between">
        <span>Metered & Graduated Pricing</span>
        <span>Real-Time Ingestion</span>
      </div>
    </div>
  );
};
