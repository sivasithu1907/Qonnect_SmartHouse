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
