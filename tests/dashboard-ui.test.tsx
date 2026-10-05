// Dashboard UI (server-side render): compact overview, finance states, phase cards, grouped
// upcoming activity, attention counts, checklist sections — and the existing colour palette.
import { describe, expect, it } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinanceOverview } from '../src/components/dashboard/FinanceOverview';
import { PhaseDetails, PhaseTracker, ProjectOverview } from '../src/components/dashboard/ProjectOverview';
import { UpcomingPanel } from '../src/components/dashboard/UpcomingPanel';
import { checklistPrefKey, ProjectChecklist } from '../src/components/dashboard/ProjectChecklist';
import { NeedsAttention, SetupRow } from '../src/components/ProjectHealth';
import { InfoPopover } from '../src/components/InfoPopover';
import { financeOverview, phaseSummaries, type DashTask, type UpcomingItem } from '../src/lib/dashboard';
import type { AttentionItem, SetupItem } from '../src/lib/projectHealth';
import { SessionContext, type Session } from '../src/lib/session';
import { UiProvider } from '../src/components/ui';
import type { Project } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';
import { itemizedBudget } from '../shared/calc';
import { BudgetSummary } from '../src/pages/Budget';

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const noop = () => undefined;
const project = { id: 'p1', code: 'PIN 70153699', name: 'Umm Garn', location: 'Umm Garn', status: '', archived_at: null, planned_start_date: null, target_completion_date: null } as unknown as Project;
const fin = (over: Record<string, unknown> = {}) => financeOverview({ controlBudget: 1800000, controlBudgetConfirmed: true, paid: 765000, pending: 143500, overdue: 15000, overdueCount: 1, transactionCount: 4, unpaidCount: 3, ...over });
const session = (role: 'admin' | 'contractor'): Session => {
  const caps = capabilitiesFor(role) as string[];
  return { user: { id: 'u1', email: 'u@x', name: 'u', role }, capabilities: caps, can: (c) => caps.includes(c), logout: noop };
};
const task = (id: string, phase: string, status: string, over: Partial<DashTask> = {}): DashTask => ({ id, phase_id: phase, name: `Task ${id}`, status, planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '', ...over });
const LONG1 = 'Structural frame, slabs, blockwork, roof, and building envelope';
const LONG2 = 'MEP first-fix: electrical conduits, plumbing, drainage, AC routes, and low-current conduits/cabling';
const overview = (over: Record<string, unknown> = {}) => renderToStaticMarkup(
  <ProjectOverview project={project} tasks={[]} phases={[]} milestone={null} upcomingDays={14} onOpenPhase={noop} onSettings={noop}
    canSettings canTimeline budgetUnconfirmed={null} canConfirmBudget {...over} />,
);

describe('compact project overview', () => {
  it('puts name, PIN and actions on top; missing data shows short messages with actions', () => {
    const h = overview({ budgetUnconfirmed: 'unconfirmed' });
    const t = text(h);
    expect(t).toMatch(/Umm Garn PIN 70153699.*Settings & links.*View timeline/);
    expect(t).toContain('No tasks yet');
    expect(t).toContain('Not set');
    expect(t).not.toMatch(/\d+%/);
    expect(t).toContain('Budget unconfirmed');
    expect(t).toContain('Open settings');
    expect(h).toContain('href="#/timeline/p1"');
    expect(text(overview({ budgetUnconfirmed: 'missing' }))).toContain('Budget not entered');
  });
  it('labels task completion, keeps the explanation in an accessible popover and lists concurrent phases with short names', () => {
    const tasks = [task('a', 'A', 'Completed'), task('b', 'A', 'In Progress'), task('c', 'B', 'Blocked'), task('d', 'B', 'Not Scheduled', { planned_start: '2026-11-01' })];
    const phases = phaseSummaries([
      { id: 'A', seq: 6, name: LONG1, schedule_approved: false, planned_start: null, planned_end: null, total: 2, completed: 1 },
      { id: 'B', seq: 8, name: LONG2, schedule_approved: false, planned_start: null, planned_end: null, total: 2, completed: 0 },
    ], tasks);
    const h = overview({ tasks, phases });
    const t = text(h);
    expect(t).toContain('Task completion');
    expect(t).toContain('25%');
    expect(t).toContain('1 of 4 tasks');
    expect(t).toContain('Current phases (2)');
    expect(t).toContain('6. Structure & envelope');
    expect(t).toContain('8. MEP first-fix');
    expect(h).toContain(`title="${LONG1}"`); // full stored name stays available
    expect(h).toContain('aria-label="About task completion"');
    expect(h).toContain('aria-expanded="false"');
    expect(t).not.toContain('Schedule not set'); // one task has a date
    expect(text(overview({ tasks: [task('x', 'A', 'Scheduled')] }))).toContain('Schedule not set');
  });
});

