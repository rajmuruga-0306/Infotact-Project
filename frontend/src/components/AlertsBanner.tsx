import React from 'react';
import { useSocket, DashboardAlert } from '../context/SocketContext';
import { AlertTriangle, ShieldAlert, Info, X, CheckCheck } from 'lucide-react';

export const AlertsBanner: React.FC = () => {
  const { alerts, dismissAlert, clearAlerts } = useSocket();

  if (alerts.length === 0) return null;

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Live System Alerts ({alerts.length})
        </span>
        {alerts.length > 1 && (
          <button
            type="button"
            onClick={clearAlerts}
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Dismiss All
          </button>
        )}
      </div>

      {alerts.map((alert: DashboardAlert) => {
        const isLimit = alert.type === 'limit';
        const isSecurity = alert.type === 'security';
        const isCritical = alert.severity === 'critical';

        let bgClass = 'bg-slate-900 border-slate-700 text-slate-200';
        let icon = <Info className="h-5 w-5 text-indigo-400" />;

        if (isLimit) {
          bgClass = isCritical
            ? 'bg-rose-950/50 border-rose-600/50 text-rose-100 shadow-rose-950/20'
            : 'bg-amber-950/40 border-amber-500/40 text-amber-100 shadow-amber-950/20';
          icon = <AlertTriangle className={`h-5 w-5 shrink-0 ${isCritical ? 'text-rose-400' : 'text-amber-400'}`} />;
        } else if (isSecurity) {
          bgClass = 'bg-red-950/60 border-red-500/60 text-red-100 shadow-red-950/30';
          icon = <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />;
        }

        return (
          <div
            key={alert.id}
            className={`flex items-start justify-between gap-3 rounded-xl border p-4 shadow-lg backdrop-blur-md transition-all ${bgClass}`}
          >
            <div className="flex items-start gap-3">
              {icon}
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold uppercase tracking-wide">{alert.title}</h4>
                  <span className="text-[10px] opacity-60 font-mono">
                    {new Date(alert.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-0.5 text-xs opacity-90 leading-relaxed">{alert.message}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => dismissAlert(alert.id)}
              className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
