// Pure calculations for the project dashboard. Everything is derived from saved records returned by
// /api/projects/:id/dashboard and /prerequisites — nothing is estimated, and percentages are only
// shown when there is a denominator.
import { addDaysISO, fromCents, toCents } from '../../shared/calc';

export interface DashTask {
  id: string; phase_id: string; name: string; status: string; planned_start: string | null; planned_end: string | null;
  is_hold_point: boolean; depends_on: string[]; assigned: string; notes: string;
}
export interface DashPhaseRow {
  id: string; seq: number; name: string; schedule_approved: boolean; planned_start: string | null; planned_end: string | null;
  total: number; completed: number;
}
export type PhaseStatus = 'Completed' | 'In progress' | 'Scheduled' | 'Not scheduled' | 'No tasks';
export interface PhaseSummary extends DashPhaseRow {
  tasks: DashTask[]; done: number; blocked: number; onHold: number; status: PhaseStatus;
  start: string | null; end: string | null; datesFrom: 'phase' | 'tasks' | null;
}

/** "n%" only with a denominator; never rounds to 0% or 100% unless it is exactly that. */
export function pctLabel(n: number, d: number): string | null {
  if (!d) return null;
  if (n <= 0) return '0%';
  if (n >= d) return '100%';
  const p = (n / d) * 100;
  if (p < 1) return '<1%';
  if (p > 99) return '99%';
  return `${Math.round(p)}%`;
}

export function taskCompletion(tasks: DashTask[]) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'Completed').length;
  return {
    total, done, open: total - done, pct: pctLabel(done, total),
    inProgress: tasks.filter((t) => t.status === 'In Progress').length,
    blocked: tasks.filter((t) => t.status === 'Blocked').length,
    onHold: tasks.filter((t) => t.status === 'On Hold').length,
    unscheduled: tasks.filter((t) => !t.planned_start && !t.planned_end).length,
  };
}

/**
 * Per-phase summary. Status comes only from task statuses: Completed when every task is completed,
 * In progress when a task is in progress / blocked / on hold or some (not all) are completed,
 * Scheduled when tasks or the phase have planned dates, otherwise Not scheduled.
 * Dates: the phase's own planned dates when entered, else the range of its tasks' planned dates.
 */
export function phaseSummaries(phases: DashPhaseRow[], tasks: DashTask[]): PhaseSummary[] {
  return phases.map((p) => {
    const list = tasks.filter((t) => t.phase_id === p.id);
    const done = list.filter((t) => t.status === 'Completed').length;
    const started = list.some((t) => ['In Progress', 'Blocked', 'On Hold'].includes(t.status)) || (done > 0 && done < list.length);
    const starts = list.map((t) => t.planned_start).filter(Boolean).sort() as string[];
    const ends = list.map((t) => t.planned_end).filter(Boolean).sort() as string[];
    const own = !!(p.planned_start || p.planned_end);
    const start = own ? p.planned_start : starts[0] ?? null;
    const end = own ? p.planned_end : ends[ends.length - 1] ?? null;
    const status: PhaseStatus = !list.length ? 'No tasks'
      : done === list.length ? 'Completed'
      : started ? 'In progress'
      : start || end || starts.length || ends.length ? 'Scheduled' : 'Not scheduled';
    return {
      ...p, tasks: list, done, status, start, end, datesFrom: own ? 'phase' : start || end ? 'tasks' : null,
      blocked: list.filter((t) => t.status === 'Blocked').length, onHold: list.filter((t) => t.status === 'On Hold').length,
    };
  });
}

export type Milestone =
  | { kind: 'next'; task: DashTask; date: string; inDays: number; blockers: DashTask[] }
  | { kind: 'unscheduled'; count: number }
  | null;

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Next open inspection hold point with a planned date on or after today; blockers are its direct dependencies that are blocked / on hold. */
export function nextMilestone(tasks: DashTask[], today: string): Milestone {
  const open = tasks.filter((t) => t.is_hold_point && t.status !== 'Completed');
  const when = (t: DashTask) => t.planned_end || t.planned_start;
  const next = open.filter((t) => { const d = when(t); return !!d && d >= today; }).sort((a, b) => when(a)!.localeCompare(when(b)!))[0];
  if (!next) return open.some((t) => !when(t)) ? { kind: 'unscheduled', count: open.filter((t) => !when(t)).length } : null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blockers = next.depends_on.map((id) => byId.get(id)).filter((t): t is DashTask => !!t && (t.status === 'Blocked' || t.status === 'On Hold'));
  const date = when(next)!;
  return { kind: 'next', task: next, date, inDays: dayDiff(today, date), blockers };
}