describe('info popover', () => {
  it('is a button with an accessible name; the text is not hover-only', () => {
    const h = renderToStaticMarkup(<InfoPopover label="About x">Explanation</InfoPopover>);
    expect(h).toMatch(/<button[^>]*aria-label="About x"[^>]*aria-expanded="false"/);
  });
});

describe('financial overview', () => {
  it('shows four prominent amounts and the overdue subset only when something is overdue', () => {
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin()} canConfirmBudget onSettings={noop} />));
    for (const s of ['Budget planning', 'Project budget', 'QAR 1,800,000.00', 'Payment tracking', 'Actual paid', 'QAR 765,000.00', 'Scheduled unpaid', 'QAR 143,500.00', 'Budget left after payments', 'QAR 1,035,000.00', 'Budget less recorded payments; unpaid commitments are not deducted.', '42.5%', 'QAR 765,000.00 of QAR 1,800,000.00', 'QAR 15,000.00 of the scheduled unpaid amount is overdue']) expect(t).toContain(s);
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ overdue: 0, overdueCount: 0 })} canConfirmBudget onSettings={noop} />))).not.toContain('overdue');
  });
  it('definitions live in info popovers, not paragraphs under the cards', () => {
    const h = renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin()} canConfirmBudget onSettings={noop} />);
    for (const l of ['About project budget', 'About actual paid', 'About scheduled unpaid', 'About budget left after payments']) expect(h).toContain(`aria-label="${l}"`);
    // a non-negative balance uses the normal text colour, not green
    expect(h).not.toMatch(/text-emerald-700[^"]*">QAR 1,035,000/);
    expect(text(h)).not.toContain('It is not uncommitted or available cash');
  });
  it('over budget: explicit amount and percentage', () => {
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ paid: 1912400 })} canConfirmBudget onSettings={noop} />));
    expect(t).toContain('Overspent: payments exceed the budget by QAR 112,400.00');
    expect(t).toContain('106.2%');
  });
  it('missing vs unconfirmed vs zero budgets stay distinct; one action for an unconfirmed budget', () => {
    const unconf = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ controlBudgetConfirmed: false })} canConfirmBudget onSettings={noop} />));
    expect(unconf).toContain('Needs confirmation');
    expect(unconf).toContain('Entered QAR 1,800,000.00');
    expect((unconf.match(/Confirm in settings/g) ?? []).length).toBe(1);
    expect(unconf).toContain('Needs a confirmed budget');
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ controlBudget: null, controlBudgetConfirmed: false })} canConfirmBudget={false} onSettings={noop} />))).toContain('Not entered');
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fin({ controlBudget: 0, paid: 0 })} canConfirmBudget onSettings={noop} />))).toContain('isn’t shown as a percentage');
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={null} canConfirmBudget onSettings={noop} />))).toContain('Financial figures are not available for your role');
  });
});

