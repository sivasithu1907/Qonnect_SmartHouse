import React, { useState } from 'react';
import { CalendarDays, ClipboardCheck, Hammer, MapPin, PackageCheck, Search, Truck } from 'lucide-react';
import { formatDate } from '../../lib/format';
import { groupByDate, UPCOMING_TABS, upcomingDateLine, upcomingMatches, upcomingWindowEnd, type UpcomingItem, type UpcomingTab } from '../../lib/dashboard';
import { inputCls, StatusBadge } from '../ui';
import { Section } from './Section';

const TAB_LABEL: Record<UpcomingTab, string> = { all: 'All', materials: 'Materials', tasks: 'Tasks', visits: 'Visits & inspections' };

function kindOf(i: UpcomingItem): { label: string; Icon: React.FC<{ className?: string }> } {
  if (i.kind === 'material') return i.dateKind === 'required' ? { label: 'Material needed on site', Icon: PackageCheck } : { label: 'Material delivery', Icon: Truck };
  if (i.kind === 'task') return { label: 'Task', Icon: Hammer };
  if (i.kind === 'consultant_visit') return { label: 'Consultant visit', Icon: ClipboardCheck };
  return { label: 'Site visit', Icon: MapPin };
}

/** Deliveries, tasks and visits dated today through today + 13 (application time zone), grouped by date. Overdue items live in Needs attention. */
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
  return (
    <Section id="up-title" title="Next 14 days" icon={<CalendarDays className="w-4 h-4 text-sky-600" />}
      meta={`${formatDate(today)} – ${formatDate(upcomingWindowEnd(today, days))}`}
      actions={link && <a href={link[1]} className="text-sm font-semibold text-sky-700 hover:text-sky-900 no-underline">{link[0]} →</a>}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Activity type" className="flex flex-wrap gap-1 bg-slate-100 border border-slate-200 rounded-xl p-1">
          {UPCOMING_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold min-h-9 ${tab === t ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'}`}>
              {TAB_LABEL[t]}<span className="ml-1.5 font-mono text-xs text-slate-500">{items.filter((i) => upcomingMatches(i, t, '')).length}</span>
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
        <p className="mt-4 text-sm text-slate-500">{items.length === 0 ? 'Nothing is dated in the next 14 days. Overdue items appear under Needs attention.' : 'No activity matches. Try another tab or clear the search.'}</p>
      ) : (
        <div className="mt-3" data-testid="upcoming-list">
          {groupByDate(shown).map((g) => (
            <section key={g.date} aria-label={g.heading} className="mt-2 first:mt-0">
              <h3 className="py-1.5 text-sm font-semibold text-slate-700 border-b border-slate-100">
                {g.heading}{g.date === today && <span className="ml-2 text-xs font-semibold text-sky-700">Today</span>}
              </h3>
              <ul className="divide-y divide-slate-100">
                {g.items.map((i) => {
                  const k = kindOf(i);
                  const line = upcomingDateLine(i);
                  const meta = (i.kind === 'task' ? ['Task', line.label, i.context, i.who] : [line.label, i.context, i.who]).filter(Boolean);
                  return (
                    <li key={i.key} className="grid grid-cols-[2rem_minmax(0,1fr)] sm:grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3 items-start">
                      <span className="w-8 h-8 rounded-lg bg-sky-50 text-sky-700 grid place-items-center" title={k.label}><k.Icon className="w-4 h-4" /><span className="sr-only">{k.label}</span></span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 break-words" title={i.title}>{i.title}</p>
                        <p className="text-xs text-slate-500 mt-0.5 break-words">
                          {meta.join(' · ')}
                          {line.delivery && <span className="text-amber-800"> · {line.delivery}</span>}
                          {i.kind === 'material' && i.requiredOnSite && i.dateKind !== 'required' && <span> · needed on site {formatDate(i.requiredOnSite)}</span>}
                        </p>
                      </div>
                      <div className="col-start-2 sm:col-start-3 flex items-center gap-2 sm:justify-end">
                        <StatusBadge status={i.status} />
                        <a href={i.href} aria-label={`Open: ${i.title}`} className="inline-flex min-h-9 items-center px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-sky-700 hover:bg-sky-50 no-underline">Open</a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Section>
  );
}
