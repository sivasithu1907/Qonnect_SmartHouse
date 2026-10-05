import React from 'react';

/** Dashboard section shell: one heading style, subtle border, restrained shadow, content-sized. */
export function Section({ id, title, icon, meta, actions, children, bodyClassName = 'px-5 pb-5 pt-4' }: {
  id: string; title: React.ReactNode; icon?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; bodyClassName?: string;
}) {
  return (
    <section aria-labelledby={id} className="bg-white rounded-xl border border-slate-200 shadow-2xs min-w-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <h2 id={id} className="flex items-center gap-2 text-base font-semibold text-slate-900">{icon}{title}</h2>
        {meta && <div className="text-sm text-slate-500">{meta}</div>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export const linkBtn = 'inline-flex min-h-9 items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 no-underline shadow-2xs';
export const primaryLinkBtn = 'inline-flex min-h-9 items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-600 bg-sky-600 text-sm font-semibold text-white hover:bg-sky-700 no-underline';

/**
 * Shared checklist grid so every row lines up: status icon | details | progress | action.
 * Below md, progress and action move under the details (column 2).
 */
export const CHECKLIST_ROW_GRID = 'grid grid-cols-[24px_minmax(0,1fr)] md:grid-cols-[24px_minmax(0,1fr)_180px_140px] gap-x-4 gap-y-2 items-center';
/** Section header on the same grid: the title spans icon + details, so its progress lines up with the row progress column. */
export const CHECKLIST_HEADER_GRID = 'grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_180px_140px] gap-x-4 gap-y-3 items-center';
export const CHECKLIST_ACTION = 'inline-flex h-9 w-full max-w-[140px] items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-sky-700 hover:bg-sky-50 no-underline whitespace-nowrap';

/** Count label directly above a fixed-width bar, both left-aligned. */
export function ProgressBlock({ label, done, total, tone = 'sky', ariaLabel }: { label: React.ReactNode; done: number; total: number; tone?: 'sky' | 'emerald'; ariaLabel?: string }) {
  return (
    <div className="w-full max-w-[180px]">
      <p className="text-sm text-slate-700 leading-5">{label}</p>
      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden" role={ariaLabel ? 'progressbar' : undefined} aria-label={ariaLabel}
        aria-valuemin={ariaLabel ? 0 : undefined} aria-valuemax={ariaLabel ? total : undefined} aria-valuenow={ariaLabel ? done : undefined} aria-hidden={ariaLabel ? undefined : true}>
        <div className={`h-full rounded-full ${tone === 'emerald' ? 'bg-emerald-500' : 'bg-sky-600'}`} style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%` }} />
      </div>
    </div>
  );
}