describe('phase tracker', () => {
  it('cards show phase number, short title, one status, tasks and dates only when available; full name in details', () => {
    const tasks = [task('a', 'A', 'Completed'), task('b', 'A', 'Not Scheduled'), task('c', 'B', 'Scheduled', { planned_start: '2026-11-01', planned_end: '2026-11-30' })];
    const phases = phaseSummaries([
      { id: 'A', seq: 1, name: LONG1, schedule_approved: false, planned_start: null, planned_end: null, total: 2, completed: 1 },
      { id: 'B', seq: 2, name: 'A custom phase name that is quite long, with details', schedule_approved: false, planned_start: null, planned_end: null, total: 1, completed: 0 },
    ], tasks);
    const h = renderToStaticMarkup(<PhaseTracker phases={phases} onOpenPhase={noop} />);
    const t = text(h);
    expect(h).toContain('overflow-x-auto');
    expect(t).toContain('Phase 1');
    expect(t).toContain('Structure & envelope');
    expect(t).toContain('A custom phase name that is quite…');
    expect(t).toContain('1/2 tasks');
    expect((t.match(/Not scheduled/g) ?? []).length).toBeLessThanOrEqual(1); // status badge only, no repeated date line
    expect(t).toContain('01/11/2026 → 30/11/2026');
    expect(h).toContain('aria-label="Previous phases"');
    const d = text(renderToStaticMarkup(<PhaseDetails projectId="p1" phase={phases[0]} allTasks={tasks} onClose={noop} />));
    expect(d).toContain(LONG1);
  });
});

describe('next 14 days', () => {
  const item = (over: Partial<UpcomingItem>): UpcomingItem => ({ key: Math.random().toString(), kind: 'material', id: '1', date: '2026-10-16', dateLabel: 'Planned delivery', title: 'Tiles', context: 'Tiles', who: 'Owner supply', status: 'Ordered', href: '#/materials/p1/1', ...over });
  it('groups by date heading, counts per tab, one Open action per row', () => {
    const items = [item({ key: 'a' }), item({ key: 'b', date: '2026-10-17', kind: 'task', dateLabel: 'Planned start', title: 'Blockwork' }), item({ key: 'c', date: '2026-10-17', kind: 'site_visit', dateLabel: 'Site visit', title: 'Walk' })];
    const h = renderToStaticMarkup(<UpcomingPanel projectId="p1" items={items} today="2026-10-16" days={14} can={() => true} />);
    const t = text(h);
    expect(t).toContain('16 Oct 2026 · Friday');
    expect(t).toContain('17 Oct 2026 · Saturday');
    expect((t.match(/17 Oct 2026 · Saturday/g) ?? []).length).toBe(1);
    expect(t).toMatch(/All 3/);
    expect(t).toMatch(/Materials 1/);
    expect(t).toMatch(/Visits & inspections 1/);
    expect((h.match(/>Open</g) ?? []).length).toBe(3);
  });
  it('a required-on-site date is labelled as such and never as a delivery; delivery state is shown separately', () => {
    const t = text(renderToStaticMarkup(<UpcomingPanel projectId="p1" today="2026-10-16" days={14} can={() => true} items={[
      item({ key: 'r', dateKind: 'required', dateLabel: 'Required on site', deliveryStatus: 'none', title: 'Granite' }),
      item({ key: 'p', dateKind: 'planned', deliveryStatus: 'unconfirmed', title: 'Porcelain', requiredOnSite: '2026-10-20' }),
      item({ key: 'c', dateKind: 'confirmed', dateLabel: 'Supplier-confirmed delivery', deliveryStatus: 'confirmed', title: 'Ceramic' }),
    ]} />));
    expect(t).toMatch(/Granite Required on site · Tiles · Owner supply · Delivery date not entered/);
    expect(t).toMatch(/Porcelain Planned delivery · Tiles · Owner supply · Not supplier-confirmed · needed on site 20\/10\/2026/);
    expect(t).toMatch(/Ceramic Supplier-confirmed delivery · Tiles · Owner supply Ordered/);
    expect(t).not.toMatch(/Granite[^·]*delivery ·/);
  });
  it('empty state', () => {
    expect(text(renderToStaticMarkup(<UpcomingPanel projectId="p1" items={[]} today="2026-10-15" days={14} can={() => true} />))).toContain('Nothing is dated in the next 14 days');
  });
});

