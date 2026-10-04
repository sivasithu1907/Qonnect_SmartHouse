// Dashboard UI (server-side render): empty states, over-budget display, attention paging,
// upcoming tabs, checklist access — and that it keeps the application's existing colour palette.
import { describe, expect, it } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinanceOverview } from '../src/components/dashboard/FinanceOverview';
import { PhaseTracker, ProjectOverview } from '../src/components/dashboard/ProjectOverview';
import { UpcomingPanel } from '../src/components/dashboard/UpcomingPanel';
import { ProjectChecklist } from '../src/components/dashboard/ProjectChecklist';
import { NeedsAttention } from '../src/components/ProjectHealth';
import { financeOverview, phaseSummaries, type UpcomingItem } from '../src/lib/dashboard';
import type { AttentionItem } from '../src/lib/projectHealth';
import { SessionContext, type Session } from '../src/lib/session';
import { UiProvider } from '../src/components/ui';
import type { Project } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const project = { id: 'p1', code: 'PIN 70153699', name: 'Umm Garn', location: 'Umm Garn', status: '', archived_at: null, planned_start_date: null, target_completion_date: null } as unknown as Project;
const fin = (over: Record<string, unknown> = {}) => financeOverview({ controlBudget: 1800000, controlBudgetConfirmed: true, paid: 765000, pending: 143500, overdue: 15000, overdueCount: 1, transactionCount: 4, unpaidCount: 3, ...over });
const session = (role: 'admin' | 'contractor'): Session => {
  const caps = capabilitiesFor(role) as string[];
  return { user: { id: 'u', email: 'u@x', name: 'u', role }, capabilities: caps, can: (c) => caps.includes(c), logout: () => undefined };
};

describe('financial overview', () => {
  it('shows the four figures and the overdue subset', () => {
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin()} />));
    for (const s of ['Confirmed control budget', 'QAR 1,800,000.00', 'Actual paid', 'QAR 765,000.00', 'Scheduled unpaid', 'QAR 143,500.00', 'Budget remaining', 'QAR 1,035,000.00', '42.5%', 'QAR 15,000.00 of the scheduled unpaid amount is past due']) expect(t).toContain(s);
  });
  it('over budget: explicit amount and percentage', () => {
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ paid: 1912400 })} />));
    expect(t).toContain('Over budget by QAR 112,400.00');
    expect(t).toContain('106.2%');
  });
  it('unconfirmed budget: Needs confirmation and no remaining; no finance access: a notice', () => {
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ controlBudgetConfirmed: false })} />));
    expect(t).toContain('Needs confirmation');
    expect(t).toContain('Entered QAR 1,800,000.00 — not confirmed');
    expect(t).toContain('Shown once the control budget is confirmed');
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={null} />))).toContain('Financial figures are not available for your role');
  });
  it('links go to the selected project', () => {
    const h = renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin()} />);
    expect(h).toContain('href="#/payments/p1"');
    expect(h).toContain('href="#/budget/p1"');
  });
});

describe('overview and phases', () => {
  it('a project without tasks shows "No tasks yet" and "Not set" dates, not a percentage', () => {
    const t = text(renderToStaticMarkup(<ProjectOverview project={project} tasks={[]} phases={[]} milestone={null} upcomingDays={14} onOpenPhase={() => undefined} onSettings={() => undefined} canSettings={false} />));
    expect(t).toContain('No tasks yet');
    expect(t).toContain('Not set');
    expect(t).not.toMatch(/\d+%/);
    expect(t).toContain('not consultant-certified physical construction progress');
  });
  it('labels task completion and lists concurrent phases; the tracker scrolls inside itself', () => {
    const tasks = [
      { id: 'a', phase_id: 'A', name: 'x', status: 'Completed', planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '' },
      { id: 'b', phase_id: 'A', name: 'y', status: 'In Progress', planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '' },
      { id: 'c', phase_id: 'B', name: 'z', status: 'Blocked', planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '' },
      { id: 'd', phase_id: 'B', name: 'w', status: 'Not Scheduled', planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '' },
    ];
    const phases = phaseSummaries([
      { id: 'A', seq: 1, name: 'Setup', schedule_approved: false, planned_start: null, planned_end: null, total: 2, completed: 1 },
      { id: 'B', seq: 2, name: 'Design', schedule_approved: false, planned_start: null, planned_end: null, total: 2, completed: 0 },
    ], tasks);
    const h = renderToStaticMarkup(<ProjectOverview project={project} tasks={tasks} phases={phases} milestone={null} upcomingDays={14} onOpenPhase={() => undefined} onSettings={() => undefined} canSettings />);
    const t = text(h);
    expect(t).toContain('Task completion');
    expect(t).toContain('25%');
    expect(t).toContain('1 of 4 tasks completed');
    expect(t).toContain('2 phases have work in progress at the same time');
    const tr = renderToStaticMarkup(<PhaseTracker phases={phases} onOpenPhase={() => undefined} />);
    expect(tr).toContain('overflow-x-auto');
    expect(text(tr)).toContain('1 of 2 tasks');
    expect(text(tr)).toContain('Not scheduled');
  });
});

