import React, { useState } from 'react';
import { CheckCircle2, Circle, CircleAlert } from 'lucide-react';
import { attentionSummary, type AttentionItem, type SetupItem } from '../lib/projectHealth';
import type { Section as AppSection } from '../lib/types';
import { CHECKLIST_ACTION, CHECKLIST_ROW_GRID, ProgressBlock, Section } from './dashboard/Section';

/** One setup step on the shared checklist grid; completion comes only from saved data. Partial progress shows as "22/40 assigned". */
export function SetupRow({ i, onSettings, onNavigate }: { i: SetupItem; onSettings: () => void; onNavigate: (s: AppSection) => void }) {
  const act = () => { if (i.action.kind === 'settings') onSettings(); else if (i.action.kind === 'section') onNavigate(i.action.section); };
  return (
    <li className={`${CHECKLIST_ROW_GRID} py-3`}>
      {i.done
        ? <CheckCircle2 className="w-5 h-5 text-emerald-600" aria-hidden="true" />
        : <Circle className="w-5 h-5 text-slate-300" aria-hidden="true" />}
      <div className="min-w-0">
        <p className={`text-sm font-semibold break-words ${i.done ? 'text-slate-500' : 'text-slate-900'}`}>{i.label}<span className="sr-only">{i.done ? ' — complete' : ' — not complete'}</span></p>
        <p className="text-sm text-slate-500 mt-0.5 break-words">{i.detail}</p>
      </div>
      <div className={`col-start-2 md:col-start-3 ${i.count ? '' : 'hidden md:block'}`}>
        {i.count && <ProgressBlock label={<><b className="font-mono">{i.count.done}/{i.count.total}</b> {i.count.unit}</>} done={i.count.done} total={i.count.total} tone={i.done ? 'emerald' : 'sky'} />}
      </div>
      <div className="col-start-2 md:col-start-4">
        {!i.done && (i.action.kind === 'href'
          ? <a href={i.action.href} className={CHECKLIST_ACTION}>{i.actionLabel}</a>
          : <button type="button" onClick={act} className={CHECKLIST_ACTION}>{i.actionLabel}</button>)}
      </div>
    </li>
  );
}

export const ATTENTION_LIMIT = 6;

const UNIT_LABEL: Record<AttentionItem['unit'], [string, string]> = { payment: ['payment', 'payments'], material: ['material', 'materials'], task: ['task', 'tasks'], visit: ['visit', 'visits'] };

/** Issue groups with the number of records each one covers; "Showing X of Y" when only part of the list is visible. Content-sized. */
export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, ATTENTION_LIMIT);
  return (
    <Section id="at-title" title="Needs attention" icon={<CircleAlert className="w-4 h-4 text-amber-600" />} meta={items.length ? attentionSummary(items) : undefined}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-600"><CheckCircle2 className="w-4 h-4 text-emerald-600" />Nothing overdue, blocked or waiting on a decision.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100" data-testid="attention-list">
            {shown.map((i) => (
              <li key={i.key} className="py-3 first:pt-0">
                <div className="flex items-start gap-2.5">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${i.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-400'}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-500">
                      <span className={i.severity === 'critical' ? 'text-rose-700' : 'text-amber-800'}>{i.severity === 'critical' ? 'Critical' : 'Warning'}</span> · {i.tag}
                    </p>
                    <p className="text-sm font-semibold text-slate-900 break-words mt-0.5">
                      {i.title}
                      {i.count > 1 && <span className="ml-2 align-middle text-xs font-semibold text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">{i.count} {UNIT_LABEL[i.unit][1]}</span>}
                    </p>
                    <p className="text-sm text-slate-600 mt-0.5 break-words">{i.detail}{i.who ? <span className="text-slate-500"> · {i.who}</span> : null}</p>
                    <a href={i.href} className="mt-1.5 inline-flex min-h-9 items-center text-sm font-semibold text-sky-700 hover:text-sky-900 no-underline">{i.actionLabel} →</a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {items.length > ATTENTION_LIMIT && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
              <span className="text-sm text-slate-500">Showing {shown.length} of {items.length}</span>
              <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="text-sm font-semibold text-sky-700 hover:text-sky-900 min-h-9 px-2 rounded">
                {all ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
