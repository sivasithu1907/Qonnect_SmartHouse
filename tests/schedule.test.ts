// Schedule (Material Supply) and Gantt (Timeline) views: date precedence, scheduled vs unscheduled
// entries, and that the views only read existing records under the existing permissions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedDeliveryDate, EXPECTED_DATE_LABELS } from '../shared/calc';
import {
  buildGantt, buildMaterialSchedule, entriesInPeriod, ganttRange, periodFor, plannedSpan, shiftPeriod, startOfWeek,
} from '../src/lib/schedule';
import type { MaterialItem, Phase, Task } from '../src/lib/types';
import { setup, type Ctx } from './helpers';
import { mat, phase, task } from './schedule-fixtures';

const blank = { revised_delivery_date: null, confirmed_delivery_date: null, planned_delivery_date: null, required_on_site_date: null };

describe('expected delivery date precedence', () => {
  it('revised > supplier-confirmed > planned > required on site, and never uses the actual date', () => {
    const all = { revised_delivery_date: '2026-11-05', confirmed_delivery_date: '2026-11-03', planned_delivery_date: '2026-11-01', required_on_site_date: '2026-10-30' };
    expect(expectedDeliveryDate(all)).toEqual({ date: '2026-11-05', kind: 'revised', label: 'Revised delivery' });
    expect(expectedDeliveryDate({ ...all, revised_delivery_date: null })).toEqual({ date: '2026-11-03', kind: 'confirmed', label: 'Supplier-confirmed delivery' });
    expect(expectedDeliveryDate({ ...all, revised_delivery_date: null, confirmed_delivery_date: null })?.kind).toBe('planned');
    expect(expectedDeliveryDate({ ...blank, required_on_site_date: '2026-10-30' })).toEqual({ date: '2026-10-30', kind: 'required', label: 'Required on site' });
    expect(expectedDeliveryDate(blank)).toBeNull();
    // the actual delivery date is not an input at all
    expect(expectedDeliveryDate({ ...blank, actual_delivery_date: '2026-10-01' } as never)).toBeNull();
    expect(EXPECTED_DATE_LABELS.required).not.toMatch(/confirm/i);
  });
});

