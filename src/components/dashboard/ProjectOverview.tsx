import React, { useState } from 'react';
import { AlertTriangle, CalendarDays, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import type { Project } from '../../lib/types';
import { formatDate } from '../../lib/format';
import { completionLabel, pctLabel, phaseDisplayName, type DashTask, type Milestone, type PhaseSummary, taskCompletion } from '../../lib/dashboard';
import { Badge, Modal, StatusBadge } from '../ui';
import { InfoPopover } from '../InfoPopover';
import { linkBtn, Section } from './Section';

const phaseTone = (s: string) => (s === 'Completed' ? 'emerald' : s === 'In progress' ? 'sky' : 'slate') as 'emerald' | 'sky' | 'slate';

function Stat({ label, info, children, className = '' }: { label: string; info?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-3 min-w-0 ${className}`}>
      <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}{info}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * Compact project summary: name and actions on top, then task completion, current phase(s),
 * planned start, target finish and next milestone. Missing data shows a short message with an action.
 */
export function ProjectOverview({ project, tasks, phases, milestone, upcomingDays, onOpenPhase, onSettings, canSettings, canTimeline, budgetUnconfirmed, canConfirmBudget }: {
  project: Project; tasks: DashTask[]; phases: PhaseSummary[]; milestone: Milestone; upcomingDays: number;
  onOpenPhase: (id: string) => void; onSettings: () => void; canSettings: boolean; canTimeline: boolean;
  /** 'missing' / 'unconfirmed' control budget; null when confirmed or the user has no financial access */
  budgetUnconfirmed: 'missing' | 'unconfirmed' | null; canConfirmBudget: boolean;
}) {
  const c = taskCompletion(tasks);
  const active = phases.filter((p) => p.status === 'In progress');
  const scheduleNotSet = c.open > 0 && c.unscheduled === c.open; // completed tasks never count as unscheduled work
  const warn = milestone?.kind === 'next' && (milestone.blockers.length > 0 || milestone.inDays <= upcomingDays - 1) ? milestone : null;
  const timelineHref = `#/timeline/${project.id}`;
  return (
    <section aria-labelledby="ov-title" className="bg-white rounded-xl border border-slate-200 shadow-2xs p-5 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 id="ov-title" className="text-2xl font-bold text-slate-900 tracking-tight break-words">{project.name}</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            <span className="font-mono font-semibold text-sky-700">{project.code}</span>
            {project.location ? ` · ${project.location}` : ''}{project.status ? ` · ${project.status}` : ''}
            {project.archived_at && <span className="ml-2 font-semibold text-rose-600">Archived (read-only)</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSettings && <button type="button" onClick={onSettings} className={linkBtn}><Settings className="w-4 h-4" />Settings & links</button>}
          {canTimeline && <a href={timelineHref} className={linkBtn}><CalendarDays className="w-4 h-4" />View timeline</a>}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 xl:grid-cols-[minmax(12rem,0.9fr)_minmax(16rem,1.7fr)_minmax(8rem,0.5fr)_minmax(8rem,0.5fr)_minmax(15rem,1.5fr)] gap-3">
        <Stat label="Task completion" className="col-span-2 sm:col-span-1" info={
          <InfoPopover label="About task completion">Completed tasks divided by all timeline tasks. It counts tasks marked Completed in the Timeline and is <b>not</b> consultant-certified physical construction progress.</InfoPopover>
        }>
          {c.total ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-slate-900">{c.pct}</span>
                <span className="text-sm text-slate-600">{c.done} of {c.total} tasks</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-slate-200 overflow-hidden" role="progressbar" aria-label="Task completion" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.done} aria-valuetext={`${c.done} of ${c.total} tasks completed`}>
                <div className="h-full bg-sky-600 rounded-full" style={{ width: `${(c.done / c.total) * 100}%` }} />
              </div>
              {(c.inProgress > 0 || c.blocked > 0) && (
                <p className="mt-1.5 text-xs text-slate-500">{[c.inProgress && `${c.inProgress} in progress`, c.blocked && <span key="b" className="font-semibold text-rose-700">{c.blocked} blocked</span>].filter(Boolean).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ' · ', x] : [x]), [])}</p>
              )}
            </>
          ) : <p className="text-sm font-semibold text-slate-700">No tasks yet</p>}
        </Stat>

        <Stat label={active.length > 1 ? `Current phases (${active.length})` : 'Current phase'} className="col-span-2 sm:col-span-1">
          {active.length ? (
            <div className="flex flex-wrap gap-1.5">
              {active.map((p) => (
                <button key={p.id} type="button" onClick={() => onOpenPhase(p.id)} title={p.name}
                  className="inline-flex items-center min-h-8 px-2.5 py-1 rounded-md border border-sky-200 bg-sky-50 text-sky-800 text-sm font-semibold hover:bg-sky-100 text-left">
                  {p.seq}. {phaseDisplayName(p.name)}
                </button>
              ))}
            </div>
          ) : <p className="text-sm font-semibold text-slate-700">{c.total ? 'No phase in progress' : 'No phases yet'}</p>}
        </Stat>

        <Stat label="Planned start"><p className={`text-sm font-semibold ${project.planned_start_date ? 'text-slate-900' : 'text-slate-500'}`}>{project.planned_start_date ? formatDate(project.planned_start_date) : 'Not set'}</p></Stat>
        <Stat label="Target finish"><p className={`text-sm font-semibold ${project.target_completion_date ? 'text-slate-900' : 'text-slate-500'}`}>{project.target_completion_date ? formatDate(project.target_completion_date) : 'Not set'}</p></Stat>

        <Stat label="Next milestone" className="col-span-2 xl:col-span-1">
          {milestone?.kind === 'next' ? (
            <>
              <p className="text-sm font-semibold text-slate-900 break-words">{milestone.task.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">{formatDate(milestone.date)} · {milestone.inDays === 0 ? 'today' : `in ${milestone.inDays} day${milestone.inDays === 1 ? '' : 's'}`} · hold point</p>
            </>
          ) : milestone?.kind === 'unscheduled' ? (
            <p className="text-sm font-semibold text-slate-500">Not scheduled <span className="block text-xs font-normal">{milestone.count} hold point{milestone.count === 1 ? '' : 's'} without a date</span></p>
          ) : <p className="text-sm font-semibold text-slate-500">None open</p>}
        </Stat>
      </div>

      {(scheduleNotSet || c.total === 0 || budgetUnconfirmed || warn) && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Missing information">
          {(scheduleNotSet || c.total === 0) && (
            <li className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-1.5 text-sm text-amber-900">
              <span><b>{c.total === 0 ? 'No timeline tasks yet.' : 'Schedule not set.'}</b> {c.total === 0 ? 'Add tasks in the timeline.' : 'No task has planned dates yet.'}</span>
            </li>
          )}
          {budgetUnconfirmed && (
            <li className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-1.5 text-sm text-amber-900">
              <span className="font-semibold">{budgetUnconfirmed === 'missing' ? 'Budget not entered' : 'Budget unconfirmed'}</span>
              {canConfirmBudget ? <button type="button" onClick={onSettings} className="font-semibold text-sky-700 hover:text-sky-900">Open settings</button> : <span>{budgetUnconfirmed === 'missing' ? 'An admin enters it in project settings.' : 'An admin confirms it in project settings.'}</span>}
            </li>
          )}
          {warn && (
            <li className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-1.5 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span><b>{warn.blockers.length ? 'Milestone waits for a blocked task:' : 'Milestone within 14 days:'}</b> {warn.blockers.length ? warn.blockers.map((b) => b.name).join(', ') : `${formatDate(warn.date)}`}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Phase tracker as a wrapping grid of compact cards (no sideways scrolling). Long timelines show the
 * phases around the current one first, with "Show all" for the rest.
 */
export function PhaseTracker({ phases, onOpenPhase, initialLimit = 8 }: { phases: PhaseSummary[]; onOpenPhase: (id: string) => void; initialLimit?: number }) {
  const [all, setAll] = useState(false);
  const firstOpen = phases.findIndex((p) => p.status !== 'Completed');
  // start one completed phase before the first open one, so the current work is in view
  const from = phases.length <= initialLimit || firstOpen < 0 ? 0 : Math.max(0, Math.min(firstOpen - 1, phases.length - initialLimit));
  const shown = all ? phases : phases.slice(from, from + initialLimit);
  const hidden = phases.length - shown.length;
  const done = phases.filter((p) => p.status === 'Completed').length;
  const active = phases.filter((p) => p.status === 'In progress').length;
  return (
    <Section id="ph-title" title="Construction phases" meta={phases.length ? `${done} of ${phases.length} completed${active ? ` · ${active} in progress` : ''}` : undefined}
      actions={phases.length > initialLimit && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className={linkBtn}>
          {all ? <><ChevronUp className="w-4 h-4" />Show fewer</> : <><ChevronDown className="w-4 h-4" />Show all {phases.length} phases</>}
        </button>
      )}>
      {phases.length === 0 ? (
        <p className="text-sm text-slate-500">No phases yet. They appear when the timeline has phases and tasks.</p>
      ) : (
        <>
          <ul data-testid="phase-grid" className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-2" aria-label="Construction phases">
            {shown.map((p) => {
              const title = phaseDisplayName(p.name);
              return (
                <li key={p.id} data-phase={p.id}>
                  <button type="button" onClick={() => onOpenPhase(p.id)} aria-label={`Details: phase ${p.seq}, ${title}, ${p.status}`} title={p.name}
                    className={`w-full h-full text-left rounded-lg border px-3 py-2.5 flex flex-col gap-1.5 bg-white hover:bg-slate-50 transition-colors ${p.status === 'In progress' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-slate-200'}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-slate-500">Phase {p.seq}</span>
                      <span className="flex items-center gap-1">
                        {p.blocked + p.onHold > 0 && p.status !== 'Completed' && <Badge tone="rose">{p.blocked ? `${p.blocked} blocked` : `${p.onHold} on hold`}</Badge>}
                        <Badge tone={phaseTone(p.status)}>{p.status}</Badge>
                      </span>
                    </span>
                    <span className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">{title}</span>
                    {p.total > 0 ? (
                      <span className="block">
                        <span className="flex justify-between text-xs text-slate-600">
                          <span>{p.done}/{p.total} tasks{p.blocked > 0 && <span className="font-semibold text-rose-700"> · {p.blocked} blocked</span>}</span>
                          <span className="font-mono">{pctLabel(p.done, p.total)}</span>
                        </span>
                        <span className="mt-1 block h-1.5 rounded-full bg-slate-200 overflow-hidden" aria-hidden="true"><span className={`block h-full rounded-full ${p.status === 'Completed' ? 'bg-emerald-500' : 'bg-sky-600'}`} style={{ width: `${(p.done / p.total) * 100}%` }} /></span>
                      </span>
                    ) : <span className="text-xs text-slate-500">No tasks</span>}
                    <span className="flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span>{p.start || p.end ? `${formatDate(p.start)} → ${formatDate(p.end)}` : ''}{p.schedule_approved && <span className="ml-1 text-[10px] text-emerald-700">· schedule approved</span>}</span>
                      <span className="font-semibold text-sky-700">Details →</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!all && hidden > 0 && <p className="mt-2 text-xs text-slate-500">{hidden} more phase{hidden === 1 ? '' : 's'} not shown.</p>}
        </>
      )}
    </Section>
  );
}

export function PhaseDetails({ projectId, phase, allTasks, onClose }: { projectId: string; phase: PhaseSummary | null; allTasks: DashTask[]; onClose: () => void }) {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  return (
    <Modal open={!!phase} title={phase ? `Phase ${phase.seq} · ${phaseDisplayName(phase.name)}` : ''} subtitle={phase?.name} onClose={onClose} wide>
      {phase && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Work status</dt><dd className="mt-1 flex flex-wrap gap-1"><Badge tone={phaseTone(phase.status)}>{phase.status}</Badge>{phase.schedule_approved && <Badge tone="slate">Schedule approved</Badge>}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks completed</dt><dd className="mt-1 font-semibold text-slate-800">{phase.total ? `${phase.done} of ${phase.total} · ${pctLabel(phase.done, phase.total)}` : 'No tasks'}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Planned start</dt><dd className="mt-1 font-semibold text-slate-800">{phase.start ? formatDate(phase.start) : 'Not scheduled'}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Planned finish</dt><dd className="mt-1 font-semibold text-slate-800">{phase.end ? formatDate(phase.end) : 'Not scheduled'}</dd></div>
          </dl>
          <p className="text-xs text-slate-500">Status comes from task statuses{phase.datesFrom === 'tasks' ? '; dates are the range of this phase’s task dates' : ''}. It does not certify physical progress.</p>
          {phase.tasks.length === 0 ? <p className="text-sm text-slate-500">No tasks in this phase.</p> : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {phase.tasks.map((t) => (
                <li key={t.id}>
                  <a href={`#/timeline/${projectId}/${t.id}`} onClick={onClose} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5 no-underline hover:bg-slate-50">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900 break-words">{t.name}{t.is_hold_point && <span className="ml-2 align-middle"><Badge tone="amber">Hold point</Badge></span>}</span>
                      <span className="block text-xs text-slate-500 mt-0.5">
                        {completionLabel(t, formatDate) ?? (t.planned_start || t.planned_end ? `${formatDate(t.planned_start)} → ${formatDate(t.planned_end)}` : 'Not scheduled')}
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
          <a href={`#/timeline/${projectId}`} onClick={onClose} className={linkBtn}><CalendarDays className="w-4 h-4" />Open Timeline</a>
        </div>
      )}
    </Modal>
  );
}
