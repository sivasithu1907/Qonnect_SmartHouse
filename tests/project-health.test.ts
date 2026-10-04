// Setup checklist, "Needs attention" and project search: derived only from saved data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAttention, buildSetupChecklist, type DashboardData } from '../src/lib/projectHealth';
import { filterProjects } from '../src/components/Header';
import { nextMilestone, type DashTask } from '../src/lib/dashboard';
import { capabilitiesFor } from '../server/permissions';
import type { Project } from '../src/lib/types';
import { setup, type Ctx } from './helpers';

const canFor = (role: Parameters<typeof capabilitiesFor>[0]) => { const c = capabilitiesFor(role) as string[]; return (x: string) => c.includes(x); };
const fmt = { formatDate: (x: string | null) => x ?? '—', formatMoney: (n: number) => `QAR ${n}` };
const base = (over: Partial<DashboardData> = {}): DashboardData => ({
  project: { id: 'p1', hasDriveLink: false, hasSheetLink: false, archived_at: null },
  finance: { controlBudget: null, controlBudgetConfirmed: false, approvedItemCount: 0, itemCount: 19, overduePayments: [] },
  materials: { total: 40, awaitingConfirmation: 39, responsibilityNeedsConfirmation: 18, withDate: 4, overdue: [] },
  timeline: { total: 47, scheduled: 0, phases: [] },
  ...over,
});

describe('setup checklist', () => {
  it('admin sees every step; nothing is complete without saved data', () => {
    const items = buildSetupChecklist(base(), canFor('admin'));
    expect(items.map((i) => i.key)).toEqual(['control_budget', 'approved_amounts', 'responsibilities', 'delivery_dates', 'timeline', 'links']);
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items.find((i) => i.key === 'approved_amounts')!.progress).toBe('0 of 19');
    expect(items.find((i) => i.key === 'responsibilities')!.progress).toBe('22 of 40');
    expect(items.find((i) => i.key === 'delivery_dates')!.progress).toBe('4 of 40');
    expect(items.find((i) => i.key === 'timeline')!.detail).toBe('47 task(s) have no planned start or finish.');
    // incomplete material steps link straight to the lines that need attention
    expect(items.find((i) => i.key === 'responsibilities')!.action).toEqual({ kind: 'href', href: '#/materials/p1/filter:responsibility' });
    expect(items.find((i) => i.key === 'delivery_dates')!.action).toEqual({ kind: 'href', href: '#/materials/p1/filter:no-date' });
  });

  it('an entered but unconfirmed control budget is not complete', () => {
    const d = base({ finance: { ...base().finance!, controlBudget: 500000, controlBudgetConfirmed: false } });
    const cb = buildSetupChecklist(d, canFor('admin')).find((i) => i.key === 'control_budget')!;
    expect(cb.done).toBe(false);
    expect(cb.detail).toBe('Entered but not confirmed.');
  });

  it('steps complete only when every record has the saved value', () => {
    const d = base({
      project: { id: 'p1', hasDriveLink: true, hasSheetLink: true },
      finance: { controlBudget: 1, controlBudgetConfirmed: true, approvedItemCount: 19, itemCount: 19, overduePayments: [] },
      materials: { total: 40, awaitingConfirmation: 0, responsibilityNeedsConfirmation: 0, withDate: 40, overdue: [] },
      timeline: { total: 47, scheduled: 47, phases: [] },
    });
    expect(buildSetupChecklist(d, canFor('admin')).every((i) => i.done)).toBe(true);
    // empty lists are not "done"
    const empty = base({ materials: { total: 0, awaitingConfirmation: 0, responsibilityNeedsConfirmation: 0, withDate: 0, overdue: [] }, timeline: { total: 0, scheduled: 0, phases: [] } });
    const e = buildSetupChecklist(empty, canFor('admin'));
    expect(e.find((i) => i.key === 'delivery_dates')!.done).toBe(false);
    expect(e.find((i) => i.key === 'timeline')!.detail).toBe('No timeline tasks yet.');
  });

  it('only lists steps the user can complete; read-only roles and archived projects get none', () => {
    expect(buildSetupChecklist(base(), canFor('project_manager')).map((i) => i.key)).toEqual(['responsibilities', 'delivery_dates', 'timeline', 'links']);
    expect(buildSetupChecklist(base(), canFor('viewer'))).toEqual([]);
    expect(buildSetupChecklist(base(), canFor('contractor'))).toEqual([]);
    expect(buildSetupChecklist(base({ project: { id: 'p1', archived_at: '2026-01-01' } }), canFor('admin'))).toEqual([]);
  });
});