describe('material schedule model', () => {
  const today = '2026-10-15';
  it('one entry per line; undated lines are listed as not scheduled and nothing is filled in', () => {
    const items = [
      mat({ id: 'a', supply_responsibility: 'owner', planned_delivery_date: '2026-10-20' }),
      mat({ id: 'b', supply_responsibility: 'owner', required_on_site_date: '2026-10-22' }), // older date only → review
      mat({ id: 'c', supply_responsibility: 'owner' }),
      mat({ id: 'd', supply_responsibility: 'owner', actual_delivery_date: '2026-10-02', status: 'Delivered' }),
      mat({ id: 'e', supply_responsibility: 'owner', planned_delivery_date: '2026-10-10' }), // open, past → overdue
      mat({ id: 'f', supply_responsibility: 'owner', planned_delivery_date: 'not-a-date' }),
      mat({ id: 'g', supply_responsibility: 'contractor', planned_completion_date: '2026-10-25' }),
      mat({ id: 'h', supply_responsibility: 'contractor', planned_completion_date: '2026-10-11', actual_completion_date: '2026-10-12' }),
      mat({ id: 'i', supply_responsibility: 'contractor', planned_delivery_date: '2026-10-05', actual_delivery_date: '2026-10-06' }), // old delivery dates → review
      mat({ id: 'j', supply_responsibility: 'owner', planned_delivery_date: '2026-10-09', actual_delivery_date: '2026-10-08', status: 'Partially Delivered' }),
    ];
    const { scheduled, unscheduled } = buildMaterialSchedule(items, today);
    expect(scheduled.map((e) => e.item.id).sort()).toEqual(['a', 'b', 'd', 'e', 'g', 'h', 'i', 'j']);
    expect(unscheduled.map((m) => m.id).sort()).toEqual(['c', 'f']);
    expect(new Set(scheduled.map((e) => e.item.id)).size).toBe(scheduled.length);
    const by = (id: string) => scheduled.find((e) => e.item.id === id)!;

    expect(by('a').marks).toEqual([{ date: '2026-10-20', role: 'expected', kind: 'planned', label: 'Planned delivery' }]);
    expect(by('a').overdue).toBe(false);
    // older date only: shown as a previous date awaiting review, never as a planned delivery
    expect(by('b')).toMatchObject({ review: true, expected: { kind: 'legacy', date: '2026-10-22', label: 'Required on site (previous date)' } });
    expect(by('d').expected).toBeNull();
    expect(by('d').marks).toEqual([{ date: '2026-10-02', role: 'actual', kind: 'actual', label: 'Actual delivery' }]);
    expect(by('e').overdue).toBe(true);
    // contractor work uses its own marks and labels
    expect(by('g')).toMatchObject({ work: true, expected: { kind: 'planned_work', label: 'Planned completion', date: '2026-10-25' } });
    expect(by('h').marks.map((m) => [m.kind, m.label])).toEqual([['planned_work', 'Planned completion'], ['actual_work', 'Actual completion']]);
    expect(by('h').overdue).toBe(false);
    // old delivery dates on contractor work are not reinterpreted as completion
    expect(by('i')).toMatchObject({ work: false, review: true });
    expect(by('i').marks.map((m) => m.kind)).toEqual(['legacy', 'actual']);
    expect(by('i').marks.some((m) => m.kind === 'actual_work' || m.kind === 'planned_work')).toBe(false);
    // a partial delivery stays outstanding even with an actual delivery date
    expect(by('j').overdue).toBe(true);
    // the input records are not modified
    expect(items[2].planned_delivery_date).toBeNull();
    expect(items[8].planned_completion_date).toBeNull();
  });

  it('actual delivery is shown separately from the expected date', () => {
    const { scheduled } = buildMaterialSchedule([mat({ revised_delivery_date: '2026-10-12', actual_delivery_date: '2026-10-14', status: 'Delivered' })], today);
    expect(scheduled[0].marks.map((m) => `${m.role}:${m.date}`)).toEqual(['expected:2026-10-12', 'actual:2026-10-14']);
    expect(scheduled[0].overdue).toBe(false);
  });

  it('week / month periods, navigation and out-of-period counts', () => {
    expect(startOfWeek('2026-10-15')).toBe('2026-10-11'); // Thursday → Sunday
    const w = periodFor('week', '2026-10-15');
    expect([w.start, w.end, w.days.length]).toEqual(['2026-10-11', '2026-10-17', 7]);
    const m = periodFor('month', '2026-02-10');
    expect([m.start, m.end, m.days.length, m.label]).toEqual(['2026-02-01', '2026-02-28', 28, 'Feb 2026']);
    expect(shiftPeriod('week', '2026-10-15', 1)).toBe('2026-10-18');
    expect(shiftPeriod('month', '2026-12-20', 1)).toBe('2027-01-01');
    expect(shiftPeriod('month', '2026-01-20', -1)).toBe('2025-12-01');

    const { scheduled } = buildMaterialSchedule([
      mat({ id: 'x', planned_delivery_date: '2026-10-01' }),
      mat({ id: 'y', planned_delivery_date: '2026-10-13' }),
      mat({ id: 'z', planned_delivery_date: '2026-11-04' }),
    ], today);
    const win = entriesInPeriod(scheduled, w.start, w.end);
    expect(win.visible.map((e) => e.item.id)).toEqual(['y']);
    expect([win.before, win.after, win.prevDate, win.nextDate]).toEqual([1, 1, '2026-10-01', '2026-11-04']);
  });
});

