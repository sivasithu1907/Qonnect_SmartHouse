import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Info, Settings } from 'lucide-react';
import type { Project } from '../../lib/types';
import { formatDate } from '../../lib/format';
import { pctLabel, type DashTask, type Milestone, type PhaseSummary, taskCompletion } from '../../lib/dashboard';
import { Badge, Button, Modal, StatusBadge } from '../ui';

const phaseTone = (s: string) => (s === 'Completed' ? 'emerald' : s === 'In progress' ? 'sky' : 'slate') as 'emerald' | 'sky' | 'slate';

/** Project summary: stage, dates, next milestone and task completion (not physical progress). */
export function ProjectOverview({ project, tasks, phases, milestone, upcomingDays, onOpenPhase, onSettings, canSettings }: {
  project: Project; tasks: DashTask[]; phases: PhaseSummary[]; milestone: Milestone; upcomingDays: number;
  onOpenPhase: (id: string) => void; onSettings: () => void; canSettings: boolean;
}) {
  const c = taskCompletion(tasks);
  const active = phases.filter((p) => p.status === 'In progress');
  const warn = milestone?.kind === 'next' && (milestone.blockers.length > 0 || milestone.inDays <= upcomingDays - 1) ? milestone : null;
  return (
    <section aria-labelledby="ov-title" className="bg-white rounded-xl border border-slate-200 shadow-2xs grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="ov-title" className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">{project.name}</h1>
            <p className="text-sm text-slate-500 mt-0.5"><span className="font-mono font-semibold text-sky-700">{project.code}</span>{project.location ? ` · ${project.location}` : ''}{project.status ? ` · ${project.status}` : ''}</p>
            {project.archived_at && <p className="text-xs font-semibold text-rose-600 mt-1">Archived (read-only)</p>}
          </div>
          {canSettings && <Button onClick={onSettings}><Settings className="w-4 h-4" />Settings & links</Button>}
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <div className="sm:col-span-2 min-w-0">
            <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Current phase{active.length > 1 ? 's' : ''}</dt>
            <dd className="mt-1">
              {active.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {active.map((p) => (
                      <button key={p.id} type="button" onClick={() => onOpenPhase(p.id)}
                        className="inline-flex items-center px-2.5 py-1 rounded-md border border-sky-200 bg-sky-50 text-sky-800 text-xs font-semibold hover:bg-sky-100 text-left">
                        {p.seq}. {p.name}
                      </button>
                    ))}
                  </div>
                  {active.length > 1 && <p className="text-xs text-slate-500 mt-1">{active.length} phases have work in progress at the same time.</p>}
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-800">{c.total ? 'No phase in progress' : 'No timeline tasks yet'}
                  <span className="block text-xs font-normal text-slate-500">{c.total ? 'A phase is current once one of its tasks is in progress, blocked, on hold or partly completed.' : 'Phases appear once the project has timeline tasks.'}</span></p>
              )}
            </dd>
          </div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Planned start</dt><dd className="text-sm font-semibold text-slate-800 mt-0.5">{project.planned_start_date ? formatDate(project.planned_start_date) : 'Not set'}</dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Target finish</dt><dd className="text-sm font-semibold text-slate-800 mt-0.5">{project.target_completion_date ? formatDate(project.target_completion_date) : 'Not set'}</dd></div>
          <div className="sm:col-span-2 min-w-0">
            <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Next milestone</dt>
            <dd className="text-sm font-semibold text-slate-800 mt-0.5 break-words">
              {milestone?.kind === 'next' ? (
                <>{milestone.task.name}<span className="block text-xs font-normal text-slate-500">{formatDate(milestone.date)} · {milestone.inDays === 0 ? 'today' : `in ${milestone.inDays} day${milestone.inDays === 1 ? '' : 's'}`} · inspection hold point</span></>
              ) : milestone?.kind === 'unscheduled' ? (
                <>Not scheduled<span className="block text-xs font-normal text-slate-500">{milestone.count} inspection hold point{milestone.count === 1 ? ' has' : 's have'} no planned date yet.</span></>
              ) : (
                <>None<span className="block text-xs font-normal text-slate-500">No open inspection hold points in the timeline.</span></>
              )}
            </dd>
          </div>
        </dl>
        {warn && (
          <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span><b>{warn.blockers.length ? 'Milestone waits for a blocked task. ' : 'Milestone within the next 14 days. '}</b>
              {warn.blockers.length ? `${warn.blockers.map((b) => b.name).join(', ')} ${warn.blockers.length === 1 ? 'is' : 'are'} ${warn.blockers[0].status.toLowerCase()}.` : `${warn.task.name} is planned for ${formatDate(warn.date)}.`}</span>
          </div>
        )}
        <a href={`#/timeline/${project.id}`} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm font-semibold text-slate-700 hover:bg-slate-50 no-underline shadow-2xs">
          <CalendarDays className="w-4 h-4" />View full timeline
        </a>
      </div>
      <div className="p-4 sm:p-5 space-y-3 border-t lg:border-t-0 lg:border-l border-slate-100 bg-slate-50/60 rounded-b-xl lg:rounded-b-none lg:rounded-r-xl min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Task completion</p>
        {c.total ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-bold font-mono text-slate-900">{c.pct}</span>
              <span className="text-sm font-semibold text-slate-700">{c.done} of {c.total} tasks completed</span>
            </div>
            <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden" role="progressbar" aria-label="Task completion" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.done} aria-valuetext={`${c.done} of ${c.total} tasks completed`}>
              <div className="h-full bg-sky-600 rounded-full" style={{ width: `${(c.done / c.total) * 100}%` }} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{c.open} open</Badge>
              {c.inProgress > 0 && <Badge tone="sky">{c.inProgress} in progress</Badge>}
              {c.blocked > 0 && <Badge tone="rose">{c.blocked} blocked</Badge>}
              {c.onHold > 0 && <Badge tone="amber">{c.onHold} on hold</Badge>}
              {c.unscheduled > 0 && <Badge>{c.unscheduled} not scheduled</Badge>}
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-6 text-center">
            <p className="text-sm font-semibold text-slate-700">No tasks yet</p>
            <p className="text-xs text-slate-500 mt-1">Completion appears once the project has timeline tasks.</p>
          </div>
        )}
        <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />Counts tasks marked Completed in the timeline. It is not consultant-certified physical construction progress.</p>
      </div>
    </section>
  );
}