describe('needs attention', () => {
  const a = (i: number, over: Partial<AttentionItem> = {}): AttentionItem => ({ key: `k${i}`, severity: 'warning', tag: 'Blocked task', title: `Item ${i}`, detail: 'd', href: `#/timeline/p1/t${i}`, actionLabel: 'View task', days: 0, count: 1, unit: 'task', ...over });
  it('summarises issues and affected records; grouped issues show their count', () => {
    const items = [a(1, { severity: 'critical', tag: 'Overdue payment', unit: 'payment' }), a(2, { key: 'await', tag: 'Awaiting confirmation', title: 'Material lines awaiting confirmation', count: 40, unit: 'material', actionLabel: 'Show these 40 lines' })];
    const t = text(renderToStaticMarkup(<NeedsAttention items={items} />));
    expect(t).toContain('2 issues · 1 payment, 40 materials');
    expect(t).toContain('40 materials');
    expect(t).toContain('Show these 40 lines');
    expect(t).toContain('Critical · Overdue payment');
    expect(text(renderToStaticMarkup(<NeedsAttention items={[a(1, { key: 'await', count: 40, unit: 'material' })]} />))).toContain('1 issue · 40 materials');
  });
  it('shows "Showing 6 of 8" with a show-all control; empty state', () => {
    const t = text(renderToStaticMarkup(<NeedsAttention items={Array.from({ length: 8 }, (_, i) => a(i))} />));
    expect(t).toContain('Showing 6 of 8');
    expect(t).toContain('Show all 8');
    expect(text(renderToStaticMarkup(<NeedsAttention items={[]} />))).toContain('Nothing overdue');
  });
});

describe('checklist', () => {
  const render = (role: 'admin' | 'contractor', setup: SetupItem[] = []) => text(renderToStaticMarkup(
    <SessionContext.Provider value={session(role)}><UiProvider>
      <ProjectChecklist project={project} setup={setup} phases={[]} today="2026-10-15" onSettings={noop} onNavigate={noop} />
    </UiProvider></SessionContext.Provider>,
  ));
  const step = (key: SetupItem['key'], done: boolean, count: SetupItem['count']): SetupItem => ({ key, label: key, done, progress: null, count, detail: 'detail', action: { kind: 'settings' }, actionLabel: 'Open settings' });
  it('two separately collapsible sections; setup counts steps and shows partial progress per step', () => {
    const t = render('admin', [step('responsibilities', false, { done: 22, total: 40, unit: 'assigned' }), step('delivery_dates', false, { done: 4, total: 40, unit: 'entered' }), step('timeline', false, { done: 0, total: 47, unit: 'tasks scheduled' }), step('control_budget', true, null)]);
    expect(t).toContain('Project setup');
    expect(t).toContain('1 of 4 steps complete');
    expect(t).toContain('22/40 assigned');
    expect(t).toContain('4/40 entered');
    expect(t).toContain('0/47 tasks scheduled');
    expect(t).toContain('does not indicate construction readiness');
    expect(t).toContain('Prerequisites & documents');
    expect(t).not.toMatch(/\d+% /); // no combined percentage
  });
  it('roles without access see a note; the preference key is per user, project and section', () => {
    expect(render('contractor')).toContain('Prerequisites are visible to admins, project managers and viewers');
    expect(checklistPrefKey('u1', 'p1', 'setup')).toBe('qonnect.dashboard.u1.p1.setup.open');
    expect(checklistPrefKey('u1', 'p2', 'setup')).not.toBe(checklistPrefKey('u1', 'p1', 'setup'));
  });
  it('setup row shows counts and its action', () => {
    const t = text(renderToStaticMarkup(<ul><SetupRow i={step('responsibilities', false, { done: 22, total: 40, unit: 'assigned' })} onSettings={noop} onNavigate={noop} /></ul>));
    expect(t).toContain('22/40 assigned');
    expect(t).toContain('Open settings');
  });
  it('every setup row and the section header share the same fixed columns, bar size and action size', () => {
    const rows = [step('responsibilities', false, { done: 22, total: 40, unit: 'assigned' }), step('control_budget', false, null), step('links', true, { done: 2, total: 2, unit: 'linked' })]
      .map((i) => renderToStaticMarkup(<ul><SetupRow i={i} onSettings={noop} onNavigate={noop} /></ul>));
    for (const h of rows) expect(h).toContain('md:grid-cols-[24px_minmax(0,1fr)_180px_140px]');
    // the row without numeric progress keeps an (empty) progress cell so the action stays aligned
    expect(rows[1]).toContain('md:col-start-3');
    expect(rows[1]).toContain('md:col-start-4');
    expect(rows[0]).toMatch(/max-w-\[180px\]/);
    expect(rows[0]).toContain('h-1.5 w-full');
    expect(rows[0]).toMatch(/h-9 w-full max-w-\[140px\]/);
    const header = renderToStaticMarkup(
      <SessionContext.Provider value={session('admin')}><UiProvider>
        <ProjectChecklist project={project} setup={[step('control_budget', false, null)]} phases={[]} today="2026-10-15" onSettings={noop} onNavigate={noop} />
      </UiProvider></SessionContext.Provider>,
    );
    expect(header).toContain('md:grid-cols-[minmax(0,1fr)_180px_140px]');
    expect(text(header)).toContain('0 of 1 steps complete');
  });
});

