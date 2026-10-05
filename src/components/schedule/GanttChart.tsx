import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Link2, Package, ShieldCheck } from 'lucide-react';
import type { MaterialCategory, MaterialItem, Phase, Task } from '../../lib/types';
import { formatDate } from '../../lib/format';
import { buildGantt, buildMaterialSchedule, dayNum, ganttRange, isoOf, spanDates, monthLabel, weekday, WEEK_START, type TaskSpan, type MaterialEntry } from '../../lib/schedule';
import { Button, StatusBadge, Tabs } from '../ui';
import { CompactEmpty, Mark, MarkLegend } from './ScheduleMarks';
import { UnscheduledPanel, type UnscheduledGroup } from './UnscheduledPanel';

type Zoom = 'week' | 'month';
const PX_PER_DAY: Record<Zoom, number> = { week: 28, month: 6 };
const ROW = 34;
const HEADER = 44;

interface Props {
  phases: Phase[];
  tasks: Task[];
  materials: MaterialItem[];
  materialCategories?: MaterialCategory[];
  today: string;
  onOpenPhase: (p: Phase) => void;
  onOpenTask: (t: Task) => void;
  /** one or several material lines (several share a date in the same category) */
  onOpenMaterials: (items: MaterialItem[]) => void;
  initialZoom?: Zoom;
  initialIncludeMaterials?: boolean;
}

const BAR: Record<string, string> = {
  Completed: 'bg-emerald-500 border-emerald-600 text-white',
  'In Progress': 'bg-sky-500 border-sky-600 text-white',
  Scheduled: 'bg-indigo-100 border-indigo-300 text-indigo-800',
  'On Hold': 'bg-amber-100 border-amber-400 text-amber-900',
  Blocked: 'bg-rose-100 border-rose-400 text-rose-800',
  'Not Scheduled': 'bg-slate-100 border-slate-300 text-slate-600',
};
const barCls = (status: string) => BAR[status] ?? BAR['Not Scheduled'];

