// Project setup checklist and "Needs attention" items, derived only from saved project data
// returned by /api/projects/:id/dashboard. Nothing is estimated or marked complete without data.
import type { Section } from './types';
import type { DashTask, DashPhaseRow, Milestone, UpcomingItem } from './dashboard';

export interface DashboardData {
  project: {
    id: string; code?: string; name?: string; hasDriveLink?: boolean; hasSheetLink?: boolean; archived_at?: string | null;
    planned_start_date?: string | null; target_completion_date?: string | null;
  };
  today?: string;
  upcomingDays?: number;
  upcoming?: UpcomingItem[];
  tasks?: DashTask[];
  consultantReportsMissing?: Array<{ id: string; date: string; purpose: string; who: string | null }>;
  finance: null | {
    controlBudget: number | null; controlBudgetConfirmed: boolean;
    approvedItemCount: number; itemCount: number;
    paid?: number; pending?: number; overdue?: number; overdueCount?: number; transactionCount?: number; unpaidCount?: number;
    overduePayments: Array<{ id: string; payee_name: string; description: string; due_date: string | null; pending: number }>;
  };
  materials: {
    total: number; awaitingConfirmation: number; responsibilityNeedsConfirmation?: number; withDate?: number;
    overdue: Array<{ id: string; description: string; category: string; date: string | null; basis: string }>;
  };
  timeline: { total: number; scheduled?: number; phases: Array<Partial<DashPhaseRow> & { blocked: number }> };
}

export interface SetupItem {
  key: 'control_budget' | 'approved_amounts' | 'responsibilities' | 'delivery_dates' | 'timeline' | 'links';
  label: string;
  done: boolean;
  /** e.g. "12 of 19" — counts of saved records; null when not a counted item */
  progress: string | null;
  detail: string;
  action: { kind: 'settings' } | { kind: 'section'; section: Section } | { kind: 'href'; href: string };
  actionLabel: string;
}

type Can = (cap: string) => boolean;
const of = (n: number, total: number) => `${n} of ${total}`;

/** Only items the signed-in user can complete are listed. */
export function buildSetupChecklist(d: DashboardData, can: Can): SetupItem[] {
  if (d.project.archived_at) return [];
  const items: SetupItem[] = [];
  const f = d.finance;
  const m = d.materials;
  const t = d.timeline;

  if (f && can('projects.manage')) {
    const done = f.controlBudget !== null && f.controlBudgetConfirmed;
    items.push({
      key: 'control_budget', label: 'Confirm the control budget', done, progress: null,
      detail: done ? 'Confirmed in project settings.' : f.controlBudget === null ? 'No control budget entered yet.' : 'Entered but not confirmed.',
      action: { kind: 'settings' }, actionLabel: 'Open settings',
    });
  }
  if (f && can('budget.write')) {
    const done = f.itemCount > 0 && f.approvedItemCount >= f.itemCount;
    items.push({
      key: 'approved_amounts', label: 'Enter approved / finalized amounts', done,
      progress: f.itemCount ? of(f.approvedItemCount, f.itemCount) : null,
      detail: f.itemCount === 0 ? 'No budget items yet.' : done ? 'Every budget item has an approved amount.' : `${f.itemCount - f.approvedItemCount} budget item(s) still need an approved amount.`,
      action: { kind: 'section', section: 'budget' }, actionLabel: 'Open budget',
    });
  }
  if (can('materials.write')) {
    const needs = m.responsibilityNeedsConfirmation ?? 0;
    items.push({
      key: 'responsibilities', label: 'Assign supply responsibility', done: m.total > 0 && needs === 0,
      progress: m.total ? of(m.total - needs, m.total) : null,
      detail: m.total === 0 ? 'No material lines yet.' : needs ? `${needs} line(s) still marked Needs confirmation.` : 'Every line has an owner or contractor responsibility.',
      action: needs ? { kind: 'href', href: `#/materials/${d.project.id}/filter:responsibility` } : { kind: 'section', section: 'materials' },
      actionLabel: needs ? 'Show these lines' : 'Open materials',
    });
    const dated = m.withDate ?? 0;
    items.push({
      key: 'delivery_dates', label: 'Enter material dates', done: m.total > 0 && dated >= m.total,
      progress: m.total ? of(dated, m.total) : null,
      detail: m.total === 0 ? 'No material lines yet.' : dated >= m.total ? 'Every line has a required-on-site or delivery date.' : `${m.total - dated} line(s) have no required-on-site or delivery date.`,
      action: m.total > dated ? { kind: 'href', href: `#/materials/${d.project.id}/filter:no-date` } : { kind: 'section', section: 'materials' },
      actionLabel: m.total > dated ? 'Show these lines' : 'Open materials',
    });
  }
  if (can('timeline.write')) {
    const sched = t.scheduled ?? 0;
    items.push({
      key: 'timeline', label: 'Schedule timeline tasks', done: t.total > 0 && sched >= t.total,
      progress: t.total ? of(sched, t.total) : null,
      detail: t.total === 0 ? 'No timeline tasks yet.' : sched >= t.total ? 'Every task has planned dates.' : `${t.total - sched} task(s) have no planned start or finish.`,
      action: { kind: 'section', section: 'timeline' }, actionLabel: 'Open timeline',
    });
  }
  if (can('links.edit')) {
    const n = (d.project.hasDriveLink ? 1 : 0) + (d.project.hasSheetLink ? 1 : 0);
    items.push({
      key: 'links', label: 'Add Drive folder and Google Sheet links', done: n === 2, progress: of(n, 2),
      detail: n === 2 ? 'Both links are set.' : [!d.project.hasDriveLink && 'Drive folder', !d.project.hasSheetLink && 'Google Sheet'].filter(Boolean).join(' and ') + ' not linked yet.',
      action: { kind: 'settings' }, actionLabel: 'Add links',
    });
  }
  return items;
}

