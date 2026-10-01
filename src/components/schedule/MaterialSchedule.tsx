import React, { useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Package } from 'lucide-react';
import type { MaterialCategory, MaterialItem } from '../../lib/types';
import { formatDate } from '../../lib/format';
import { SUPPLY_RESPONSIBILITY_LABELS } from '../../../shared/constants';
import { buildMaterialSchedule, entriesInPeriod, periodFor, shiftPeriod, dowLabel, type MaterialEntry, type PeriodMode } from '../../lib/schedule';
import { Badge, Button, EmptyState, NeedsConfirmation, StatusBadge, Tabs } from '../ui';
import { Mark, MarkLegend } from './ScheduleMarks';

interface Props {
  /** Already filtered by the page (category / status / responsibility / assigned / archived). */
  items: MaterialItem[];
  /** Category order to group by. */
  categories: MaterialCategory[];
  today: string;
  onOpen: (m: MaterialItem) => void;
  initialMode?: PeriodMode;
  initialAnchor?: string;
}

function Responsibility({ m }: { m: MaterialItem }) {
  return m.supply_responsibility === 'needs_confirmation'
    ? <NeedsConfirmation label="Responsibility: needs confirmation" />
    : <Badge tone={m.supply_responsibility === 'owner' ? 'sky' : 'indigo'}>{SUPPLY_RESPONSIBILITY_LABELS[m.supply_responsibility]}</Badge>;
}

