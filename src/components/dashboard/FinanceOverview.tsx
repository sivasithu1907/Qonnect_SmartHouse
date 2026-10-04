import React from 'react';
import { AlertTriangle, CalendarClock, Coins, CreditCard, Info, Wallet } from 'lucide-react';
import { formatQAR } from '../../lib/format';
import type { financeOverview } from '../../lib/dashboard';
import { Badge, Card, NeedsConfirmation } from '../ui';

type Fin = ReturnType<typeof financeOverview>;

function Tile({ label, icon, value, hint, tone = 'slate' }: { label: string; icon: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; tone?: 'slate' | 'emerald' | 'sky' | 'amber' | 'rose' }) {
  const color = { slate: 'text-slate-900', emerald: 'text-emerald-700', sky: 'text-sky-700', amber: 'text-amber-800', rose: 'text-rose-700' }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-1 min-w-0">
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">{icon}{label}</span>
      <span className={`text-lg sm:text-xl font-bold font-mono break-words ${color}`}>{value}</span>
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
  );
}

/** Confirmed control budget, actual paid, scheduled unpaid and budget remaining — no double counting. */
export function FinanceOverview({ projectId, fin }: { projectId: string; fin: Fin | null }) {
  if (!fin) {
    return (
      <Card title="Financial overview">
        <p className="flex items-center gap-2 text-sm text-slate-600"><Info className="w-4 h-4 text-sky-600" />Financial figures are not available for your role.</p>
      </Card>
    );
  }
  const b = fin.budget ?? 0;
  const track = fin.confirmed ? Math.max(b, fin.paid) : 0;
  return (
    <Card title="Financial overview" subtitle="Approved / finalized amounts and recorded transfers only"
      actions={<>
        <a href={`#/budget/${projectId}`} className="inline-flex items-center px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 no-underline">Budget details</a>
        <a href={`#/payments/${projectId}`} className="inline-flex items-center px-2.5 py-1 rounded-lg border border-sky-600 bg-sky-600 text-xs font-semibold text-white hover:bg-sky-700 no-underline">View payments</a>
      </>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {fin.confirmed
          ? <Tile label="Confirmed control budget" icon={<Coins className="w-4 h-4 text-slate-400" />} value={formatQAR(fin.budget)} hint="Confirmed in project settings" />
          : <Tile label="Confirmed control budget" icon={<Coins className="w-4 h-4 text-slate-400" />} value={<NeedsConfirmation />} hint={fin.budget !== null ? `Entered ${formatQAR(fin.budget)} — not confirmed` : 'No control budget entered'} />}
        <Tile label="Actual paid" tone="sky" icon={<CreditCard className="w-4 h-4 text-sky-500" />} value={formatQAR(fin.paid)} hint={`${fin.transactionCount} recorded transfer${fin.transactionCount === 1 ? '' : 's'}`} />
        <Tile label="Scheduled unpaid" tone="amber" icon={<CalendarClock className="w-4 h-4 text-amber-500" />} value={formatQAR(fin.unpaid)} hint={`${fin.unpaidCount} milestone${fin.unpaidCount === 1 ? '' : 's'} with an outstanding balance`} />
        {!fin.confirmed ? <Tile label="Budget remaining" icon={<Wallet className="w-4 h-4 text-slate-400" />} value={<span className="text-slate-400">—</span>} hint="Shown once the control budget is confirmed" />
          : fin.over > 0 ? <Tile label="Budget remaining" tone="rose" icon={<AlertTriangle className="w-4 h-4 text-rose-500" />} value={`−${formatQAR(fin.over)}`} hint={<b className="text-rose-700">Over budget by {formatQAR(fin.over)}</b>} />
          : <Tile label="Budget remaining" tone="emerald" icon={<Wallet className="w-4 h-4 text-emerald-500" />} value={formatQAR(fin.remaining)} hint="Control budget minus actual paid" />}
      </div>

      <div className="mt-4 space-y-2">
        {!fin.confirmed ? (
          <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />Spending against the control budget appears once an admin confirms the control budget.</p>
        ) : fin.spentPct === null ? (
          <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />The confirmed control budget is {formatQAR(0)}, so spending can’t be shown as a percentage.</p>
        ) : (
          <>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold text-slate-800">Spending vs control budget</span>
              <span className="text-slate-700"><b className="font-mono">{fin.spentPct.toFixed(1)}%</b> of the control budget paid{fin.over > 0 && <b className="text-rose-700"> · {formatQAR(fin.over)} over</b>}</span>
            </div>
            <div className="relative h-3 rounded-full bg-slate-200" role="img" aria-label={`Paid ${formatQAR(fin.paid)} of ${formatQAR(b)} control budget, ${fin.spentPct.toFixed(1)} percent`}>
              <div className={`absolute inset-y-0 left-0 bg-sky-600 ${fin.over > 0 ? 'rounded-l-full' : 'rounded-full'}`} style={{ width: `${(Math.min(fin.paid, b) / track) * 100}%` }} />
              {fin.over > 0 && <div className="absolute inset-y-0 bg-rose-500 rounded-r-full" style={{ left: `${(b / track) * 100}%`, width: `${(fin.over / track) * 100}%` }} />}
              {fin.over > 0 && <div className="absolute -inset-y-1 w-0.5 bg-slate-900 rounded" style={{ left: `calc(${(b / track) * 100}% - 1px)` }} aria-hidden="true" />}
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500 font-mono"><span>Paid {formatQAR(fin.paid)}</span><span>Control budget {formatQAR(b)}</span></div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <Badge tone={fin.overdue > 0 ? 'rose' : 'slate'}>{fin.overdue > 0 ? 'Overdue' : 'No overdue'}</Badge>
          {fin.overdue > 0
            ? <span><b className="font-mono">{formatQAR(fin.overdue)}</b> of the scheduled unpaid amount is past due ({fin.overdueCount} milestone{fin.overdueCount === 1 ? '' : 's'}).</span>
            : <span>No scheduled payment is past its due date.</span>}
        </div>
        <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />Budget remaining = confirmed control budget − actual paid. It is not uncommitted or available cash; scheduled unpaid amounts are not deducted from it, and contract values are not added to these totals.</p>
      </div>
    </Card>
  );
}