describe('gantt model', () => {
  it('uses only the planned start / finish; single dates stay markers; undated tasks are not scheduled', () => {
    expect(plannedSpan({ planned_start: '2026-10-01', planned_end: '2026-10-05' })).toEqual({ kind: 'range', start: '2026-10-01', end: '2026-10-05', days: 5 });
    expect(plannedSpan({ planned_start: '2026-10-01', planned_end: null })).toEqual({ kind: 'start-only', start: '2026-10-01' });
    expect(plannedSpan({ planned_start: null, planned_end: '2026-10-05' })).toEqual({ kind: 'end-only', end: '2026-10-05' });
    expect(plannedSpan({ planned_start: '2026-10-05', planned_end: '2026-10-01' }).kind).toBe('invalid');
    expect(plannedSpan({ planned_start: null, planned_end: null })).toEqual({ kind: 'none' });

    const g = buildGantt([phase('p1', 1), phase('p2', 2)], [
      task('a', 'p1', { planned_start: '2026-10-01', planned_end: '2026-10-05', status: 'Completed' }),
      task('b', 'p1'),
      task('c', 'p2', { planned_end: '2026-11-01' }),
    ]);
    expect(g.scheduledCount).toBe(2);
    expect(g.phases[0]).toMatchObject({ done: 1, total: 2 });
    expect(g.phases[0].tasks.map((t) => t.task.id)).toEqual(['a']);
    expect(g.unscheduled).toEqual([{ phase: expect.objectContaining({ id: 'p1' }), tasks: [expect.objectContaining({ id: 'b' })] }]);
  });

  it('range covers every shown date and today, padded to whole months', () => {
    expect(ganttRange(['2026-10-20', '2026-12-03'], '2026-10-01')).toEqual({ start: '2026-09-01', end: '2026-12-31', days: 122 });
    expect(ganttRange([], '2026-10-15')).toEqual({ start: '2026-10-01', end: '2026-10-31', days: 31 });
  });
});

