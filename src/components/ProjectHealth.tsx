import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, ListChecks, CircleAlert } from 'lucide-react';
import type { AttentionItem, SetupItem } from '../lib/projectHealth';
import type { Section } from '../lib/types';
import { Card } from './ui';

/** Compact setup checklist; completion comes only from saved data. */
export function SetupChecklist({ items, onSettings, onNavigate }: { items: SetupItem[]; onSettings: () => void; onNavigate: (s: Section) => void }) {
  const done = items.filter((i) => i.done).length;
  const [showDone, setShowDone] = useState(false);
  if (!items.length || done === items.length) return null;
  const open = items.filter((i) => !i.done);
  const finished = items.filter((i) => i.done);
  const pct = Math.round((done / items.length) * 100);
  return (
    <Card title={<span className="flex items-center gap-2"><ListChecks className="w-4 h-4 text-sky-600" />Project setup</span>}
      subtitle={`${done} of ${items.length} steps complete — based on saved project data`}
      actions={<span className="text-xs font-semibold text-slate-600" aria-hidden="true">{pct}%</span>}>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3" role="progressbar" aria-label="Project setup progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}>
        <div className="h-full bg-sky-600" style={{ width: `${pct}%` }} />
      </div>
      <ul className="divide-y divide-slate-100">
        {open.map((i) => <SetupRow key={i.key} i={i} onSettings={onSettings} onNavigate={onNavigate} />)}
      </ul>
      {finished.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <button type="button" onClick={() => setShowDone(!showDone)} aria-expanded={showDone} className="flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded">
            {showDone ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}{finished.length} completed
          </button>
          {showDone && <ul className="divide-y divide-slate-100 mt-1">{finished.map((i) => <SetupRow key={i.key} i={i} onSettings={onSettings} onNavigate={onNavigate} />)}</ul>}
        </div>
      )}
    </Card>
  );
}

function SetupRow({ i, onSettings, onNavigate }: { i: SetupItem; onSettings: () => void; onNavigate: (s: Section) => void }) {
  const act = () => { if (i.action.kind === 'settings') onSettings(); else if (i.action.kind === 'section') onNavigate(i.action.section); };
  return (
    <li className="flex items-start gap-3 py-2.5">
      {i.done
        ? <CheckCircle2 className="w-[18px] h-[18px] text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
        : <Circle className="w-[18px] h-[18px] text-slate-300 shrink-0 mt-0.5" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">
          {i.label}<span className="sr-only">{i.done ? ' — complete' : ' — not complete'}</span>
          {i.progress && <span className="ml-2 text-xs font-medium text-slate-500">{i.progress}</span>}
        </div>
        <div className="text-xs text-slate-600 mt-0.5">{i.detail}</div>
      </div>
      {!i.done && (i.action.kind === 'href' ? (
        <a href={i.action.href} className="shrink-0 min-h-9 inline-flex items-center px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-sky-700 hover:bg-sky-50 no-underline">
          {i.actionLabel}
        </a>
      ) : (
        <button type="button" onClick={act} className="shrink-0 min-h-9 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-sky-700 hover:bg-sky-50">
          {i.actionLabel}
        </button>
      ))}
    </li>
  );
}

/** Short list of actionable items; each links to its page or record. */
export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  return (
    <Card title={<span className="flex items-center gap-2"><CircleAlert className="w-4 h-4 text-amber-600" />Needs attention</span>}
      subtitle={items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : undefined}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-600"><CheckCircle2 className="w-4 h-4 text-emerald-600" />Nothing overdue or waiting on a decision right now.</p>
      ) : (
        <ul className="divide-y divide-slate-100 -my-1">
          {items.map((i) => (
            <li key={i.key}>
              <a href={i.href} className="group flex items-start gap-3 py-2.5 rounded-lg no-underline hover:bg-slate-50 -mx-2 px-2">
                {i.tone === 'overdue'
                  ? <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
                  : <CircleAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={`text-[11px] font-bold uppercase tracking-wide ${i.tone === 'overdue' ? 'text-rose-700' : 'text-amber-800'}`}>{i.tag}</span>
                    <span className="text-sm font-semibold text-slate-900 group-hover:text-sky-700 break-words">{i.title}</span>
                  </span>
                  <span className="block text-xs text-slate-600 mt-0.5">{i.detail}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
