// Project setup checklist and "Needs attention" items, derived only from saved project data
// returned by /api/projects/:id/dashboard. Nothing is estimated or marked complete without data.
import type { Section } from './types';

export interface DashboardData {
  project: { id: string; hasDriveLink?: boolean; hasSheetLink?: boolean; archived_at?: string | null };
  finance: null | {
    controlBudget: number | null; controlBudgetConfirmed: boolean;
    approvedItemCount: number; itemCount: number;
    overduePayments: Array<{ id: string; payee_name: string; description: string; due_date: string | null; pending: number }>;
  };
  materials: {
    total: number; awaitingConfirmation: number; responsibilityNeedsConfirmation?: number; withDate?: number;
    overdue: Array<{ id: string; description: string; category: string; date: string | null; basis: string }>;
  };
  timeline: { total: number; scheduled?: number; phases: Array<{ blocked: number }> };
}

export interface SetupItem {
  key: 'control_budget' | 'approved_amounts' | 'responsibilities' | 'delivery_dates' | 'timeline' | 'links';
  label: string;
  done: boolean;
  /** e.g. "12 of 19" — counts of saved records; null when not a counted item */
  progress: string | null;
  detail: string;
  action: { kind: 'settings' } | { kind: 'section'; section: Section };
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
      action: { kind: 'section', section: 'materials' }, actionLabel: 'Open materials',
    });
    const dated = m.withDate ?? 0;
    items.push({
      key: 'delivery_dates', label: 'Enter material dates', done: m.total > 0 && dated >= m.total,
      progress: m.total ? of(dated, m.total) : null,
      detail: m.total === 0 ? 'No material lines yet.' : dated >= m.total ? 'Every line has a required-on-site or delivery date.' : `${m.total - dated} line(s) have no required-on-site or delivery date.`,
      action: { kind: 'section', section: 'materials' }, actionLabel: 'Open materials',
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

export interface AttentionItem {
  key: string;
  tone: 'overdue' | 'todo';
  /** text tag shown next to the item, so status never relies on colour alone */
  tag: string;
  title: string;
  detail: string;
  href: string;
}

/** Actionable items, most urgent first. Record items link straight to the record. */
export function buildAttention(d: DashboardData, opts: { maxRecords?: number; formatDate: (iso: string | null) => string; formatMoney: (n: number) => string }): AttentionItem[] {
  const pid = d.project.id;
  const max = opts.maxRecords ?? 4;
  const out: AttentionItem[] = [];
  const more = (n: number, what: string, href: string, key: string) => {
    if (n > 0) out.push({ key, tone: 'overdue', tag: 'Overdue', title: `${n} more ${what}`, detail: 'Open the list to see all.', href });
  };

  const od = d.materials.overdue;
  od.slice(0, max).forEach((x) => out.push({
    key: `mat-${x.id}`, tone: 'overdue', tag: 'Overdue delivery', title: x.description,
    detail: `${x.category} · expected ${opts.formatDate(x.date)} (${x.basis})`, href: `#/materials/${pid}/${x.id}`,
  }));
  more(od.length - max, 'overdue deliveries', `#/materials/${pid}`, 'mat-more');

  const op = d.finance?.overduePayments ?? [];
  op.slice(0, max).forEach((x) => out.push({
    key: `pay-${x.id}`, tone: 'overdue', tag: 'Overdue payment', title: `${x.payee_name} — ${x.description}`,
    detail: `due ${opts.formatDate(x.due_date)} · ${opts.formatMoney(x.pending)} pending`, href: `#/payments/${pid}/${x.id}`,
  }));
  more(op.length - max, 'overdue payments', `#/payments/${pid}`, 'pay-more');

  const blocked = d.timeline.phases.reduce((n, p) => n + (p.blocked ?? 0), 0);
  if (blocked) out.push({ key: 'blocked', tone: 'todo', tag: 'Blocked / on hold', title: `${blocked} timeline task(s) blocked or on hold`, detail: 'Check what is holding them up.', href: `#/timeline/${pid}` });
  if (d.materials.awaitingConfirmation) out.push({ key: 'await', tone: 'todo', tag: 'Awaiting confirmation', title: `${d.materials.awaitingConfirmation} material line(s) awaiting confirmation`, detail: 'Status not confirmed, awaiting approval, quotation or supplier confirmation.', href: `#/materials/${pid}` });
  const unsched = Math.max(0, d.timeline.total - (d.timeline.scheduled ?? 0));
  if (unsched) out.push({ key: 'unsched', tone: 'todo', tag: 'Not scheduled', title: `${unsched} timeline task(s) without planned dates`, detail: 'Open the Gantt view to see them by phase.', href: `#/timeline/${pid}` });
  return out;
}