describe('colour palette', () => {
  it('dashboard components use only the existing palette (slate, sky, emerald, amber, rose) and no literal colours', () => {
    const files = ['src/pages/Dashboard.tsx', 'src/components/ProjectHealth.tsx', 'src/components/InfoPopover.tsx', ...fs.readdirSync('src/components/dashboard').map((f) => `src/components/dashboard/${f}`)];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![^"'`]*\})/);
      const families = [...src.matchAll(/\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline)-([a-z]+)-\d{2,3}\b/g)].map((m) => m[1]);
      expect(families.filter((x) => !['slate', 'sky', 'emerald', 'amber', 'rose'].includes(x)), f).toEqual([]);
    }
  });
});

describe('itemized budget display', () => {
  const it5 = (over: Record<string, unknown> = {}) => itemizedBudget({ finalizedSubtotal: 1201086.5, missingCount: 0, miscAllowance: 62858.65, controlBudget: 1000000, controlBudgetConfirmed: true, ...over });
  it('dashboard: five figures; itemized costs above budget are flagged as planned cost, not money spent, with a link to the budget page', () => {
    const f = financeOverview({ controlBudget: 1000000, controlBudgetConfirmed: true, paid: 0, pending: 0, overdue: 0, overdueCount: 0, itemized: it5() });
    const h = renderToStaticMarkup(<FinanceOverview projectId="p1" fin={f} canConfirmBudget onSettings={noop} />);
    const t = text(h);
    for (const s of ['Project budget', 'Total incl. miscellaneous', 'QAR 1,263,945.15', 'Actual paid', 'Scheduled unpaid', 'Budget left after payments', 'QAR 1,000,000.00']) expect(t).toContain(s);
    expect(t).toContain('Itemized costs are QAR 263,945.15 above budget (26.39%).');
    expect(t).toMatch(/Includes miscellaneous allowance\. Actual paid: QAR 0\.00 ?\./);
    expect(t).toContain('Review budget');
    expect(t).not.toContain('Overspent');
    expect(h).toContain('href="#/budget/p1"');
  });
  it('dashboard: below budget shows "Budget not allocated to items" only when complete', () => {
    const below = financeOverview({ controlBudget: 2000000, controlBudgetConfirmed: true, paid: 0, pending: 0, overdue: 0, overdueCount: 0, itemized: it5({ controlBudget: 2000000 }) });
    expect(text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={below} canConfirmBudget onSettings={noop} />))).toContain('Budget not allocated to items: QAR 736,054.85');
    const inc = financeOverview({ controlBudget: 2000000, controlBudgetConfirmed: true, paid: 0, pending: 0, overdue: 0, overdueCount: 0, itemized: it5({ controlBudget: 2000000, missingCount: 4 }) });
    const t = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={inc} canConfirmBudget onSettings={noop} />));
    expect(t).toContain('Incomplete: 4 items without a finalized amount');
    expect(t).not.toContain('Budget not allocated to items:');
  });
  it('budget page summary: subtotal + misc = grand total, control budget and the difference', () => {
    const s = { itemized: it5(), misc: { percentage: 10 }, byKind: [{ kind: 'fixed', subtotal: 572500, itemCount: 3, missingCount: 0 }, { kind: 'finishing', subtotal: 628586.5, itemCount: 16, missingCount: 0 }, { kind: 'other', subtotal: 0, itemCount: 0, missingCount: 0 }] } as any;
    const t = text(renderToStaticMarkup(<BudgetSummary s={s} onSettings={noop} canConfirmBudget miscCategoryNames={[]} />));
    expect(t).toMatch(/Fixed costs QAR 572,500\.00 Finishing items QAR 628,586\.50 Finalized items subtotal QAR 1,201,086\.50 Miscellaneous allowance .*QAR 62,858\.65 Grand total including miscellaneous QAR 1,263,945\.15 Confirmed control budget QAR 1,000,000\.00 Above budget QAR 263,945\.15/);
    expect(t).not.toContain('Edit %'); // the single Edit % control lives in the miscellaneous card
    expect(t).not.toContain('Other items');
    const inc = text(renderToStaticMarkup(<BudgetSummary s={{ ...s, itemized: it5({ missingCount: 2 }) }} onSettings={noop} canConfirmBudget={false} miscCategoryNames={['Misc works']} />));
    expect(inc).toContain('Incomplete');
    expect(inc).toContain('2 active items have no finalized amount');
    expect(inc).toContain('Above budget (at least)');
    expect(inc).toContain('“Misc works”');
  });
});

