// Lightweight SVG/CSS charts (no chart library). Empty data renders "No records yet".
import React from 'react';
import { formatQAR, formatQARCompact } from '../lib/format';

const EMPTY = <p className="text-xs text-slate-500 py-6 text-center">No records yet</p>;

export interface SeriesDef { key: string; label: string; color: string }

/** Horizontal grouped bars per category, e.g. budget vs committed vs paid. */
export function GroupedBars({ rows, series }: { rows: Array<{ label: string; values: Record<string, number | null> }>; series: SeriesDef[] }) {
  const max = Math.max(0, ...rows.flatMap((r) => series.map((s) => r.values[s.key] ?? 0)));
  if (!rows.length || max === 0) return EMPTY;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[11px] text-slate-600">
        {series.map((s) => <span key={s.key} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
      </div>
      {rows.map((r) => (
        <div key={r.label}>
          <div className="text-[11px] font-semibold text-slate-700 mb-1 truncate">{r.label}</div>
          <div className="space-y-0.5">
            {series.map((s) => {
              const v = r.values[s.key];
              return (
                <div key={s.key} className="flex items-center gap-2" title={`${s.label}: ${v === null || v === undefined ? 'not set' : formatQAR(v)}`}>
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${v ? Math.max(1, (v / max) * 100) : 0}%`, background: s.color }} />
                  </div>
                  <span className="w-16 text-right text-[10px] font-mono text-slate-500">{v === null || v === undefined ? '—' : formatQARCompact(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Stacked horizontal bar of counts by label. */
export function CountBreakdown({ counts, colorFor }: { counts: Record<string, number>; colorFor: (label: string) => string }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return EMPTY;
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
        {entries.map(([k, n]) => <div key={k} title={`${k}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: colorFor(k) }} />)}
      </div>
      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([k, n]) => (
          <li key={k} className="flex items-center justify-between text-[11px] text-slate-600">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: colorFor(k) }} />{k}</span>
            <span className="font-mono font-semibold text-slate-800">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Vertical monthly bars. */
export function MonthlyBars({ data }: { data: Array<{ month: string; amount: number }> }) {
  if (!data.length) return EMPTY;
  const max = Math.max(...data.map((d) => d.amount));
  return (
    <div className="flex items-end gap-2 h-40 pt-4">
      {data.map((d) => (
        <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${d.month}: ${formatQAR(d.amount)}`}>
          <span className="text-[9px] font-mono text-slate-500">{formatQARCompact(d.amount)}</span>
          <div className="w-full max-w-10 bg-sky-500 rounded-t" style={{ height: `${Math.max(2, (d.amount / max) * 110)}px` }} />
          <span className="text-[10px] text-slate-500">{d.month.slice(5)}/{d.month.slice(2, 4)}</span>
        </div>
      ))}
    </div>
  );
}

export function ProgressRow({ label, done, total, sub }: { label: React.ReactNode; done: number; total: number; sub?: React.ReactNode }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-slate-700 truncate">{label}</span>
        <span className="font-mono text-slate-500 shrink-0">{done}/{total}</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

const PALETTE: Record<string, string> = {
  'Status not confirmed': '#f59e0b', 'Not Ordered': '#94a3b8', 'Quotation Requested': '#fbbf24', 'Awaiting Approval': '#fcd34d',
  Ordered: '#38bdf8', 'Awaiting Supplier Confirmation': '#fde68a', 'In Production': '#0ea5e9', Dispatched: '#0284c7',
  'Partially Delivered': '#6366f1', Delivered: '#10b981', 'Inspection Pending': '#a78bfa', Accepted: '#059669',
  Delayed: '#f43f5e', 'On Hold': '#64748b', Cancelled: '#cbd5e1',
};
export const materialColor = (s: string) => PALETTE[s] ?? '#94a3b8';
