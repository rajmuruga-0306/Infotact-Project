import { useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { Navbar } from './components/Navbar';
import { AlertsBanner } from './components/AlertsBanner';
import { KpiCards } from './components/KpiCards';
import { SpendChart } from './components/SpendChart';
import { ResourceBreakdownChart } from './components/ResourceBreakdownChart';
import { LiveLedgerFeed } from './components/LiveLedgerFeed';
import { UsageMeterForm } from './components/UsageMeterForm';
import { AuthForms } from './components/AuthForms';
import { Shield, Lock } from 'lucide-react';

export default function App() {
  const { user, accessToken, currentOrg, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <span className="text-xs font-mono text-slate-400">Loading LedgerGuard session...</span>
        </div>
      </div>
    );
  }

  if (!user || !accessToken || !currentOrg) {
    return <AuthForms />;
  }

  return (
    <SocketProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
        {/* Navigation Bar */}
        <Navbar />

        {/* Dashboard Content */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          {/* Real-time Alerts Banner */}
          <AlertsBanner />

          {/* Key Metric KPI Cards */}
          <KpiCards />

          {/* Analytics & Trend Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <SpendChart />
            </div>
            <div className="lg:col-span-1">
              <ResourceBreakdownChart />
            </div>
          </div>

          {/* Ledger & Usage Engine Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <UsageMeterForm />
            <LiveLedgerFeed />
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-slate-900 bg-slate-950/60 py-6 mt-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-indigo-400" />
              <span>LedgerGuard Engine • Multi-Tenant Zero-Knowledge Billing System</span>
            </div>
            <div className="flex items-center gap-4 font-mono text-[11px]">
              <span className="flex items-center gap-1 text-slate-400">
                <Lock className="h-3 w-3 text-emerald-400" /> RSA-SHA256 Signed
              </span>
              <span>Node.js 24 LTS</span>
              <span className="text-emerald-400">ACID Transactions</span>
            </div>
          </div>
        </footer>
      </div>
    </SocketProvider>
  );
}
