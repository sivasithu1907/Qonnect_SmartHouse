// Dashboard calculations: task / phase completion, milestones, finance overview and checklist counts.
import { describe, expect, it } from 'vitest';
import { checklistCounts, financeOverview, nextMilestone, pctLabel, phaseSummaries, taskCompletion, upcomingMatches, type DashTask, type UpcomingItem } from '../src/lib/dashboard';

const t = (id: string, phase: string, status: string, over: Partial<DashTask> = {}): DashTask => ({
  id, phase_id: phase, name: `Task ${id}`, status, planned_start: null, planned_end: null, is_hold_point: false, depends_on: [], assigned: '', notes: '', ...over,
});
const phase = (id: string, seq: number, over: Record<string, unknown> = {}) => ({ id, seq, name: `Phase ${seq}`, schedule_approved: false, planned_start: null, planned_end: null, total: 0, completed: 0, ...over });

describe('task completion', () => {
  it('is completed / applicable tasks, never an average of phase percentages', () => {
    // phase A: 1 of 1 (100%), phase B: 1 of 3 (33%) → overall 2 of 4 = 50%, not the 67% average
    const tasks = [t('a1', 'A', 'Completed'), t('b1', 'B', 'Completed'), t('b2', 'B', 'In Progress'), t('b3', 'B', 'Blocked')];
    const c = taskCompletion(tasks);
    expect(c).toMatchObject({ done: 2, total: 4, pct: '50%', inProgress: 1, blocked: 1, open: 2 });
    const ph = phaseSummaries([phase('A', 1), phase('B', 2)], tasks);
    expect(ph.map((p) => pctLabel(p.done, p.tasks.length))).toEqual(['100%', '33%']);
  });
  it('shows no percentage without tasks and never rounds to 0% / 100% wrongly', () => {
    expect(taskCompletion([]).pct).toBeNull();
    expect(pctLabel(0, 0)).toBeNull();
    expect(pctLabel(1, 300)).toBe('<1%');
    expect(pctLabel(299, 300)).toBe('99%');
    expect(pctLabel(0, 5)).toBe('0%');
    expect(pctLabel(5, 5)).toBe('100%');
  });
});

describe('phase summaries', () => {
  it('derives status only from task statuses and prefers the phase’s own planned dates', () => {
    const tasks = [
      t('1', 'A', 'Completed'), t('2', 'A', 'Completed'),
      t('3', 'B', 'Completed'), t('4', 'B', 'Scheduled', { planned_start: '2026-11-01', planned_end: '2026-11-20' }),
      t('5', 'C', 'Scheduled', { planned_start: '2026-12-01', planned_end: '2026-12-10' }), t('6', 'C', 'Scheduled', { planned_start: '2026-12-05', planned_end: '2026-12-31' }),
      t('7', 'D', 'Not Scheduled'),
      t('8', 'E', 'On Hold'),
    ];
    const ph = phaseSummaries([phase('A', 1), phase('B', 2, { planned_start: '2026-10-01', planned_end: '2026-11-30' }), phase('C', 3), phase('D', 4), phase('E', 5), phase('F', 6)], tasks);
    expect(ph.map((p) => p.status)).toEqual(['Completed', 'In progress', 'Scheduled', 'Not scheduled', 'In progress', 'No tasks']);
    expect(ph[1]).toMatchObject({ start: '2026-10-01', end: '2026-11-30', datesFrom: 'phase' });
    expect(ph[2]).toMatchObject({ start: '2026-12-01', end: '2026-12-31', datesFrom: 'tasks' });
    expect(ph[3]).toMatchObject({ start: null, end: null, datesFrom: null });
    expect(ph[4].onHold).toBe(1);
  });
});

describe('next milestone', () => {
  it('is the earliest open hold point dated today or later; blockers are blocked / on-hold direct dependencies', () => {
    const tasks = [
      t('p', 'A', 'Blocked'),
      t('h1', 'A', 'Completed', { is_hold_point: true, planned_end: '2026-10-20' }),
      t('h2', 'A', 'Scheduled', { is_hold_point: true, planned_end: '2026-12-16', depends_on: ['p'] }),
      t('h3', 'A', 'Scheduled', { is_hold_point: true, planned_start: '2026-10-25', planned_end: '2026-10-26' }),
      t('h4', 'A', 'Scheduled', { is_hold_point: true, planned_end: '2026-10-01' }), // date passed: not "next"
    ];
    const m = nextMilestone(tasks, '2026-10-15');
    expect(m).toMatchObject({ kind: 'next', date: '2026-10-26', inDays: 11 });
    expect(m && m.kind === 'next' && m.task.id).toBe('h3');
    const m2 = nextMilestone(tasks.filter((x) => x.id !== 'h3'), '2026-10-15');
    expect(m2 && m2.kind === 'next' && m2.blockers.map((b) => b.id)).toEqual(['p']);
  });
  it('reports unscheduled hold points instead of inventing a date', () => {
    expect(nextMilestone([t('h', 'A', 'Not Scheduled', { is_hold_point: true })], '2026-10-15')).toEqual({ kind: 'unscheduled', count: 1 });
    expect(nextMilestone([t('x', 'A', 'Scheduled')], '2026-10-15')).toBeNull();
  });
});