export interface FinanceInput {
  controlBudget: number | null; controlBudgetConfirmed: boolean; paid: number; pending: number; overdue: number; overdueCount: number;
  transactionCount?: number; unpaidCount?: number;
}
/**
 * Actual paid = recorded transfers; scheduled unpaid = outstanding milestone balances; overdue is a subset of
 * scheduled unpaid. Budget remaining = confirmed control budget − actual paid (only when confirmed).
 * Spending % only when the confirmed budget is above zero. Cent arithmetic avoids rounding drift.
 */
export function financeOverview(f: FinanceInput) {
  const confirmed = f.controlBudget !== null && f.controlBudgetConfirmed;
  const budgetC = f.controlBudget === null ? null : toCents(f.controlBudget);
  const paidC = toCents(f.paid);
  const remainingC = confirmed ? (budgetC as number) - paidC : null;
  return {
    confirmed, budget: f.controlBudget, paid: f.paid, unpaid: f.pending, overdue: f.overdue, overdueCount: f.overdueCount,
    transactionCount: f.transactionCount ?? 0, unpaidCount: f.unpaidCount ?? 0,
    remaining: remainingC === null ? null : fromCents(remainingC),
    over: remainingC !== null && remainingC < 0 ? fromCents(-remainingC) : 0,
    spentPct: confirmed && (budgetC as number) > 0 ? (paidC / (budgetC as number)) * 100 : null,
  };
}

export interface UpcomingItem {
  key: string; kind: 'material' | 'task' | 'consultant_visit' | 'site_visit'; id: string; date: string; dateLabel: string;
  title: string; context: string; who: string; status: string; href: string;
}
export const UPCOMING_TABS = ['all', 'materials', 'tasks', 'visits'] as const;
export type UpcomingTab = (typeof UPCOMING_TABS)[number];
export function upcomingMatches(i: UpcomingItem, tab: UpcomingTab, q: string) {
  const inTab = tab === 'all' || (tab === 'materials' ? i.kind === 'material' : tab === 'tasks' ? i.kind === 'task' : i.kind === 'consultant_visit' || i.kind === 'site_visit');
  const s = q.trim().toLowerCase();
  return inTab && (!s || `${i.title} ${i.who} ${i.status} ${i.dateLabel} ${i.context}`.toLowerCase().includes(s));
}
export const upcomingWindowEnd = (today: string, days: number) => addDaysISO(today, days - 1);

export interface Prerequisite {
  id: string; title: string; status: string; phase_id: string | null; phase_seq: number | null; phase_name: string | null;
  responsible_user_id: string | null; responsible_name: string; responsible_display: string | null; due_date: string | null;
  completed_on: string | null; decided_by_name: string | null; decided_at: string | null; contract_id: string | null;
  contract_title?: string | null; contract_company?: string | null; contract_status?: string | null; contract_archived_at?: string | null;
  contract_file_count?: number; contract_linked?: boolean; document_url: string; notes: string; attachment_count: number;
  sort_order: number; archived_at: string | null;
}

/** Checklist counts: Not applicable items leave the denominator and are counted separately. */
export function checklistCounts(setup: Array<{ done: boolean }>, prereqs: Array<{ status: string; archived_at?: string | null }>) {
  const live = prereqs.filter((p) => !p.archived_at);
  const applicable = live.filter((p) => p.status !== 'Not applicable');
  const preDone = applicable.filter((p) => p.status === 'Completed').length;
  const setupDone = setup.filter((s) => s.done).length;
  const total = setup.length + applicable.length;
  const done = setupDone + preDone;
  return { setupDone, setupTotal: setup.length, preDone, preApplicable: applicable.length, notApplicable: live.length - applicable.length, done, total, remaining: total - done, pct: pctLabel(done, total) };
}
