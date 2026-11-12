export default function App() {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-800 rounded-xl border border-slate-700 p-8 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-4 w-4 rounded-full bg-indigo-500 animate-pulse" />
          <h1 className="text-xl font-bold tracking-tight text-white">LedgerGuard</h1>
        </div>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">
          Dynamic Multi-Tenant Zero-Knowledge Billing Engine. Zero-trust tenant isolation, RS256 cryptographic request signatures, and idempotent double-entry ledger.
        </p>
        <div className="border-t border-slate-700/60 pt-4 flex items-center justify-between text-xs text-slate-500 font-mono">
          <span>Phase 1: Foundation</span>
          <span className="text-emerald-400">Node.js 24 LTS</span>
        </div>
      </div>
    </div>
  );
}