describe('finance overview', () => {
  const f = (over: Record<string, unknown> = {}) => ({ controlBudget: 1800000, controlBudgetConfirmed: true, paid: 765000, pending: 143500, overdue: 15000, overdueCount: 1, transactionCount: 4, unpaidCount: 3, ...over });
  it('remaining = confirmed control budget − actual paid; scheduled unpaid is not deducted and overdue is a subset', () => {
    const o = financeOverview(f());
    expect(o).toMatchObject({ confirmed: true, remaining: 1035000, over: 0, unpaid: 143500, overdue: 15000 });
    expect(o.spentPct).toBeCloseTo(42.5, 5);
    expect(o.overdue).toBeLessThanOrEqual(o.unpaid);
  });
  it('spending above budget shows the exact over-budget amount and percentage', () => {
    const o = financeOverview(f({ paid: 1912400 }));
    expect(o.remaining).toBe(-112400);
    expect(o.over).toBe(112400);
    expect(o.spentPct!.toFixed(1)).toBe('106.2');
  });
  it('unconfirmed or missing budgets show no remaining or percentage; a zero budget avoids division by zero', () => {
    expect(financeOverview(f({ controlBudgetConfirmed: false }))).toMatchObject({ confirmed: false, remaining: null, spentPct: null, over: 0 });
    expect(financeOverview(f({ controlBudget: null, controlBudgetConfirmed: true }))).toMatchObject({ confirmed: false, remaining: null });
    const z = financeOverview(f({ controlBudget: 0, paid: 0 }));
    expect(z).toMatchObject({ confirmed: true, remaining: 0, spentPct: null });
    expect(financeOverview(f({ controlBudget: 0, paid: 50 }))).toMatchObject({ over: 50, spentPct: null });
  });
  it('uses cent arithmetic (no floating point drift)', () => {
    expect(financeOverview(f({ controlBudget: 0.3, paid: 0.1 })).remaining).toBe(0.2);
  });
});

describe('checklist counts', () => {
  it('excludes Not applicable and archived items from the denominator and counts N/A separately', () => {
    const c = checklistCounts([{ done: true }, { done: false }], [
      { status: 'Completed' }, { status: 'In progress' }, { status: 'Not applicable' }, { status: 'Completed', archived_at: '2026-10-01' }, { status: 'Awaiting review' },
    ]);
    expect(c).toMatchObject({ setupDone: 1, setupTotal: 2, preDone: 1, preApplicable: 3, notApplicable: 1, done: 2, total: 5, remaining: 3, pct: '40%' });
  });
  it('shows no percentage when nothing is applicable', () => {
    expect(checklistCounts([], [{ status: 'Not applicable' }])).toMatchObject({ total: 0, pct: null, notApplicable: 1 });
  });
});

describe('upcoming tabs and search', () => {
  const i = (kind: UpcomingItem['kind'], title: string, who = ''): UpcomingItem => ({ key: title, kind, id: title, date: '2026-10-16', dateLabel: 'Planned delivery', title, context: '', who, status: 'Ordered', href: '#' });
  const items = [i('material', 'Ceramic tiles', 'Owner supply'), i('task', 'Blockwork'), i('consultant_visit', 'Column inspection'), i('site_visit', 'Site walk')];
  it('filters by tab and searches title, party, status and date type', () => {
    expect(items.filter((x) => upcomingMatches(x, 'visits', '')).map((x) => x.title)).toEqual(['Column inspection', 'Site walk']);
    expect(items.filter((x) => upcomingMatches(x, 'all', 'owner')).map((x) => x.title)).toEqual(['Ceramic tiles']);
    expect(items.filter((x) => upcomingMatches(x, 'tasks', 'tiles'))).toEqual([]);
  });
});

describe('phase display names', () => {
  it('uses short labels for template phases, shortens other names, and never changes the stored name', async () => {
    const { phaseDisplayName } = await import('../src/lib/dashboard');
    expect(phaseDisplayName('Project setup, scope review, budget confirmation, and contractor/consultant responsibilities')).toBe('Project setup');
    expect(phaseDisplayName('Integrated testing, defects/snags, rectification, final consultant inspection, document handover, and owner acceptance')).toBe('Testing & handover');
    expect(phaseDisplayName('Landscaping, irrigation')).toBe('Landscaping');
    expect(phaseDisplayName('Short name')).toBe('Short name');
    expect(phaseDisplayName('An unusually long custom phase name without any commas at all here').endsWith('…')).toBe(true);
  });
});

describe('date headings and material date lines', () => {
  it('formats date-only headings without time-zone shifts and groups consecutive dates', async () => {
    const { dateHeading, groupByDate } = await import('../src/lib/dashboard');
    expect(dateHeading('2026-10-10')).toBe('10 Oct 2026 · Saturday');
    expect(groupByDate([{ date: '2026-10-10' }, { date: '2026-10-10' }, { date: '2026-10-11' }]).map((g) => g.items.length)).toEqual([2, 1]);
  });
  it('material date lines: planned delivery, planned completion, and previous dates awaiting review', async () => {
    const { upcomingDateLine } = await import('../src/lib/dashboard');
    const base = { key: 'k', kind: 'material' as const, id: '1', date: '2026-10-10', title: 't', context: '', who: '', status: 'Ordered', href: '#' };
    expect(upcomingDateLine({ ...base, workflow: 'owner', dateLabel: 'Planned delivery' })).toEqual({ label: 'Planned delivery', delivery: null });
    expect(upcomingDateLine({ ...base, workflow: 'contractor', dateLabel: 'Planned completion' })).toEqual({ label: 'Planned completion', delivery: null });
    expect(upcomingDateLine({ ...base, workflow: 'owner', legacy: true, dateLabel: 'Required on site (previous date)' })).toEqual({ label: 'Required on site (previous date)', delivery: 'Dates need review in Material Supply' });
    expect(upcomingDateLine({ ...base, kind: 'task', dateLabel: 'Planned start' })).toEqual({ label: 'Planned start', delivery: null });
  });
});