describe('needs attention', () => {
  const task = (id: string, status: string, over: Partial<DashTask> = {}): DashTask => ({ id, phase_id: 'ph', name: `Task ${id}`, status, planned_start: '2026-10-20', planned_end: '2026-10-30', is_hold_point: false, depends_on: [], assigned: 'MEP subcontractor', notes: '', ...over });
  it('lists critical items first (most overdue first), each with a severity, a label and a link to the record', () => {
    const tasks = [task('t1', 'Blocked'), task('t2', 'Scheduled', { is_hold_point: true, planned_start: '2026-10-25', planned_end: '2026-10-26', depends_on: ['t1'] })];
    const d = base({
      today: '2026-10-15',
      materials: { total: 3, awaitingConfirmation: 2, overdue: [{ id: 'm1', description: 'Ceramic tiles', category: 'Tiles', date: '2026-10-10', basis: 'Planned' }] },
      finance: { ...base().finance!, overduePayments: [{ id: 'x1', payee_name: 'Contractor', description: 'Milestone 1', due_date: '2026-10-01', pending: 600 }] },
      tasks,
      consultantReportsMissing: [{ id: 'v1', date: '2026-10-08', purpose: 'Backfill inspection', who: 'Consultant' }],
    });
    const a = buildAttention(d, { ...fmt, milestone: nextMilestone(tasks, '2026-10-15') });
    expect(a.map((i) => i.key)).toEqual(['pay-x1', 'mat-m1', 'task-t1', 'ms-t2', 'msdep-t2', 'rep-v1', 'await']);
    expect(a[0]).toMatchObject({ severity: 'critical', tag: 'Overdue payment', href: '#/payments/p1/x1', actionLabel: 'View payment', days: 14 });
    expect(a[0].detail).toContain('14 days overdue');
    expect(a[1]).toMatchObject({ tag: 'Overdue delivery', href: '#/materials/p1/m1', actionLabel: 'Open material', days: 5 });
    expect(a[2]).toMatchObject({ severity: 'warning', tag: 'Blocked task', href: '#/timeline/p1/t1', who: 'MEP subcontractor' });
    expect(a[3]).toMatchObject({ tag: 'Approaching milestone', href: '#/timeline/p1/t2' });
    expect(a[4]).toMatchObject({ tag: 'Milestone waits for a blocked task', href: '#/timeline/p1/t1' });
    expect(a[5]).toMatchObject({ tag: 'Consultant report not attached', href: '#/consultant/p1/v1', actionLabel: 'Open visit' });
    expect(a[6].href).toBe('#/materials/p1/filter:awaiting');
    expect(a.every((i) => i.tag.length > 0 && i.actionLabel.length > 0)).toBe(true);
  });

  it('has no finance items without finance access and lists every record (the panel shows "Showing X of Y")', () => {
    const overdue = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, description: `Line ${i}`, category: 'C', date: '2026-09-01', basis: 'Planned' }));
    const a = buildAttention(base({ finance: null, materials: { total: 7, awaitingConfirmation: 0, overdue }, timeline: { total: 0, scheduled: 0, phases: [] } }), fmt);
    expect(a.filter((i) => /^mat-m\d/.test(i.key))).toHaveLength(7);
    expect(a.some((i) => i.key.startsWith('pay'))).toBe(false);
  });

  it('is empty when nothing is overdue, blocked or waiting', () => {
    expect(buildAttention(base({ materials: { total: 1, awaitingConfirmation: 0, overdue: [] }, timeline: { total: 2, scheduled: 2, phases: [{ blocked: 0 }] } }), fmt)).toEqual([]);
  });
});

describe('project search', () => {
  const p = (id: string, name: string, code: string, archived = false) => ({ id, name, code, location: 'Doha', archived_at: archived ? '2026-01-01' : null }) as unknown as Project;
  const list = [p('1', 'Umm Garn', 'PIN 70153699'), p('2', 'Umm Garn', 'PIN 70153016', true), p('3', 'Lusail Villa', 'PIN 1234')];
  it('matches name or code, case-insensitively, and keeps archived projects separate', () => {
    expect(filterProjects(list, '').active.map((x) => x.id)).toEqual(['1', '3']);
    expect(filterProjects(list, '').archived.map((x) => x.id)).toEqual(['2']);
    expect(filterProjects(list, 'umm').active.map((x) => x.id)).toEqual(['1']);
    expect(filterProjects(list, '70153016').archived.map((x) => x.id)).toEqual(['2']);
    expect(filterProjects(list, 'pin 1234').active.map((x) => x.id)).toEqual(['3']);
    expect(filterProjects(list, 'zzz')).toEqual({ active: [], archived: [] });
  });
});

describe('dashboard API exposes the setup counts from saved records', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup(); });
  afterAll(async () => { await ctx.close(); });

  it('counts match the stored material lines and timeline tasks', async () => {
    const admin = await ctx.agent('admin');
    const P = `/api/projects/${ctx.projects.p1}`;
    const d = (await admin.get(`${P}/dashboard`)).body;
    const items = (await admin.get(`${P}/materials`)).body.items.filter((m: any) => !m.archived_at);
    const tasks = (await admin.get(`${P}/timeline`)).body.tasks;
    expect(d.materials.responsibilityNeedsConfirmation).toBe(items.filter((m: any) => m.supply_responsibility === 'needs_confirmation').length);
    const dated = items.filter((m: any) => m.required_on_site_date || m.planned_delivery_date || m.confirmed_delivery_date || m.revised_delivery_date || m.actual_delivery_date).length;
    expect(d.materials.withDate).toBe(dated);
    expect(d.timeline.scheduled).toBe(tasks.filter((t: any) => t.planned_start || t.planned_end).length);
    expect(typeof d.project.hasDriveLink).toBe('boolean');
    // entering a date through the normal route moves the count by one
    const target = items.find((m: any) => !m.required_on_site_date && !m.planned_delivery_date && !m.confirmed_delivery_date && !m.revised_delivery_date && !m.actual_delivery_date);
    if (target) {
      expect((await admin.patch(`${P}/materials/${target.id}`, { planned_delivery_date: '2026-11-01' })).status).toBe(200);
      expect((await admin.get(`${P}/dashboard`)).body.materials.withDate).toBe(dated + 1);
    }
  });

  it('viewers get the same data without finance, and the checklist is empty for them', async () => {
    const v = await ctx.agent('viewer');
    const d = (await v.get(`/api/projects/${ctx.projects.p1}/dashboard`)).body;
    expect(buildSetupChecklist(d, canFor('viewer'))).toEqual([]);
  });
});