export type Severity = 'critical' | 'warning';
export interface AttentionItem {
  key: string;
  severity: Severity;
  /** issue type, always shown as text so status never relies on colour alone */
  tag: string;
  title: string;
  /** due date / days overdue or the reason */
  detail: string;
  who?: string;
  href: string;
  actionLabel: string;
  /** days overdue (0 when not overdue), used for ordering */
  days: number;
}

const daysSince = (from: string | null, today: string) => (from ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5)) : 0);

/**
 * Actionable items from saved records, critical first, then by days overdue. Every item links to its
 * record in the current project. Overdue payments only appear for roles with financial access (the
 * API leaves finance out otherwise); tasks and visits only when the API returned them for the role.
 */
export function buildAttention(d: DashboardData, opts: { formatDate: (iso: string | null) => string; formatMoney: (n: number) => string; milestone?: Milestone }): AttentionItem[] {
  const pid = d.project.id;
  const today = d.today ?? '';
  const out: AttentionItem[] = [];
  for (const x of d.finance?.overduePayments ?? []) {
    const days = daysSince(x.due_date, today);
    out.push({ key: `pay-${x.id}`, severity: 'critical', tag: 'Overdue payment', title: `${x.payee_name} — ${x.description}`,
      detail: `Due ${opts.formatDate(x.due_date)}${days ? ` · ${days} day${days === 1 ? '' : 's'} overdue` : ''} · ${opts.formatMoney(x.pending)} outstanding`,
      who: x.payee_name, href: `#/payments/${pid}/${x.id}`, actionLabel: 'View payment', days });
  }
  for (const x of d.materials.overdue) {
    const days = daysSince(x.date, today);
    out.push({ key: `mat-${x.id}`, severity: 'critical', tag: 'Overdue delivery', title: x.description,
      detail: `${x.category} · ${x.basis} ${opts.formatDate(x.date)}${days ? ` · ${days} day${days === 1 ? '' : 's'} overdue` : ''}`,
      href: `#/materials/${pid}/${x.id}`, actionLabel: 'Open material', days });
  }
  for (const t of (d.tasks ?? []).filter((x) => x.status === 'Blocked' || x.status === 'On Hold')) {
    out.push({ key: `task-${t.id}`, severity: 'warning', tag: t.status === 'Blocked' ? 'Blocked task' : 'Task on hold', title: t.name,
      detail: t.planned_start || t.planned_end ? `Planned ${opts.formatDate(t.planned_start)} → ${opts.formatDate(t.planned_end)}` : 'Not scheduled',
      who: t.assigned || undefined, href: `#/timeline/${pid}/${t.id}`, actionLabel: 'View task', days: 0 });
  }
  const m = opts.milestone;
  if (m && m.kind === 'next') {
    if (m.inDays <= (d.upcomingDays ?? 14) - 1) {
      out.push({ key: `ms-${m.task.id}`, severity: 'warning', tag: 'Approaching milestone', title: m.task.name,
        detail: `Inspection hold point planned ${opts.formatDate(m.date)} · ${m.inDays === 0 ? 'today' : `in ${m.inDays} day${m.inDays === 1 ? '' : 's'}`}`,
        who: m.task.assigned || undefined, href: `#/timeline/${pid}/${m.task.id}`, actionLabel: 'View task', days: 0 });
    }
    if (m.blockers.length) {
      out.push({ key: `msdep-${m.task.id}`, severity: 'warning', tag: 'Milestone waits for a blocked task', title: m.task.name,
        detail: `Planned ${opts.formatDate(m.date)} · waits for ${m.blockers.map((b) => `${b.name} (${b.status.toLowerCase()})`).join(', ')}`,
        who: m.task.assigned || undefined, href: `#/timeline/${pid}/${m.blockers[0].id}`, actionLabel: 'View blocked task', days: 0 });
    }
  }
  for (const v of d.consultantReportsMissing ?? []) {
    out.push({ key: `rep-${v.id}`, severity: 'warning', tag: 'Consultant report not attached', title: v.purpose,
      detail: `Visit completed ${opts.formatDate(v.date)} · no consultant report uploaded`, who: v.who || undefined,
      href: `#/consultant/${pid}/${v.id}`, actionLabel: 'Open visit', days: 0 });
  }
  if (d.materials.awaitingConfirmation) {
    out.push({ key: 'await', severity: 'warning', tag: 'Awaiting confirmation', title: `${d.materials.awaitingConfirmation} material line(s) awaiting confirmation`,
      detail: 'Status not confirmed, awaiting approval, quotation or supplier confirmation.', href: `#/materials/${pid}/filter:awaiting`, actionLabel: 'Show these lines', days: 0 });
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1 };
  return out.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.severity] - rank[b.x.severity] || b.x.days - a.x.days || a.i - b.i).map(({ x }) => x);
}