type Row =
  | { type: 'phase'; key: string; phase: Phase; span: TaskSpan; done: number; total: number; summary: { start: string; end: string } | null; taskCount: number }
  | { type: 'task'; key: string; task: Task; span: TaskSpan }
  | { type: 'mat-head'; key: string; count: number }
  | { type: 'mat-cat'; key: string; name: string; entries: MaterialEntry[] };

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** Read-only Gantt. No dragging: dates change only through the existing edit forms. */
export function GanttChart({ phases, tasks, materials, materialCategories, today, onOpenPhase, onOpenTask, onOpenMaterials, initialZoom = 'week', initialIncludeMaterials = false }: Props) {
  const [zoom, setZoom] = useState<Zoom>(initialZoom);
  const [withMaterials, setWithMaterials] = useState(initialIncludeMaterials);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hideEmpty, setHideEmpty] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const LABEL = narrow ? 156 : 280;
  const ppd = PX_PER_DAY[zoom];

  const model = useMemo(() => buildGantt(phases, tasks), [phases, tasks]);
  const mat = useMemo(() => buildMaterialSchedule(materials.filter((m) => !m.archived_at), today), [materials, today]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of model.phases) {
      if (hideEmpty && p.tasks.length === 0 && p.span.kind === 'none') continue;
      const dates = p.tasks.flatMap((t) => spanDates(t.span));
      const summary = p.span.kind === 'none' && dates.length ? { start: dates.reduce((a, b) => (a < b ? a : b)), end: dates.reduce((a, b) => (a > b ? a : b)) } : null;
      out.push({ type: 'phase', key: `p-${p.phase.id}`, phase: p.phase, span: p.span, done: p.done, total: p.total, summary, taskCount: p.tasks.length });
      if (!collapsed[p.phase.id]) for (const t of p.tasks) out.push({ type: 'task', key: `t-${t.task.id}`, task: t.task, span: t.span });
    }
    if (withMaterials && mat.scheduled.length) {
      out.push({ type: 'mat-head', key: 'mat-head', count: mat.scheduled.length });
      if (!collapsed.__materials) {
        const order = new Map((materialCategories ?? []).map((c, i) => [c.id, i]));
        const cats = new Map<string, { name: string; sort: number; entries: MaterialEntry[] }>();
        for (const e of mat.scheduled) {
          const g = cats.get(e.item.category_id) ?? { name: e.item.category, sort: order.get(e.item.category_id) ?? e.item.category_sort ?? 1e9, entries: [] };
          g.entries.push(e);
          cats.set(e.item.category_id, g);
        }
        [...cats.entries()].sort((a, b) => a[1].sort - b[1].sort || a[1].name.localeCompare(b[1].name))
          .forEach(([id, g]) => out.push({ type: 'mat-cat', key: `m-${id}`, name: g.name, entries: g.entries }));
      }
    }
    return out;
  }, [model, collapsed, withMaterials, mat, materialCategories, hideEmpty]);

  const allDates = useMemo(() => [
    ...model.phases.flatMap((p) => [...spanDates(p.span), ...p.tasks.flatMap((t) => spanDates(t.span))]),
    ...(withMaterials ? mat.scheduled.flatMap((e) => [e.expected?.date, e.actual].filter(Boolean) as string[]) : []),
  ], [model, withMaterials, mat]);
  const range = useMemo(() => ganttRange(allDates, today), [allDates, today]);
  const x = (iso: string) => (dayNum(iso) - dayNum(range.start)) * ppd;
  const width = range.days * ppd;
  const height = rows.length * ROW;

  // scroll today into view on first render and when the zoom changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - LABEL) / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, range.start]);
  const scrollBy = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * (zoom === 'week' ? 7 : 30) * ppd, behavior: 'smooth' });
  const scrollToday = () => { const el = scroller.current; if (el) el.scrollTo({ left: Math.max(0, x(today) - (el.clientWidth - LABEL) / 3), behavior: 'smooth' }); };

  // header ticks
  const months: Array<{ iso: string; left: number; w: number }> = [];
  const ticks: Array<{ iso: string; left: number; label: string; major: boolean }> = [];
  for (let d = dayNum(range.start); d <= dayNum(range.end); d++) {
    const iso = isoOf(d);
    if (iso.endsWith('-01')) months.push({ iso, left: x(iso), w: 0 });
    if (zoom === 'week') ticks.push({ iso, left: x(iso), label: String(Number(iso.slice(8))), major: weekday(iso) === WEEK_START });
    else if (weekday(iso) === WEEK_START) ticks.push({ iso, left: x(iso), label: String(Number(iso.slice(8))), major: true });
  }
  months.forEach((m, i) => { m.w = (i + 1 < months.length ? months[i + 1].left : width) - m.left; });

  // dependency links between rendered, dated tasks
  const rowIndex = new Map<string, number>();
  rows.forEach((r, i) => { if (r.type === 'task') rowIndex.set(r.task.id, i); });
  const endX = (s: TaskSpan) => (s.kind === 'range' ? x(s.end) + ppd : s.kind === 'end-only' ? x(s.end) + ppd / 2 : s.kind === 'start-only' ? x(s.start) + ppd / 2 : s.kind === 'invalid' ? x(s.start) + ppd / 2 : 0);
  const startX = (s: TaskSpan) => (s.kind === 'range' ? x(s.start) : s.kind === 'start-only' ? x(s.start) + ppd / 2 - 6 : s.kind === 'end-only' ? x(s.end) + ppd / 2 - 6 : s.kind === 'invalid' ? x(s.end) : 0);
  const links: Array<{ d: string; late: boolean; key: string }> = [];
  for (const r of rows) {
    if (r.type !== 'task') continue;
    for (const pid of r.task.depends_on) {
      const pi = rowIndex.get(pid);
      if (pi === undefined) continue;
      const pr = rows[pi] as Extract<Row, { type: 'task' }>;
      const x1 = endX(pr.span); const y1 = pi * ROW + ROW / 2;
      const x2 = startX(r.span); const y2 = rowIndex.get(r.task.id)! * ROW + ROW / 2;
      const d = x2 >= x1 + 12
        ? `M${x1},${y1} H${x1 + 6} V${y2} H${x2 - 2}`
        : `M${x1},${y1} h6 V${(y1 + y2) / 2} H${x2 - 10} V${y2} H${x2 - 2}`;
      links.push({ d, late: x2 < x1, key: `${pid}-${r.task.id}` });
    }
  }

  const noDates = allDates.length === 0;
  const unschedGroups = useMemo<UnscheduledGroup[]>(() => model.unscheduled.map(({ phase, tasks: list }) => ({
    key: phase.id,
    label: <><span className="font-mono text-sky-700 mr-1">{phase.seq}.</span>{phase.name}</>,
    searchLabel: `${phase.seq}. ${phase.name}`,
    items: list.map((t) => ({
      id: t.id,
      name: t.name,
      searchText: `${t.status} ${t.assigned_user_name ?? ''} ${t.responsible}`,
      meta: <><StatusBadge status={t.status} />{t.is_hold_point && <span className="inline-flex items-center gap-0.5 text-[10px] text-violet-700"><ShieldCheck className="w-3 h-3" />Hold point</span>}{(t.assigned_user_name || t.responsible) && <span className="text-[11px] text-slate-500">{t.assigned_user_name ?? t.responsible}</span>}</>,
      onOpen: () => onOpenTask(t),
    })),
  })), [model, onOpenTask]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={zoom} onChange={setZoom} tabs={[{ id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} />
        <div className="flex items-center gap-1">
          <Button size="sm" aria-label="Scroll earlier" disabled={noDates} onClick={() => scrollBy(-1)}><ChevronLeft className="w-4 h-4" /></Button>
          <Button size="sm" disabled={noDates} onClick={scrollToday}>Today</Button>
          <Button size="sm" aria-label="Scroll later" disabled={noDates} onClick={() => scrollBy(1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" checked={withMaterials} onChange={(e) => setWithMaterials(e.target.checked)} />Include materials &amp; contractor work
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-700" title="Hides chart rows for phases that have no phase dates and no dated tasks. Their tasks stay listed under Not scheduled.">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />Hide phases without dates
          <span className="text-[10px] text-slate-400 hidden sm:inline">(chart rows only)</span>
        </label>
        <div className="basis-full 2xl:basis-auto 2xl:ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
          {(['Not Scheduled', 'Scheduled', 'In Progress', 'On Hold', 'Blocked', 'Completed'] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1"><span className={`inline-block w-4 h-2.5 rounded-sm border ${barCls(s)}`} />{s}</span>
          ))}
          <span className="inline-flex items-center gap-1"><Link2 className="w-3 h-3" />Dependency</span>
        </div>
      </div>
      {withMaterials && <MarkLegend only={['planned', 'actual', 'planned_work', 'actual_work', ...(mat.scheduled.some((e) => e.review) ? ['legacy' as const] : [])]} />}

      {noDates ? (
        <CompactEmpty title="No planned dates entered yet">
          tasks appear here once a planned start or finish is entered in the task's edit form. Nothing is scheduled automatically.
        </CompactEmpty>
      ) : (
        <div ref={scroller} className="overflow-x-auto -mx-4 sm:mx-0 border-y sm:border border-slate-200 sm:rounded-xl bg-white" data-testid="gantt-scroller">
          <div className="relative" style={{ width: LABEL + width, minHeight: HEADER + height }}>
            {/* header */}
            <div className="flex sticky top-0 z-30" style={{ height: HEADER }}>
              <div className="sticky left-0 z-40 bg-slate-50 border-b border-r border-slate-200 px-3 flex items-end pb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500" style={{ width: LABEL, minWidth: LABEL }}>Phase / task</div>
              <div className="relative bg-slate-50 border-b border-slate-200" style={{ width }}>
                {months.map((m) => (
                  <div key={m.iso} className="absolute top-0 h-5 border-l border-slate-300 px-1 text-[11px] font-bold text-slate-700 truncate" style={{ left: m.left, width: m.w }}>{monthLabel(m.iso)}</div>
                ))}
                {ticks.map((t) => (
                  <div key={t.iso} className={`absolute bottom-0 h-5 text-center text-[10px] ${t.iso === today ? 'text-rose-600 font-bold' : t.major ? 'text-slate-600' : 'text-slate-400'}`}
                    style={{ left: t.left, width: zoom === 'week' ? ppd : 7 * ppd }}>{t.label}</div>
                ))}
              </div>
            </div>

            {/* grid lines + today */}
            <div className="absolute pointer-events-none" style={{ left: LABEL, top: HEADER, width, height }} aria-hidden>
              {ticks.filter((t) => t.major).map((t) => <div key={t.iso} className="absolute top-0 bottom-0 border-l border-slate-100" style={{ left: t.left }} />)}
              {months.map((m) => <div key={m.iso} className="absolute top-0 bottom-0 border-l border-slate-200" style={{ left: m.left }} />)}
              <div className="absolute top-0 bottom-0 border-l-2 border-rose-400" style={{ left: x(today) + ppd / 2 }} title={`Today ${formatDate(today)}`} data-testid="today-marker" />
            </div>

            {/* rows */}
            {rows.map((r) => (
              <div key={r.key} className={`flex ${r.type === 'phase' || r.type === 'mat-head' ? 'bg-slate-50/70' : ''}`} style={{ height: ROW }}>
                <div className={`sticky left-0 z-20 border-b border-r border-slate-100 flex items-center gap-1 min-w-0 ${r.type === 'phase' || r.type === 'mat-head' ? 'bg-slate-50' : 'bg-white'}`} style={{ width: LABEL, minWidth: LABEL }}>
                  <RowLabel r={r} narrow={narrow} collapsed={r.type === 'phase' ? !!collapsed[r.phase.id] : r.type === 'mat-head' ? !!collapsed.__materials : false}
                    onToggle={() => setCollapsed((c) => r.type === 'phase' ? { ...c, [r.phase.id]: !c[r.phase.id] } : { ...c, __materials: !c.__materials })}
                    onOpenPhase={onOpenPhase} onOpenTask={onOpenTask} />
                </div>
                <div className="relative border-b border-slate-100" style={{ width }}>
                  <RowBars r={r} x={x} ppd={ppd} zoom={zoom} today={today} taskById={taskById} onOpenPhase={onOpenPhase} onOpenTask={onOpenTask} onOpenMaterials={onOpenMaterials} />
                </div>
              </div>
            ))}

            {/* dependency links */}
            <svg className="absolute pointer-events-none z-10" style={{ left: LABEL, top: HEADER }} width={width} height={height} aria-hidden data-testid="gantt-links">
              <defs>
                <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" /></marker>
                <marker id="gantt-arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f59e0b" /></marker>
              </defs>
              {links.map((l) => <path key={l.key} d={l.d} fill="none" stroke={l.late ? '#f59e0b' : '#94a3b8'} strokeWidth={1.25} markerEnd={`url(#${l.late ? 'gantt-arrow-late' : 'gantt-arrow'})`} />)}
            </svg>
          </div>
        </div>
      )}
      {!noDates && links.some((l) => l.late) && (
        <p className="text-[11px] text-amber-700">Amber links: the task is planned to start before its predecessor's planned finish.</p>
      )}

      {/* tasks with neither planned date — never auto-scheduled */}
      <UnscheduledPanel groups={unschedGroups} noun={['task', 'tasks']} searchPlaceholder="Search unscheduled tasks"
        description="No planned start or finish yet. Open a task to enter its dates."
        emptyText="Every task has at least one planned date."
        footer={withMaterials && mat.unscheduled.length > 0
          ? <><Package className="w-3 h-3 inline -mt-0.5" /> {mat.unscheduled.length} material line(s) have no planned or actual date — see Material Supply › Schedule.</>
          : undefined} />
    </div>
  );
}

function RowLabel({ r, narrow, collapsed, onToggle, onOpenPhase, onOpenTask }: {
  r: Row; narrow: boolean; collapsed: boolean; onToggle: () => void; onOpenPhase: (p: Phase) => void; onOpenTask: (t: Task) => void;
}) {
  const chevron = (
    <button type="button" onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'} className="p-1 text-slate-500 hover:text-slate-800 shrink-0">
      {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
    </button>
  );
  if (r.type === 'phase') {
    return (
      <>
        {chevron}
        <button type="button" onClick={() => onOpenPhase(r.phase)} className="min-w-0 text-left pr-2" title={`${r.phase.seq}. ${r.phase.name}`}>
          <div className={`font-bold text-slate-900 ${narrow ? 'text-[11px] leading-tight line-clamp-2' : 'text-xs truncate'}`}><span className="font-mono text-sky-700 mr-1">{r.phase.seq}.</span>{r.phase.name}</div>
          {!narrow && <div className="text-[10px] text-slate-500 truncate">{r.done}/{r.total} completed{r.total > r.taskCount ? ` · ${r.total - r.taskCount} not scheduled` : ''}</div>}
        </button>
      </>
    );
  }
  if (r.type === 'task') {
    const t = r.task;
    return (
      <button type="button" onClick={() => onOpenTask(t)} className={`min-w-0 text-left pr-2 w-full ${narrow ? 'pl-3' : 'pl-6'}`} title={`${t.name}${t.assigned_user_name ? ` — ${t.assigned_user_name}` : ''}`}>
        <div className={`text-slate-800 flex items-center gap-1 ${narrow ? 'text-[11px] leading-tight' : 'text-xs'}`}>{t.is_hold_point && <ShieldCheck className="w-3 h-3 text-violet-600 shrink-0" />}<span className={narrow ? 'line-clamp-2' : 'truncate'}>{t.name}</span></div>
        {!narrow && <div className="text-[10px] text-slate-500 truncate">{t.status}{t.assigned_user_name ? ` · ${t.assigned_user_name}` : t.responsible ? ` · ${t.responsible}` : ''}</div>}
      </button>
    );
  }
  if (r.type === 'mat-head') {
    return <>{chevron}<div className="text-xs font-bold text-slate-900 flex items-center gap-1"><Package className="w-3.5 h-3.5 text-sky-600" />Materials &amp; contractor work <span className="font-normal text-slate-400">({r.count})</span></div></>;
  }
  return <div className="pl-6 pr-2 text-xs text-slate-700 truncate" title={r.name}>{r.name} <span className="text-slate-400">({r.entries.length})</span></div>;
}

function tip(t: Task, span: TaskSpan, taskById: Map<string, Task>) {
  const parts = [t.name, `Status: ${t.status}`];
  if (span.kind === 'range') parts.push(`Planned ${formatDate(span.start)} → ${formatDate(span.end)} (${span.days} day${span.days === 1 ? '' : 's'})`);
  if (span.kind === 'start-only') parts.push(`Planned start ${formatDate(span.start)} (no planned finish)`);
  if (span.kind === 'end-only') parts.push(`Planned finish ${formatDate(span.end)} (no planned start)`);
  if (span.kind === 'invalid') parts.push(`Check dates: finish ${formatDate(span.end)} is before start ${formatDate(span.start)}`);
  if (t.actual_start || t.actual_end) parts.push(`Actual ${formatDate(t.actual_start)} → ${formatDate(t.actual_end)}`);
  if (t.assigned_user_name) parts.push(`Assigned: ${t.assigned_user_name}`);
  else if (t.responsible) parts.push(`Responsible: ${t.responsible}`);
  if (t.depends_on.length) parts.push(`After: ${t.depends_on.map((id) => taskById.get(id)?.name ?? '—').join('; ')}`);
  return parts.join('\n');
}

function RowBars({ r, x, ppd, zoom, today, taskById, onOpenPhase, onOpenTask, onOpenMaterials }: {
  r: Row; x: (iso: string) => number; ppd: number; zoom: Zoom; today: string; taskById: Map<string, Task>;
  onOpenPhase: (p: Phase) => void; onOpenTask: (t: Task) => void; onOpenMaterials: (items: MaterialItem[]) => void;
}) {
  if (r.type === 'mat-head') return null;
  if (r.type === 'phase') {
    const s = r.span;
    const title = `${r.phase.seq}. ${r.phase.name} — ${r.done}/${r.total} tasks completed`;
    if (s.kind === 'range') {
      const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
      return (
        <button type="button" onClick={() => onOpenPhase(r.phase)} title={`${title}\nPlanned ${formatDate(s.start)} → ${formatDate(s.end)} (${s.days} days)`}
          className="absolute top-[11px] h-3 rounded-sm bg-slate-300 overflow-hidden border border-slate-400" style={{ left: x(s.start), width: Math.max(s.days * ppd, 4) }}>
          <span className="block h-full bg-slate-600" style={{ width: `${pct}%` }} />
        </button>
      );
    }
    if (s.kind !== 'none') return <SingleMarks span={s} x={x} ppd={ppd} onClick={() => onOpenPhase(r.phase)} title={title} />;
    if (r.summary) {
      return <div className="absolute top-[15px] h-0 border-t-2 border-dashed border-slate-300" style={{ left: x(r.summary.start), width: Math.max(x(r.summary.end) + ppd - x(r.summary.start), 4) }}
        title="Span of this phase's scheduled tasks (phase dates not set)" />;
    }
    return null;
  }
  if (r.type === 'task') {
    const t = r.task;
    const s = r.span;
    const title = tip(t, s, taskById);
    if (s.kind === 'range') {
      const w = Math.max(s.days * ppd, 6);
      return (
        <button type="button" onClick={() => onOpenTask(t)} title={title} aria-label={title}
          className={`absolute top-[7px] h-5 rounded-md border text-[10px] font-semibold px-1.5 flex items-center gap-1 overflow-hidden whitespace-nowrap ${barCls(t.status)} ${t.status !== 'Completed' && s.end < today ? 'ring-2 ring-rose-300' : ''}`}
          style={{ left: x(s.start), width: w }}>
          {t.is_hold_point && <ShieldCheck className="w-3 h-3 shrink-0" />}
          {w >= 34 && <span>{s.days}d</span>}
          {w >= 110 && zoom === 'week' && <span className="truncate font-normal">{t.status === 'Completed' ? '· done' : ''}</span>}
        </button>
      );
    }
    return <SingleMarks span={s} x={x} ppd={ppd} onClick={() => onOpenTask(t)} title={title} cls={barCls(t.status)} />;
  }
  // material category row: one milestone per date (several lines on the same date are stacked)
  const byDate = new Map<string, Array<{ e: MaterialEntry; kind: 'expected' | 'actual' }>>();
  for (const e of r.entries) {
    if (e.expected) byDate.set(e.expected.date, [...(byDate.get(e.expected.date) ?? []), { e, kind: 'expected' }]);
    if (e.actual) byDate.set(e.actual, [...(byDate.get(e.actual) ?? []), { e, kind: 'actual' }]);
  }
  return (
    <>
      {[...byDate.entries()].map(([date, list]) => {
        const first = list[0];
        const kind = first.kind === 'actual' ? (first.e.work ? 'actual_work' : 'actual') : first.e.expected!.kind;
        const title = list.map(({ e, kind: k }) => `${e.item.description} — ${k === 'actual' ? (e.work ? 'Actual completion' : 'Actual delivery') : e.expected!.label} ${formatDate(date)}`).join('\n');
        const items = [...new Set(list.map((l) => l.e.item))];
        return (
          <button key={date} type="button" onClick={() => onOpenMaterials(items)} title={title} aria-label={title}
            className="absolute top-[9px] flex items-center" style={{ left: x(date) + ppd / 2 - 7 }}>
            <Mark kind={kind} size={14} overdue={first.kind === 'expected' && first.e.overdue} />
            {list.length > 1 && <span className="ml-0.5 text-[9px] font-bold text-slate-600 bg-white/90 rounded px-0.5">{list.length}</span>}
          </button>
        );
      })}
    </>
  );
}

function SingleMarks({ span, x, ppd, onClick, title, cls = 'bg-slate-400 border-slate-500' }: { span: TaskSpan; x: (iso: string) => number; ppd: number; onClick: () => void; title: string; cls?: string }) {
  const dot = (iso: string, label: string, warn = false) => (
    <button key={label} type="button" onClick={onClick} title={title} aria-label={title}
      className="absolute top-[9px] flex items-center gap-1 whitespace-nowrap" style={{ left: x(iso) + ppd / 2 - 7 }}>
      <span className={`inline-block w-3.5 h-3.5 rotate-45 border-2 ${warn ? 'bg-rose-100 border-rose-500' : cls}`} />
      <span className={`text-[10px] ${warn ? 'text-rose-700 font-semibold' : 'text-slate-500'}`}>{label}</span>
    </button>
  );
  if (span.kind === 'start-only') return dot(span.start, 'Start only');
  if (span.kind === 'end-only') return dot(span.end, 'Finish only');
  if (span.kind === 'invalid') return <>{dot(span.start, 'Start', true)}{dot(span.end, 'Finish (check dates)', true)}</>;
  return null;
}

