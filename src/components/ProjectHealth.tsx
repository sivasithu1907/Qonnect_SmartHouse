import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CircleAlert } from 'lucide-react';
import type { AttentionItem, SetupItem } from '../lib/projectHealth';
import type { Section } from '../lib/types';
import { Badge, Card } from './ui';

/** One setup step; completion comes only from saved data. */
export function SetupRow({ i, onSettings, onNavigate }: { i: SetupItem; onSettings: () => void; onNavigate: (s: Section) => void }) {
  const act = () => { if (i.action.kind === 'settings') onSettings(); else if (i.action.kind === 'section') onNavigate(i.action.section); };
  return (
    <li className="flex items-start gap-3 py-3">
      {i.done
        ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" aria-hidden="true" />
        : <Circle className="w-5 h-5 text-slate-300 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${i.done ? 'text-slate-500' : 'text-slate-900'}`}>
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

export const ATTENTION_LIMIT = 6;

/** Actionable items with severity spelled out; "Showing X of Y" when only part of the list is visible. */
export function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, ATTENTION_LIMIT);
  const critical = items.filter((i) => i.severity === 'critical').length;
  return (
    <Card title={<span className="flex items-center gap-2"><CircleAlert className="w-4 h-4 text-amber-600" />Needs attention</span>}
      actions={items.length > 0 && <>{critical > 0 && <Badge tone="rose">{critical} critical</Badge>}{items.length - critical > 0 && <Badge tone="amber">{items.length - critical} warning</Badge>}</>}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-600"><CheckCircle2 className="w-4 h-4 text-emerald-600" />Nothing overdue, blocked or waiting on a decision right now.</p>
      ) : (
        <>
          <ul className="space-y-2.5" data-testid="attention-list">
            {shown.map((i) => (
              <li key={i.key} className={`rounded-lg border border-slate-200 border-l-4 bg-white p-3 ${i.severity === 'critical' ? 'border-l-rose-500' : 'border-l-amber-400'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.severity === 'critical' ? 'rose' : 'amber'}>
                    {i.severity === 'critical' ? <AlertTriangle className="w-3 h-3" aria-hidden="true" /> : null}{i.severity === 'critical' ? 'Critical' : 'Warning'}
                  </Badge>
                  <span className="text-xs font-bold text-slate-700">{i.tag}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-900 break-words">{i.title}</p>
                <p className="text-xs text-slate-600 mt-0.5 break-words">{i.detail}{i.who ? <span className="text-slate-500"> · {i.who}</span> : null}</p>
                <a href={i.href} className="mt-2 inline-flex min-h-9 items-center px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 no-underline">{i.actionLabel}</a>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
            <span className="text-xs text-slate-500">Showing {shown.length} of {items.length}</span>
            {items.length > ATTENTION_LIMIT && (
              <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="text-xs font-semibold text-sky-700 hover:text-sky-900 min-h-9 px-2 rounded">
                {all ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
