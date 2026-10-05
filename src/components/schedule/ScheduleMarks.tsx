import React from 'react';
import { CalendarX2, Check } from 'lucide-react';
import { formatDate } from '../../lib/format';
import type { MaterialItem } from '../../lib/types';
import { materialSchedule } from '../../../shared/materialSchedule';
import { PreviousDateDetails } from '../materials/MaterialScheduleParts';

export type MarkKind = 'planned' | 'actual' | 'planned_work' | 'actual_work' | 'legacy';

/**
 * Distinct shapes per date kind, so material arrival never looks like completed work:
 *   planned delivery = hollow sky diamond · actual delivery = green circle with tick
 *   planned completion = hollow indigo square · actual completion = indigo circle with tick
 *   previous date awaiting review = dashed amber square
 */
export const MARK_LEGEND: Array<{ kind: MarkKind; label: string; hint: string }> = [
  { kind: 'planned', label: 'Planned delivery', hint: 'Owner supply: agreed date the material should arrive on site' },
  { kind: 'actual', label: 'Actual delivery', hint: 'Owner supply: date the material arrived' },
  { kind: 'planned_work', label: 'Planned completion', hint: 'Contractor supply: when the work should be finished' },
  { kind: 'actual_work', label: 'Actual completion', hint: 'Contractor supply: when the work finished' },
  { kind: 'legacy', label: 'Previous date (needs review)', hint: 'Older date still used until an authorised user confirms the planned date' },
];

export function Mark({ kind, size = 12, overdue = false, title }: { kind: MarkKind; size?: number; overdue?: boolean; title?: string }) {
  const ring = overdue ? 'ring-2 ring-rose-400 ring-offset-1' : '';
  if (kind === 'actual' || kind === 'actual_work') {
    return (
      <span title={title} aria-label={title} className={`inline-flex items-center justify-center rounded-full text-white shrink-0 ${kind === 'actual' ? 'bg-emerald-500' : 'bg-indigo-600'} ${ring}`} style={{ width: size + 2, height: size + 2 }}>
        <Check style={{ width: size - 2, height: size - 2 }} strokeWidth={3} />
      </span>
    );
  }
  if (kind === 'legacy') {
    return <span title={title} aria-label={title} className={`inline-block border-2 border-dashed border-amber-500 bg-amber-50 rounded-[2px] shrink-0 ${ring}`} style={{ width: size, height: size }} />;
  }
  if (kind === 'planned_work') {
    return <span title={title} aria-label={title} className={`inline-block border-2 border-indigo-500 bg-white rounded-[2px] shrink-0 ${ring}`} style={{ width: size, height: size }} />;
  }
  return (
    <span title={title} aria-label={title} className={`inline-block shrink-0 ${ring}`} style={{ width: size, height: size }}>
      <span className="block w-full h-full rotate-45 scale-[0.78] border-2 bg-white border-sky-500" />
    </span>
  );
}

/** Legend for the kinds actually shown (the previous-date marker appears only while lines await review). */
export function MarkLegend({ only }: { only?: MarkKind[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
      {MARK_LEGEND.filter((l) => (only ? only.includes(l.kind) : l.kind !== 'legacy')).map((l) => (
        <span key={l.kind} className="inline-flex items-center gap-1.5" title={l.hint}><Mark kind={l.kind} size={10} />{l.label}</span>
      ))}
      <span className="inline-flex items-center gap-1.5" title="Delivery or work still outstanding after its planned date">
        <span className="inline-block w-2.5 h-2.5 rounded-full ring-2 ring-rose-400" />Overdue
      </span>
    </div>
  );
}

/** Read-only summary of a material line's schedule: the two simplified dates, review state and previous dates. */
export function MaterialDateSummary({ m }: { m: MaterialItem }) {
  const s = materialSchedule(m);
  const work = s.workflow === 'contractor';
  return (
    <div className="space-y-2">
      {s.workflow === 'unassigned' ? (
        <p className="text-xs text-slate-600">Supply responsibility needs confirmation — the schedule is set once Owner or Contractor supply is chosen.</p>
      ) : (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {([[work ? 'planned_work' : 'planned', s.plannedLabel, s.planned], [work ? 'actual_work' : 'actual', s.actualLabel, s.actual]] as Array<[MarkKind, string, string | null]>).map(([kind, label, v]) => (
            <div key={kind} className="flex items-center gap-2">
              <Mark kind={kind} size={10} />
              <dt className="text-slate-500">{label}:</dt>
              <dd className={v ? 'text-slate-800 font-semibold' : 'text-slate-400'}>{formatDate(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {s.needsReview && s.deadline && (
        <div className="flex items-center gap-2 text-xs text-amber-900"><Mark kind="legacy" size={10} />Previous date in use: {formatDate(s.deadline.date)} <span className="text-amber-800">({s.deadline.label})</span></div>
      )}
      {s.partial && <div className="text-[11px] text-amber-800">Partially delivered — more is expected.</div>}
      <PreviousDateDetails m={m} />
    </div>
  );
}

/** One-line empty state for schedule areas (keeps navigation actions inline). */
export function CompactEmpty({ title, children, actions }: { title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-dashed border-slate-200 bg-slate-50/60 rounded-lg px-3 py-2" role="status">
      <CalendarX2 className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="min-w-0 mr-auto text-xs">
        <span className="font-semibold text-slate-700">{title}</span>
        {children && <span className="text-slate-500"> — {children}</span>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1">{actions}</div>}
    </div>
  );
}
