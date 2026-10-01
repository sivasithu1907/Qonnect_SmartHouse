import React from 'react';
import { Check } from 'lucide-react';
import type { ExpectedDateKind } from '../../../shared/calc';
import { expectedDeliveryDate } from '../../../shared/calc';
import { formatDate } from '../../lib/format';
import type { MaterialItem } from '../../lib/types';

export type MarkKind = ExpectedDateKind | 'actual';

/**
 * Distinct shapes per date kind, so a required-on-site date never looks like a delivery date:
 *   revised = solid violet diamond · supplier-confirmed = solid sky diamond · planned = hollow sky diamond
 *   required on site = dashed amber square · actual delivery = green circle with tick
 */
export const MARK_LEGEND: Array<{ kind: MarkKind; label: string; hint: string }> = [
  { kind: 'revised', label: 'Revised delivery', hint: 'Latest revised delivery date' },
  { kind: 'confirmed', label: 'Supplier-confirmed', hint: 'Delivery date confirmed by the supplier' },
  { kind: 'planned', label: 'Planned delivery', hint: 'Planned, not yet confirmed' },
  { kind: 'required', label: 'Required on site', hint: 'Need-by date — not a delivery confirmation' },
  { kind: 'actual', label: 'Actual delivery', hint: 'Delivered on this date' },
];

export function Mark({ kind, size = 12, overdue = false, title }: { kind: MarkKind; size?: number; overdue?: boolean; title?: string }) {
  const ring = overdue ? 'ring-2 ring-rose-400 ring-offset-1' : '';
  if (kind === 'actual') {
    return (
      <span title={title} aria-label={title} className={`inline-flex items-center justify-center rounded-full bg-emerald-500 text-white shrink-0 ${ring}`} style={{ width: size + 2, height: size + 2 }}>
        <Check style={{ width: size - 2, height: size - 2 }} strokeWidth={3} />
      </span>
    );
  }
  if (kind === 'required') {
    return <span title={title} aria-label={title} className={`inline-block border-2 border-dashed border-amber-500 bg-amber-50 rounded-[2px] shrink-0 ${ring}`} style={{ width: size, height: size }} />;
  }
  const cls = kind === 'revised' ? 'bg-violet-600 border-violet-600' : kind === 'confirmed' ? 'bg-sky-600 border-sky-600' : 'bg-white border-sky-500';
  return (
    <span title={title} aria-label={title} className={`inline-block shrink-0 ${ring}`} style={{ width: size, height: size }}>
      <span className={`block w-full h-full rotate-45 scale-[0.78] border-2 ${cls}`} />
    </span>
  );
}

export function MarkLegend({ only }: { only?: MarkKind[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
      {MARK_LEGEND.filter((l) => !only || only.includes(l.kind)).map((l) => (
        <span key={l.kind} className="inline-flex items-center gap-1.5" title={l.hint}><Mark kind={l.kind} size={10} />{l.label}</span>
      ))}
      <span className="inline-flex items-center gap-1.5" title="Open line whose expected date has passed without an actual delivery">
        <span className="inline-block w-2.5 h-2.5 rounded-full ring-2 ring-rose-400" />Overdue
      </span>
    </div>
  );
}

/** Labelled list of a material line's dates (read-only), each kind kept separate. */
export function MaterialDateSummary({ m }: { m: MaterialItem }) {
  const exp = expectedDeliveryDate(m);
  const rows: Array<[MarkKind, string, string | null]> = [
    ['required', 'Required on site / supply due', m.required_on_site_date],
    ['planned', 'Planned delivery', m.planned_delivery_date],
    ['confirmed', 'Supplier-confirmed delivery', m.confirmed_delivery_date],
    ['revised', 'Revised delivery', m.revised_delivery_date],
    ['actual', 'Actual delivery', m.actual_delivery_date],
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-700">
        <b>Expected delivery:</b>{' '}
        {exp ? <>{formatDate(exp.date)} <span className="text-slate-500">({exp.label})</span></> : <span className="text-slate-400">No date entered</span>}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {rows.map(([kind, label, v]) => (
          <div key={kind} className="flex items-center gap-2">
            <Mark kind={kind} size={10} />
            <dt className="text-slate-500">{label}:</dt>
            <dd className={v ? 'text-slate-800 font-semibold' : 'text-slate-400'}>{formatDate(v)}</dd>
          </div>
        ))}
      </dl>
      {m.delivery_date_note && <div className="text-[11px] text-amber-800">{m.delivery_date_note}</div>}
    </div>
  );
}
