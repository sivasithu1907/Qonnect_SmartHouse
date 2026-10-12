import React, { useMemo, useState } from 'react';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, Project, Section } from '../lib/types';
import { formatDate, formatQAR } from '../lib/format';
import { Notice, Spinner } from '../components/ui';
import { NeedsAttention } from '../components/ProjectHealth';
import { buildAttention, buildSetupChecklist, type DashboardData } from '../lib/projectHealth';
import { financeOverview, nextMilestone, phaseSummaries, type DashPhaseRow } from '../lib/dashboard';
import { PhaseDetails, PhaseTracker, ProjectOverview } from '../components/dashboard/ProjectOverview';
import { FinanceOverview } from '../components/dashboard/FinanceOverview';
import { UpcomingPanel } from '../components/dashboard/UpcomingPanel';
import { ProjectChecklist } from '../components/dashboard/ProjectChecklist';

/**
 * Project dashboard: A compact overview → B financial overview → C next 14 days | D needs attention →
 * E phase tracker → F project setup and construction prerequisites (collapsible, at the bottom). All figures come from saved records of the selected project.
 */
export function Dashboard({ project, onNavigate, onSettings, focusId, onFocusHandled }: { project: Project; onNavigate: (s: Section) => void; onSettings: () => void } & FocusProps) {
  const { can } = useSession();
  const { data: d, error } = useApi<DashboardData & Record<string, any>>(`/api/projects/${project.id}/dashboard`);
  const [phaseId, setPhaseId] = useState<string | null>(null);

  const view = useMemo(() => {
    // ignore a response that belongs to a previously selected project
    if (!d || d.project.id !== project.id) return null;
    const tasks = d.tasks ?? [];
    const phases = phaseSummaries((d.timeline.phases ?? []) as DashPhaseRow[], tasks);
    const milestone = nextMilestone(tasks, d.today ?? '');
    return {
      tasks, phases, milestone,
      fin: d.finance ? financeOverview(d.finance as Parameters<typeof financeOverview>[0]) : null,
      attention: buildAttention(d, { formatDate: (x) => formatDate(x), formatMoney: formatQAR, milestone }),
      setup: buildSetupChecklist(d, can),
    };
  }, [d, project.id, can]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!d || !view) return <Spinner />;
  const days = d.upcomingDays ?? 14;
  const today = d.today ?? '';
  const phase = view.phases.find((p) => p.id === phaseId) ?? null;

  return (
    <div className="space-y-4">
      <ProjectOverview project={project} tasks={view.tasks} phases={view.phases} milestone={view.milestone} upcomingDays={days}
        onOpenPhase={setPhaseId} onSettings={onSettings} canSettings={can('links.edit') || can('projects.manage')} canTimeline={can('timeline.read')}
        budgetUnconfirmed={!view.fin || view.fin.confirmed ? null : view.fin.budget === null ? 'missing' : 'unconfirmed'} canConfirmBudget={can('projects.manage') && !project.archived_at} />
      <FinanceOverview projectId={project.id} fin={view.fin} canConfirmBudget={can('projects.manage') && !project.archived_at} onSettings={onSettings} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-4 items-start">
        <UpcomingPanel projectId={project.id} items={d.upcoming ?? []} today={today} days={days} can={can} />
        <NeedsAttention items={view.attention} />
      </div>
      {can('timeline.read') && <PhaseTracker phases={view.phases} onOpenPhase={setPhaseId} />}
      <ProjectChecklist project={project} setup={view.setup} today={today} onSettings={onSettings} onNavigate={onNavigate}
        phases={view.phases.map((p) => ({ id: p.id, seq: p.seq, name: p.name }))} focusId={focusId} onFocusHandled={onFocusHandled} />
      <PhaseDetails projectId={project.id} phase={phase} allTasks={view.tasks} onClose={() => setPhaseId(null)} />
    </div>
  );
}