/** Horizontal phase tracker; scrolls inside itself, never the page. */
export function PhaseTracker({ phases, onOpenPhase }: { phases: PhaseSummary[]; onOpenPhase: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    const el = ref.current;
    const first = phases.find((p) => p.status === 'In progress') ?? phases.find((p) => p.status !== 'Completed');
    if (el && first) {
      const card = el.querySelector<HTMLElement>(`[data-phase="${first.id}"]`);
      if (card) el.scrollLeft = Math.max(0, card.offsetLeft - el.offsetLeft - 8);
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [phases, update]);
  const move = (dir: number) => ref.current?.scrollBy({ left: dir * Math.max(260, ref.current.clientWidth * 0.8), behavior: 'smooth' });
  return (
    <section aria-labelledby="ph-title" className="bg-white rounded-xl border border-slate-200 shadow-2xs">
      <header className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3 border-b border-slate-100">
        <div className="min-w-0 flex-1">
          <h2 id="ph-title" className="text-sm font-bold text-slate-900">Construction phases</h2>
          {phases.length > 0 && <p className="text-xs text-slate-500 mt-0.5">{phases.length} phases · status comes from task statuses</p>}
        </div>
        {phases.length > 0 && (
          <div className="flex gap-1">
            <button type="button" aria-label="Previous phases" disabled={edge.start} onClick={() => move(-1)} className="w-9 h-9 grid place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" aria-label="Next phases" disabled={edge.end} onClick={() => move(1)} className="w-9 h-9 grid place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
          </div>
        )}
      </header>
      <div className="p-4">
        {phases.length === 0 ? (
          <div className="text-center py-8 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/60"><p className="text-sm font-semibold text-slate-700">No phases yet</p><p className="text-xs text-slate-500 mt-1">Phases appear when the timeline has phases and tasks.</p></div>
        ) : (
          <div ref={ref} onScroll={update} data-testid="phase-scroller" className="flex gap-3 overflow-x-auto pb-2 snap-x" role="list" aria-label="Phases (scroll sideways)">
            {phases.map((p) => (
              <button key={p.id} type="button" role="listitem" data-phase={p.id} onClick={() => onOpenPhase(p.id)}
                aria-label={`Phase ${p.seq}, ${p.name}. ${p.status}. ${p.total ? `${p.done} of ${p.total} tasks completed.` : 'No tasks.'} Open details`}
                className={`snap-start shrink-0 w-60 text-left rounded-lg border p-3 flex flex-col gap-2 bg-white hover:border-sky-300 transition-colors ${p.status === 'In progress' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-slate-200'}`}>
                <span className="flex items-center justify-between gap-2"><span className="font-mono text-[11px] font-semibold text-slate-500">Phase {p.seq}</span><Badge tone={phaseTone(p.status)}>{p.status}</Badge></span>
                <span className="text-sm font-semibold text-slate-900 leading-snug line-clamp-3" title={p.name}>{p.name}</span>
                {p.total > 0 && (
                  <>
                    <span className="flex justify-between text-xs text-slate-600"><span>{p.done} of {p.total} tasks</span><span className="font-mono">{pctLabel(p.done, p.total)}</span></span>
                    <span className="h-1.5 rounded-full bg-slate-200 overflow-hidden" aria-hidden="true"><span className={`block h-full rounded-full ${p.status === 'Completed' ? 'bg-emerald-500' : 'bg-sky-600'}`} style={{ width: `${(p.done / p.total) * 100}%` }} /></span>
                  </>
                )}
                <span className="text-xs text-slate-500">{p.start || p.end ? `${formatDate(p.start)} → ${formatDate(p.end)}` : 'Not scheduled'}</span>
                {(p.blocked > 0 || p.onHold > 0) && <span><Badge tone="rose"><AlertTriangle className="w-3 h-3" aria-hidden="true" />{[p.blocked && `${p.blocked} blocked`, p.onHold && `${p.onHold} on hold`].filter(Boolean).join(' · ')}</Badge></span>}
                <span className="mt-auto text-xs font-semibold text-sky-700">Open details →</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function PhaseDetails({ projectId, phase, allTasks, onClose }: { projectId: string; phase: PhaseSummary | null; allTasks: DashTask[]; onClose: () => void }) {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  return (
    <Modal open={!!phase} title={phase ? `Phase ${phase.seq}` : ''} subtitle={phase?.name} onClose={onClose} wide>
      {phase && (
        <div className="space-y-4">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Status</dt><dd className="mt-1"><Badge tone={phaseTone(phase.status)}>{phase.status}</Badge></dd></div>
            <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Tasks completed</dt><dd className="mt-1 font-semibold text-slate-800">{phase.total ? `${phase.done} of ${phase.total} · ${pctLabel(phase.done, phase.total)}` : 'No tasks'}</dd></div>
            <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Planned start</dt><dd className="mt-1 font-semibold text-slate-800">{phase.start ? formatDate(phase.start) : 'Not scheduled'}</dd></div>
            <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Planned finish</dt><dd className="mt-1 font-semibold text-slate-800">{phase.end ? formatDate(phase.end) : 'Not scheduled'}</dd></div>
          </dl>
          {phase.datesFrom === 'tasks' && <p className="text-xs text-slate-500">Dates are the range of this phase’s task dates; the phase itself has no planned dates.</p>}
          <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />Status and percentage come from task statuses. They don’t certify physical progress or say whether the phase is on track.</p>
          {phase.tasks.length === 0 ? <p className="text-sm text-slate-500">No tasks in this phase.</p> : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {phase.tasks.map((t) => (
                <li key={t.id}>
                  <a href={`#/timeline/${projectId}/${t.id}`} onClick={onClose} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5 no-underline hover:bg-slate-50">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900 break-words">{t.name}{t.is_hold_point && <span className="ml-2 align-middle"><Badge tone="amber">Hold point</Badge></span>}</span>
                      <span className="block text-xs text-slate-500 mt-0.5">
                        {t.planned_start || t.planned_end ? `${formatDate(t.planned_start)} → ${formatDate(t.planned_end)}` : 'Not scheduled'}
                        {t.assigned ? ` · ${t.assigned}` : ''}
                        {t.depends_on.length > 0 ? ` · after ${t.depends_on.map((id) => byId.get(id)?.name ?? 'another task').join(', ')}` : ''}
                      </span>
                      {t.notes && (t.status === 'Blocked' || t.status === 'On Hold') && <span className="block text-xs text-rose-700 mt-0.5">{t.notes}</span>}
                    </span>
                    <StatusBadge status={t.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <a href={`#/timeline/${projectId}`} onClick={onClose} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 no-underline"><CalendarDays className="w-4 h-4" />Open Timeline</a>
        </div>
      )}
    </Modal>
  );
}
