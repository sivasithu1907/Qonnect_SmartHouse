import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { formatQAR } from '../../lib/format';
import type { ContractFinance } from '../../../shared/contractFinance';

export const REMAINING_NOTE = 'Remaining contract balance includes amounts not yet scheduled. It is not necessarily due now.';

const hasAny = (f: ContractFinance) => f.contractValue !== null || f.linkedMilestoneCount > 0;

/** Contract list (table): Paid and Remaining contract balance; scheduled unpaid as secondary text. */
export function ContractFinanceCell({ f }: { f?: ContractFinance }) {
  if (!f || !hasAny(f)) return <span className="text-slate-400">None linked</span>;
  return (
    <div className="space-y-0.5">
      <div className="text-sky-700">Paid {formatQAR(f.paid)}</div>
      {f.remaining === null
        ? <div className="text-slate-500">Remaining — value not entered</div>
        : <div className="text-slate-800">Remaining {formatQAR(f.remaining)}</div>}
      {f.overpaid > 0 && <div className="text-rose-700 font-semibold">Overpaid {formatQAR(f.overpaid)}</div>}
      {f.scheduledUnpaid > 0 && <div className="text-[11px] text-amber-800">Scheduled unpaid {formatQAR(f.scheduledUnpaid)}</div>}
    </div>
  );
}

/** Contract list (phone cards): same figures on one line. */
export function ContractFinanceInline({ f }: { f?: ContractFinance }) {
  if (!f || !hasAny(f)) return null;
  return (
    <span>
      Paid {formatQAR(f.paid)} · {f.remaining === null ? 'Remaining — value not entered' : `Remaining ${formatQAR(f.remaining)}`}
      {f.overpaid > 0 && <b className="text-rose-700"> · Overpaid {formatQAR(f.overpaid)}</b>}
      {f.scheduledUnpaid > 0 && <span className="text-amber-800"> · Scheduled unpaid {formatQAR(f.scheduledUnpaid)}</span>}
    </span>
  );
}

function Tile({ label, value, sub, tone = 'text-slate-900' }: { label: string; value: string; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="border border-slate-200 rounded-lg px-3 py-2 bg-white min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-mono font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

/** Contract detail: the four amounts, kept distinct (remaining and scheduled unpaid overlap — never summed). */
export function ContractFinancePanel({ f }: { f: ContractFinance }) {
  return (
    <div className="space-y-2" data-testid="contract-finance">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
        <Tile label="Contract value" value={formatQAR(f.contractValue, { blank: 'Not entered' })} tone={f.contractValue === null ? 'text-slate-400' : 'text-slate-900'} />
        <Tile label="Paid against this contract" value={formatQAR(f.paid)} tone="text-sky-700"
          sub={`${f.transferCount} transfer${f.transferCount === 1 ? '' : 's'} on linked milestones`} />
        <Tile label="Remaining contract balance" value={f.remaining === null ? 'Needs contract value' : formatQAR(f.remaining)}
          tone={f.remaining === null ? 'text-slate-400' : 'text-slate-900'}
          sub={f.notYetScheduled !== null && f.remaining !== null && f.remaining > 0 ? `Not yet scheduled ${formatQAR(f.notYetScheduled)}` : f.remaining === null ? 'Enter the contract value to see it' : undefined} />
        <Tile label="Scheduled unpaid" value={formatQAR(f.scheduledUnpaid)} tone="text-amber-800"
          sub={`${f.milestoneCount} active milestone${f.milestoneCount === 1 ? '' : 's'}${f.overdueCount ? ` · ${f.overdueCount} overdue` : ''}`} />
      </div>
      {f.overpaid > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-rose-800 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2" role="note">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
          <span>Payments exceed the contract value by <b className="font-mono">{formatQAR(f.overpaid)}</b>. Check the contract value or the linked transfers.</span>
        </p>
      )}
      <p className="flex items-start gap-1.5 text-[11px] text-slate-600">
        <Info className="w-3.5 h-3.5 shrink-0 mt-px text-slate-400" aria-hidden="true" />
        <span>{REMAINING_NOTE} Scheduled unpaid is the outstanding balance of linked payment milestones; the two overlap and are not added together.</span>
      </p>
      {f.paidOnArchived > 0 && (
        <p className="text-[11px] text-slate-600">Paid includes {formatQAR(f.paidOnArchived)} recorded on {f.archivedMilestonesWithPayments} archived milestone{f.archivedMilestonesWithPayments === 1 ? '' : 's'}. The Payments page totals leave archived milestones out.</p>
      )}
      <p className="text-[11px] text-slate-500">Amendments are kept as records and documents; they do not change the contract value. Edit the contract value if an approved change alters it.</p>
    </div>
  );
}
