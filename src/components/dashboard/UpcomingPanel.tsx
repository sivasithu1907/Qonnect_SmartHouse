import React, { useState } from 'react';
import { CalendarDays, ClipboardCheck, Hammer, MapPin, Search, Truck } from 'lucide-react';
import { formatDate } from '../../lib/format';
import { UPCOMING_TABS, upcomingMatches, upcomingWindowEnd, type UpcomingItem, type UpcomingTab } from '../../lib/dashboard';
import { Card, inputCls, StatusBadge } from '../ui';

const KIND: Record<UpcomingItem['kind'], { label: string; Icon: React.FC<{ className?: string }> }> = {
  material: { label: 'Material delivery', Icon: Truck },
  task: { label: 'Task', Icon: Hammer },
  consultant_visit: { label: 'Consultant visit', Icon: ClipboardCheck },
  site_visit: { label: 'Site visit', Icon: MapPin },
};
const TAB_LABEL: Record<UpcomingTab, string> = { all: 'All', materials: 'Materials', tasks: 'Tasks', visits: 'Visits & Inspections' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (iso: string) => DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];

/** Deliveries, tasks and visits dated today through today + 13 (application time zone). Overdue items live in Needs attention. */
export function UpcomingPanel({ projectId, items, today, days, can }: { projectId: string; items: UpcomingItem[]; today: string; days: number; can: (c: string) => boolean }) {
  const [tab, setTab] = useState<UpcomingTab>('all');
  const [q, setQ] = useState('');
  const shown = items.filter((i) => upcomingMatches(i, tab, q));
  const viewAll: Record<UpcomingTab, [string, string] | null> = {
    all: can('timeline.read') ? ['View full timeline', `#/timeline/${projectId}`] : null,
    materials: can('materials.read') ? ['Open Material Supply', `#/materials/${projectId}`] : null,
    tasks: can('timeline.read') ? ['Open Timeline', `#/timeline/${projectId}`] : null,
    visits: can('consultant.read') ? ['Open Consultant Visits', `#/consultant/${projectId}`] : can('site.read') ? ['Open Site Visits', `#/site/${projectId}`] : null,
  };
  const link = viewAll[tab];
  let lastDate = '';
  return (
    <Card title={<span className="flex items-center gap-2"><CalendarDays className="w-4 h-4 text-sky-600" />Next 14 days</span>}
      subtitle={`${formatDate(today)} – ${formatDate(upcomingWindowEnd(today, days))} · overdue items are listed under Needs attention`}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div role="tablist" aria-label="Activity type" className="flex flex-wrap gap-1 bg-slate-100 border border-slate-200 rounded-xl p-1">
          {UPCOMING_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold min-h-9 ${tab === t ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'}`}>
              {TAB_LABEL[t]}<span className="ml-1.5 font-mono text-[11px] text-slate-500">{items.filter((i) => upcomingMatches(i, t, '')).length}</span>
            </button>
          ))}
        </div>
        <label className="relative flex-1 min-w-[180px] max-w-xs">
          <span className="sr-only">Search upcoming activity</span>
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, party, status" className={`${inputCls} pl-8`} />
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="text-center py-8 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/60">
          <p className="text-sm font-semibold text-slate-700">{items.length === 0 ? 'Nothing scheduled in the next 14 days' : 'No activity matches'}</p>
          <p className="text-xs text-slate-500 mt-1">{items.length === 0 ? 'Deliveries, tasks and visits with dates in this period appear here.' : 'Try another tab or clear the search.'}</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="upcoming-list">
          {shown.map((i) => {
            const first = i.date !== lastDate;
            lastDate = i.date;
            const k = KIND[i.kind];
            return (
              <li key={i.key} className="grid grid-cols-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 py-3 items-start">
                <div className={`text-xs ${first ? '' : 'sm:invisible'}`}>
                  <span className="block text-sm font-bold text-slate-900">{formatDate(i.date)}</span>
                  <span className="text-slate-500">{dow(i.date)}{i.date === today ? ' · today' : ''}</span>
                </div>
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600"><k.Icon className="w-3.5 h-3.5 text-sky-600" />{k.label}{i.context ? <span className="font-semibold text-slate-500">· {i.context}</span> : null}</span>
                  <p className="text-sm font-semibold text-slate-900 break-words" title={i.title}>{i.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 break-words">{i.dateLabel}{i.who ? ` · ${i.who}` : ''}</p>
                </div>
                <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2">
                  <StatusBadge status={i.status} />
                  <a href={i.href} aria-label={`Open record: ${i.title}`} className="inline-flex min-h-9 items-center px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-sky-700 hover:bg-sky-50 no-underline">Open record</a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <span className="text-xs text-slate-500">{shown.length} of {items.length} shown, earliest first</span>
        {link && <a href={link[1]} className="text-xs font-semibold text-sky-700 hover:text-sky-900 no-underline">{link[0]} →</a>}
      </div>
    </Card>
  );
}