/** Read-only schedule of material lines. Opening an entry uses the page's existing edit / detail dialog. */
export function MaterialSchedule({ items, categories, today, onOpen, initialMode = 'week', initialAnchor }: Props) {
  const [mode, setMode] = useState<PeriodMode>(initialMode);
  const [anchor, setAnchor] = useState(initialAnchor ?? today);
  const period = useMemo(() => periodFor(mode, anchor), [mode, anchor]);
  const { scheduled, unscheduled } = useMemo(() => buildMaterialSchedule(items, today), [items, today]);
  const win = useMemo(() => entriesInPeriod(scheduled, period.start, period.end), [scheduled, period]);

  const byCategory = (list: { item: MaterialItem }[]) =>
    categories.map((c) => ({ c, rows: list.filter((e) => e.item.category_id === c.id) })).filter((g) => g.rows.length);
  const groups = byCategory(win.visible);
  const unschedGroups = categories.map((c) => ({ c, rows: unscheduled.filter((m) => m.category_id === c.id) })).filter((g) => g.rows.length);

  const week = mode === 'week';
  const cols = `minmax(150px, 260px) repeat(${period.days.length}, minmax(${week ? 76 : 26}px, 1fr))`;
  const minWidth = 200 + period.days.length * (week ? 76 : 26);

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={mode} onChange={setMode} tabs={[{ id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} />
        <div className="flex items-center gap-1">
          <Button size="sm" aria-label={`Previous ${mode}`} onClick={() => setAnchor(shiftPeriod(mode, anchor, -1))}><ChevronLeft className="w-4 h-4" /></Button>
          <Button size="sm" onClick={() => setAnchor(today)}>Today</Button>
          <Button size="sm" aria-label={`Next ${mode}`} onClick={() => setAnchor(shiftPeriod(mode, anchor, 1))}><ChevronRight className="w-4 h-4" /></Button>
        </div>
        <div className="text-sm font-bold text-slate-900" data-testid="period-label">{period.label}</div>
        <div className="w-full lg:w-auto lg:ml-auto"><MarkLegend /></div>
      </div>

      {scheduled.length === 0 ? (
        <EmptyState title="No material dates entered yet">
          Lines appear here once a required-on-site, planned, supplier-confirmed, revised or actual delivery date is entered on the material line.
        </EmptyState>
      ) : (
        <>
          {groups.length === 0 ? (
            <EmptyState title={`Nothing scheduled in this ${mode}`}>
              {win.before + win.after} dated line(s) fall outside this {mode}.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0 border-y sm:border border-slate-200 sm:rounded-xl">
              <div className="grid text-xs" style={{ gridTemplateColumns: cols, minWidth }} role="grid" aria-label={`Material schedule, ${period.label}`}>
                {/* header */}
                <div className="sticky left-0 z-20 bg-slate-50 border-b border-r border-slate-200 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Material line</div>
                {period.days.map((d) => (
                  <div key={d} className={`border-b border-slate-200 px-1 py-1.5 text-center ${d === today ? 'bg-sky-50 text-sky-800 font-bold' : 'bg-slate-50 text-slate-500'}`}>
                    {week ? <><div className="text-[10px] uppercase">{dowLabel(d)}</div><div className="text-xs font-semibold">{formatDate(d).slice(0, 5)}</div></>
                      : <><div className="text-[9px] uppercase">{dowLabel(d).slice(0, 2)}</div><div className="text-[11px] font-semibold">{Number(d.slice(8))}</div></>}
                  </div>
                ))}
                {groups.map(({ c, rows }) => (
                  <React.Fragment key={c.id}>
                    <div className="sticky left-0 z-10 bg-white border-b border-r border-slate-100 px-3 pt-3 pb-1 text-[12px] font-bold text-slate-900 flex items-center gap-1.5">
                      <Package className="w-3.5 h-3.5 text-sky-600" />{c.name}<span className="font-normal text-slate-400">({rows.length})</span>
                    </div>
                    <div className="border-b border-slate-100 bg-white" style={{ gridColumn: `span ${period.days.length}` }} />
                    {rows.map((e) => <EntryRow key={e.item.id} e={e as MaterialEntry} days={period.days} today={today} week={week} onOpen={onOpen} />)}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          {(win.before > 0 || win.after > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <CalendarClock className="w-3.5 h-3.5" />
              <span>Outside this {mode}: {win.before} earlier · {win.after} later.</span>
              {win.prevDate && <Button size="sm" variant="ghost" onClick={() => setAnchor(win.prevDate!)}><ChevronLeft className="w-3.5 h-3.5" />Previous dated</Button>}
              {win.nextDate && <Button size="sm" variant="ghost" onClick={() => setAnchor(win.nextDate!)}>Next dated<ChevronRight className="w-3.5 h-3.5" /></Button>}
            </div>
          )}
        </>
      )}

      {/* lines without any usable date — never auto-filled */}
      <section aria-labelledby="mat-unscheduled" className="border border-dashed border-slate-300 rounded-xl p-3 bg-slate-50/50">
        <h3 id="mat-unscheduled" className="text-sm font-bold text-slate-900">Not scheduled <span className="font-normal text-slate-500">({unscheduled.length})</span></h3>
        <p className="text-[11px] text-slate-500 mb-2">No required-on-site, planned, confirmed, revised or actual delivery date has been entered. Open a line to add dates.</p>
        {unscheduled.length === 0 ? <p className="text-xs text-slate-400">Every line shown has at least one date.</p> : (
          <div className="space-y-2">
            {unschedGroups.map(({ c, rows }) => (
              <div key={c.id}>
                <div className="text-[11px] font-bold text-slate-600 mb-1">{c.name}</div>
                <ul className="flex flex-wrap gap-1.5">
                  {rows.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => onOpen(m)} className="text-left bg-white border border-slate-200 hover:border-sky-300 rounded-lg px-2 py-1 text-[11px] text-slate-700">
                        <span className="font-semibold text-slate-800">{m.description}</span>
                        <span className="text-slate-400"> · {m.status} · {SUPPLY_RESPONSIBILITY_LABELS[m.supply_responsibility]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EntryRow({ e, days, today, week, onOpen }: { e: MaterialEntry; days: string[]; today: string; week: boolean; onOpen: (m: MaterialItem) => void }) {
  const m = e.item;
  return (
    <>
      <div className="sticky left-0 z-10 bg-white border-b border-r border-slate-100 px-3 py-1.5 min-w-0">
        <button type="button" onClick={() => onOpen(m)} className="text-left w-full min-w-0 group" title={m.description}>
          <div className="font-semibold text-slate-800 group-hover:text-sky-700 truncate">{m.description}</div>
        </button>
        <div className="flex flex-wrap items-center gap-1 mt-0.5"><StatusBadge status={m.status} /><Responsibility m={m} />{e.overdue && <Badge tone="rose">Overdue</Badge>}{m.archived_at && <Badge tone="rose">Archived</Badge>}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
          {e.expected ? <>Expected {formatDate(e.expected.date)} · <span className={e.expected.kind === 'required' ? 'text-amber-700 font-semibold' : 'font-semibold'}>{e.expected.label}</span></> : <>No expected date</>}
          {e.actual && <> · <span className="text-emerald-700 font-semibold">Actual {formatDate(e.actual)}</span></>}
        </div>
      </div>
      {days.map((d) => {
        const marks = e.marks.filter((k) => k.date === d);
        return (
          <div key={d} className={`border-b border-slate-100 px-0.5 py-1 flex flex-col items-center justify-center gap-0.5 ${d === today ? 'bg-sky-50/60' : ''}`}>
            {marks.map((k) => {
              const title = `${m.description} — ${k.label} ${formatDate(k.date)}`;
              return (
                <button key={k.role} type="button" onClick={() => onOpen(m)} title={title} aria-label={title}
                  className="inline-flex items-center gap-1 rounded hover:bg-slate-100 px-0.5 max-w-full">
                  <Mark kind={k.kind} size={week ? 12 : 10} overdue={k.role === 'expected' && e.overdue} />
                  {week && <span className={`text-[10px] truncate ${k.kind === 'actual' ? 'text-emerald-700' : k.kind === 'required' ? 'text-amber-700' : 'text-slate-600'}`}>{shortKind(k.kind)}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

const shortKind = (k: string) => ({ revised: 'Revised', confirmed: 'Confirmed', planned: 'Planned', required: 'Required', actual: 'Delivered' } as Record<string, string>)[k] ?? k;