describe('budget warning edge cases', () => {
  const fo = (it: ReturnType<typeof itemizedBudget>, paid = 0) => financeOverview({ controlBudget: it.controlBudget, controlBudgetConfirmed: it.controlBudgetConfirmed, paid, pending: 0, overdue: 0, overdueCount: 0, itemized: it });
  it('incomplete totals qualify the overrun; a zero budget shows no percentage; no warning when not above budget', () => {
    const inc = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fo(itemizedBudget({ finalizedSubtotal: 1100000, missingCount: 2, miscAllowance: 0, controlBudget: 1000000, controlBudgetConfirmed: true }))} canConfirmBudget onSettings={noop} />));
    expect(inc).toContain('Itemized costs are at least QAR 100,000.00 above budget (10.00%).');
    expect(inc).toContain('2 items have no amount yet.');
    const zero = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fo(itemizedBudget({ finalizedSubtotal: 500, missingCount: 0, miscAllowance: 0, controlBudget: 0, controlBudgetConfirmed: true }))} canConfirmBudget onSettings={noop} />));
    expect(zero).toContain('Itemized costs are QAR 500.00 above budget.');
    expect(zero).not.toMatch(/above budget \(/);
    const ok = text(renderToStaticMarkup(<FinanceOverview projectId="p1" fin={fo(itemizedBudget({ finalizedSubtotal: 900000, missingCount: 0, miscAllowance: 0, controlBudget: 1000000, controlBudgetConfirmed: true }))} canConfirmBudget onSettings={noop} />));
    expect(ok).not.toContain('Itemized costs are');
  });
});