describe('needs attention and next 14 days', () => {
  it('shows "Showing 6 of 8" with a show-all control and a text label per item', () => {
    const items: AttentionItem[] = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, severity: i < 2 ? 'critical' : 'warning', tag: i < 2 ? 'Overdue payment' : 'Blocked task', title: `Item ${i}`, detail: 'd', href: `#/payments/p1/x${i}`, actionLabel: 'View payment', days: 0 }));
    const t = text(renderToStaticMarkup(<NeedsAttention items={items} />));
    expect(t).toContain('Showing 6 of 8');
    expect(t).toContain('Show all 8');
    expect(t).toContain('2 critical');
    expect(t).toContain('6 warning');
    expect(text(renderToStaticMarkup(<NeedsAttention items={[]} />))).toContain('Nothing overdue');
  });
  it('tab counts match the records and each row opens its record', () => {
    const it = (kind: UpcomingItem['kind'], n: number): UpcomingItem => ({ key: `${kind}${n}`, kind, id: `${n}`, date: '2026-10-16', dateLabel: 'Planned delivery', title: `T${n}`, context: '', who: '', status: 'Ordered', href: `#/x/p1/${n}` });
    const h = renderToStaticMarkup(<UpcomingPanel projectId="p1" items={[it('material', 1), it('material', 2), it('task', 3), it('site_visit', 4)]} today="2026-10-15" days={14} can={() => true} />);
    const t = text(h);
    expect(t).toMatch(/All 4/);
    expect(t).toMatch(/Materials 2/);
    expect(t).toMatch(/Tasks 1/);
    expect(t).toMatch(/Visits & Inspections 1/);
    expect((h.match(/>Open record</g) ?? []).length).toBe(4);
    expect(text(renderToStaticMarkup(<UpcomingPanel projectId="p1" items={[]} today="2026-10-15" days={14} can={() => true} />))).toContain('Nothing scheduled in the next 14 days');
  });
});

describe('checklist', () => {
  it('keeps setup separate from prerequisites; roles without access see a note instead of records', () => {
    const r = (role: 'admin' | 'contractor') => text(renderToStaticMarkup(
      <SessionContext.Provider value={session(role)}><UiProvider>
        <ProjectChecklist project={project} setup={[]} phases={[]} today="2026-10-15" onSettings={() => undefined} onNavigate={() => undefined} />
      </UiProvider></SessionContext.Provider>,
    ));
    const c = r('contractor');
    expect(c).toContain('Project setup');
    expect(c).toContain('Prerequisites & documents');
    expect(c).toContain('Prerequisites are visible to admins, project managers and viewers');
    expect(r('admin')).toContain('Add item');
    expect(r('admin')).toContain('separate from task completion');
  });
});

describe('colour palette', () => {
  it('dashboard components use only the existing palette (slate, sky, emerald, amber, rose) and no literal colours', () => {
    const files = ['src/pages/Dashboard.tsx', 'src/components/ProjectHealth.tsx', ...fs.readdirSync('src/components/dashboard').map((f) => `src/components/dashboard/${f}`)];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^"'`]*\})/);
      const families = [...src.matchAll(/\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline)-([a-z]+)-\d{2,3}\b/g)].map((m) => m[1]);
      expect(families.filter((x) => !['slate', 'sky', 'emerald', 'amber', 'rose'].includes(x)), f).toEqual([]);
    }
  });
});