describe('schedule data comes from existing records under existing permissions', () => {
  let ctx: Ctx;
  let P: string;
  beforeAll(async () => { ctx = await setup(); P = `/api/projects/${ctx.projects.p1}`; });
  afterAll(async () => { await ctx.close(); });

  it('every project role can read the dates both views use; outsiders cannot', async () => {
    for (const role of ['admin', 'pm', 'contractor', 'consultant', 'viewer']) {
      const a = await ctx.agent(role);
      const m = await a.get(`${P}/materials`);
      expect(m.status).toBe(200);
      for (const k of ['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date', 'category_id', 'supply_responsibility', 'status']) {
        expect(m.body.items[0]).toHaveProperty(k);
      }
      const t = await a.get(`${P}/timeline`);
      expect(t.status).toBe(200);
      for (const k of ['planned_start', 'planned_end', 'status', 'depends_on', 'assigned_user_name', 'phase_id']) expect(t.body.tasks[0]).toHaveProperty(k);
    }
    const out = await ctx.agent('outsider');
    expect((await out.get(`${P}/materials`)).status).toBe(404);
    expect((await out.get(`${P}/timeline`)).status).toBe(404);
  });

  it('real seeded records split into scheduled / not scheduled without inventing dates', async () => {
    const a = await ctx.agent('viewer');
    const items: MaterialItem[] = (await a.get(`${P}/materials`)).body.items;
    const { scheduled, unscheduled } = buildMaterialSchedule(items, '2026-10-15');
    expect(scheduled.length + unscheduled.length).toBe(items.length);
    for (const m of unscheduled) {
      expect([m.required_on_site_date, m.planned_delivery_date, m.confirmed_delivery_date, m.revised_delivery_date, m.actual_delivery_date].every((d) => !d)).toBe(true);
    }
    const tl = (await a.get(`${P}/timeline`)).body as { phases: Phase[]; tasks: Task[] };
    const g = buildGantt(tl.phases, tl.tasks);
    const unschedTasks = g.unscheduled.flatMap((u) => u.tasks);
    expect(g.scheduledCount + unschedTasks.length).toBe(tl.tasks.length);
    for (const t of unschedTasks) expect(t.planned_start ?? t.planned_end).toBeNull();
    // reading never creates records
    const counts = await ctx.pool.query('SELECT (SELECT count(*) FROM material_items) AS m, (SELECT count(*) FROM timeline_tasks) AS t');
    await a.get(`${P}/materials`); await a.get(`${P}/timeline`);
    expect((await ctx.pool.query('SELECT (SELECT count(*) FROM material_items) AS m, (SELECT count(*) FROM timeline_tasks) AS t')).rows).toEqual(counts.rows);
  });

  it('read-only roles cannot change task, phase or material dates', async () => {
    const admin = await ctx.agent('admin');
    const tl = (await admin.get(`${P}/timeline`)).body;
    const task = tl.tasks[0];
    const ph = tl.phases[0];
    const line = (await admin.get(`${P}/materials`)).body.items[0];
    for (const role of ['viewer', 'consultant', 'contractor']) {
      const a = await ctx.agent(role);
      expect((await a.patch(`${P}/timeline/tasks/${task.id}`, { planned_start: '2026-11-01', planned_end: '2026-11-05' })).status).toBe(403);
      expect((await a.patch(`${P}/timeline/phases/${ph.id}`, { planned_start: '2026-11-01' })).status).toBe(403);
      expect((await a.patch(`${P}/materials/${line.id}`, { planned_delivery_date: '2026-11-01' })).status).toBe(403);
    }
    const after = (await admin.get(`${P}/timeline`)).body.tasks.find((t: Task) => t.id === task.id);
    expect([after.planned_start, after.planned_end]).toEqual([task.planned_start, task.planned_end]);
  });

  it('dates entered through the normal edit routes appear in both views; contractors only on assigned lines', async () => {
    const pm = await ctx.agent('pm');
    const tl = (await pm.get(`${P}/timeline`)).body;
    const [t1, t2] = tl.tasks;
    expect((await pm.patch(`${P}/timeline/tasks/${t1.id}`, { planned_start: '2026-11-01', planned_end: '2026-11-05' })).status).toBe(200);
    expect((await pm.patch(`${P}/timeline/tasks/${t2.id}`, { planned_start: '2026-11-06', planned_end: '2026-11-10', depends_on: [t1.id] })).status).toBe(200);
    const fresh = (await pm.get(`${P}/timeline`)).body as { phases: Phase[]; tasks: Task[] };
    const g = buildGantt(fresh.phases, fresh.tasks);
    const all = g.phases.flatMap((p) => p.tasks);
    expect(all.find((x) => x.task.id === t1.id)?.span).toEqual({ kind: 'range', start: '2026-11-01', end: '2026-11-05', days: 5 });
    expect(all.find((x) => x.task.id === t2.id)?.task.depends_on).toEqual([t1.id]);

    const admin = await ctx.agent('admin');
    const [m1, m2] = (await admin.get(`${P}/materials`)).body.items;
    await admin.patch(`${P}/materials/${m1.id}`, { assigned_contractor_id: ctx.users.contractor, required_on_site_date: '2026-11-20' });
    const c = await ctx.agent('contractor');
    expect((await c.patch(`${P}/materials/${m1.id}`, { confirmed_delivery_date: '2026-11-18' })).status).toBe(200);
    expect((await c.patch(`${P}/materials/${m2.id}`, { confirmed_delivery_date: '2026-11-18' })).status).toBe(403);
    const items: MaterialItem[] = (await c.get(`${P}/materials`)).body.items;
    const e = buildMaterialSchedule(items, '2026-10-15').scheduled.find((x) => x.item.id === m1.id)!;
    // older supplier-confirmed / required dates on an owner line: previous deadline kept until reviewed
    expect(e.review).toBe(true);
    expect(e.expected).toEqual({ date: '2026-11-18', kind: 'legacy', label: 'Supplier-confirmed delivery (previous date)' });
    // an authorised user confirms it as the planned delivery → simplified schedule
    expect((await c.post(`${P}/materials/${m1.id}/confirm-schedule`, { workflow: 'owner', planned_source: 'confirmed_delivery_date' })).status).toBe(403);
    expect((await admin.post(`${P}/materials/${m1.id}/confirm-schedule`, { workflow: m1.supply_responsibility, planned_source: 'confirmed_delivery_date' })).status).toBe(200);
    const after: MaterialItem[] = (await c.get(`${P}/materials`)).body.items;
    expect(buildMaterialSchedule(after, '2026-10-15').scheduled.find((x) => x.item.id === m1.id)!.expected).toEqual({ date: '2026-11-18', kind: 'planned', label: 'Planned delivery' });
  });
});
