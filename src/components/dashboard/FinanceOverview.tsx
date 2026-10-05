import React from 'react';
import { AlertTriangle, CalendarClock, Coins, CreditCard, ListChecks, Wallet } from 'lucide-react';
import { formatQAR } from '../../lib/format';
import type { financeOverview } from '../../lib/dashboard';
import { InfoPopover } from '../InfoPopover';
import { linkBtn, primaryLinkBtn, Section } from './Section';

type Fin = ReturnType<typeof financeOverview>;
type Tone = 'slate' | 'emerald' | 'sky' | 'amber' | 'rose' | 'muted';
const TONE: Record<Tone, string> = { slate: 'text-slate-900', emerald: 'text-emerald-700', sky: 'text-sky-700', amber: 'text-amber-800', rose: 'text-rose-700', muted: 'text-slate-400' };

function Metric({ label, icon, info, value, tone = 'slate', sub, amount = true }: { label: string; icon: React.ReactNode; info: React.ReactNode; value: React.ReactNode; tone?: Tone; sub?: React.ReactNode; amount?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5 min-w-0 flex flex-col">
      <div className="flex items-center gap-1.5 text-sm font-medium text-slate-600">{icon}<span>{label}</span><InfoPopover label={`About ${label.toLowerCase()}`}>{info}</InfoPopover></div>
      <div className={`mt-1 break-words ${amount ? 'text-2xl font-bold font-mono tabular-nums tracking-tight leading-8' : 'text-lg font-semibold leading-8'} ${TONE[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</h3>;
}

/**
 * Two groups: budget planning (project budget, total incl. miscellaneous) and payment tracking (actual paid,
 * scheduled unpaid, budget left after payments). Itemized costs above budget (planned) stay separate from
 * payments above budget (spent). Calculations come from the shared budget and payment logic.
 */
export function FinanceOverview({ projectId, fin, canConfirmBudget, onSettings }: { projectId: string; fin: Fin | null; canConfirmBudget: boolean; onSettings: () => void }) {
  if (!fin) {
    return <Section id="fin-title" title="Financial overview"><p className="text-sm text-slate-600">Financial figures are not available for your role.</p></Section>;
  }
  const b = fin.budget ?? 0;
  const it = fin.itemized;
  const track = fin.confirmed ? Math.max(b, fin.paid) : 0;
  const overPct = it && it.aboveControl > 0 && it.controlBudget ? (it.aboveControl / it.controlBudget) * 100 : null;
  return (
    <Section id="fin-title" title="Financial overview"
      actions={<>
        <a href={`#/budget/${projectId}`} className={linkBtn}>Budget details</a>
        <a href={`#/payments/${projectId}`} className={primaryLinkBtn}>View payments</a>
      </>}>
      <div className="space-y-4">
        <div className="space-y-2">
          <GroupLabel>Budget planning</GroupLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Metric label="Project budget" icon={<Coins className="w-4 h-4 text-slate-400" />}
              info="The control budget entered and confirmed by an admin in project settings. It is the approved spending limit and never changes automatically."
              value={fin.confirmed ? formatQAR(fin.budget) : fin.budget !== null ? 'Needs confirmation' : 'Not entered'}
              amount={fin.confirmed} tone={fin.confirmed ? 'slate' : fin.budget !== null ? 'amber' : 'muted'}
              sub={fin.confirmed ? 'Confirmed control budget' : (
                <span className="flex flex-wrap items-center gap-x-2">
                  {fin.budget !== null && <span>Entered {formatQAR(fin.budget)}</span>}
                  {canConfirmBudget ? <button type="button" onClick={onSettings} className="font-semibold text-sky-700 hover:text-sky-900">{fin.budget !== null ? 'Confirm in settings' : 'Enter in settings'}</button> : <span>An admin confirms it in settings</span>}
                </span>
              )} />
            {it ? (
              <Metric label="Total incl. miscellaneous" icon={<ListChecks className="w-4 h-4 text-slate-400" />}
                info="Finalized items subtotal (fixed costs, finishing and other items with a finalized amount) plus the miscellaneous allowance, as on Master Items & Budget. Planned cost, not money spent. Contract values and payments are not added."
                value={formatQAR(it.grandTotal)}
                sub={it.complete ? `${formatQAR(it.finalizedSubtotal)} items + ${formatQAR(it.miscAllowance)} miscellaneous` : <b className="text-amber-800">Incomplete: {it.missingCount} item{it.missingCount === 1 ? '' : 's'} without a finalized amount</b>} />
            ) : <div className="hidden sm:block" />}
          </div>
        </div>

        <div className="space-y-2">
          <GroupLabel>Payment tracking</GroupLabel>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Metric label="Actual paid" icon={<CreditCard className="w-4 h-4 text-sky-500" />} tone="sky"
              info="The sum of recorded payment transfers. Archived transfers are excluded."
              value={formatQAR(fin.paid)} sub={`${fin.transactionCount} transfer${fin.transactionCount === 1 ? '' : 's'}`} />
            <Metric label="Scheduled unpaid" icon={<CalendarClock className="w-4 h-4 text-amber-500" />} tone="amber"
              info="Outstanding balances on scheduled payment milestones (scheduled amount minus transfers). Cancelled milestones count as zero. Overdue amounts are part of this figure."
              value={formatQAR(fin.unpaid)} sub={`${fin.unpaidCount} milestone${fin.unpaidCount === 1 ? '' : 's'}`} />
            <Metric label="Budget left after payments" icon={fin.over > 0 ? <AlertTriangle className="w-4 h-4 text-rose-500" /> : <Wallet className="w-4 h-4 text-slate-400" />}
              info="Project budget minus actual paid. Scheduled unpaid amounts are not deducted, and it does not show whether the itemized costs fit the budget."
              value={!fin.confirmed ? '—' : fin.over > 0 ? `−${formatQAR(fin.over)}` : formatQAR(fin.remaining)}
              tone={!fin.confirmed ? 'muted' : fin.over > 0 ? 'rose' : 'slate'}
              sub={!fin.confirmed ? 'Needs a confirmed budget' : fin.over > 0 ? <b className="text-rose-700">Overspent: payments exceed the budget by {formatQAR(fin.over)}</b> : 'Budget less recorded payments; unpaid commitments are not deducted.'} />
          </div>
        </div>
      </div>

      {fin.confirmed && fin.spentPct !== null && (
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
            <span className="font-semibold text-slate-800">Paid vs project budget</span>
            <span className="text-slate-600"><span className="font-mono tabular-nums">{formatQAR(fin.paid)}</span> of <span className="font-mono tabular-nums">{formatQAR(b)}</span> · <b className="font-mono tabular-nums text-slate-900">{fin.spentPct.toFixed(1)}%</b>{fin.over > 0 && <b className="text-rose-700"> · {formatQAR(fin.over)} over</b>}</span>
          </div>
          <div className="relative mt-1.5 h-2.5 rounded-full bg-slate-200" role="img" aria-label={`Paid ${formatQAR(fin.paid)} of ${formatQAR(b)} project budget, ${fin.spentPct.toFixed(1)} percent`}>
            <div className={`absolute inset-y-0 left-0 bg-sky-600 ${fin.over > 0 ? 'rounded-l-full' : 'rounded-full'}`} style={{ width: `${(Math.min(fin.paid, b) / track) * 100}%` }} />
            {fin.over > 0 && <div className="absolute inset-y-0 bg-rose-500 rounded-r-full" style={{ left: `${(b / track) * 100}%`, width: `${(fin.over / track) * 100}%` }} />}
            {fin.over > 0 && <div className="absolute -inset-y-1 w-0.5 bg-slate-900 rounded" style={{ left: `calc(${(b / track) * 100}% - 1px)` }} aria-hidden="true" />}
          </div>
        </div>
      )}
      {fin.confirmed && fin.spentPct === null && <p className="mt-3 text-sm text-slate-500">The confirmed project budget is {formatQAR(0)}, so paid vs budget isn’t shown as a percentage.</p>}

      {it && it.aboveControl > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-sm text-amber-900" role="note">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Itemized costs are {it.complete ? '' : 'at least '}<span className="font-mono tabular-nums">{formatQAR(it.aboveControl)}</span> above budget{overPct !== null ? ` (${overPct.toFixed(2)}%)` : ''}.</p>
            <p className="text-amber-800">Includes miscellaneous allowance. Actual paid: <span className="font-mono tabular-nums">{formatQAR(fin.paid)}</span>.{!it.complete && ` ${it.missingCount} item${it.missingCount === 1 ? ' has' : 's have'} no amount yet.`}</p>
          </div>
          <a href={`#/budget/${projectId}`} className="inline-flex min-h-9 items-center px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-sm font-semibold text-sky-700 hover:bg-amber-50 no-underline">Review budget</a>
        </div>
      )}
      {it && it.controlBudgetConfirmed && it.aboveControl === 0 && it.notAllocated > 0 && it.complete && (
        <p className="mt-3 text-sm text-slate-600">Budget not allocated to items: <b className="font-mono tabular-nums text-slate-900">{formatQAR(it.notAllocated)}</b></p>
      )}
      {fin.overdue > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0"><b className="font-mono tabular-nums">{formatQAR(fin.overdue)}</b> of the scheduled unpaid amount is overdue ({fin.overdueCount} milestone{fin.overdueCount === 1 ? '' : 's'}).</span>
          <a href={`#/payments/${projectId}`} className="font-semibold text-sky-700 hover:text-sky-900">Review payments</a>
        </div>
      )}
    </Section>
  );
}
