// Simplified material schedule: owner supply → planned / actual delivery, contractor supply →
// planned / actual completion. Older dates are preserved, flagged for review and keep their previous
// deadline until an authorised user confirms the planned date. Isolated test fixtures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Agent, type Ctx } from './helpers';
import { isScheduleOverdue, materialSchedule, scheduleWarnings, type MaterialScheduleInput } from '../shared/materialSchedule';
import { collectDueEvents } from '../server/notify/scheduler';

const base: MaterialScheduleInput = {
  supply_responsibility: 'owner', status: 'Ordered', required_on_site_date: null, planned_delivery_date: null, confirmed_delivery_date: null,
  revised_delivery_date: null, actual_delivery_date: null, delivery_date_note: '', planned_completion_date: null, actual_completion_date: null,
  delivery_schedule_confirmed_at: null, work_schedule_confirmed_at: null, qty_ordered: null, qty_delivered: null,
};
const m = (over: Partial<MaterialScheduleInput>) => ({ ...base, ...over });
const today = '2026-10-15';

describe('owner supply (pure rules)', () => {
  it('planned delivery is the deadline; overdue only while delivery is outstanding', () => {
    const s = materialSchedule(m({ planned_delivery_date: '2026-10-10' }));
    expect(s).toMatchObject({ workflow: 'owner', plannedLabel: 'Planned delivery', actualLabel: 'Actual delivery', needsReview: false, deadline: { date: '2026-10-10', label: 'Planned delivery', legacy: false } });
    expect(isScheduleOverdue(s, today)).toBe(true);
    expect(isScheduleOverdue(materialSchedule(m({ planned_delivery_date: '2026-10-10', actual_delivery_date: '2026-10-11' })), today)).toBe(false);
    expect(isScheduleOverdue(materialSchedule(m({ planned_delivery_date: '2026-10-10', status: 'Delivered' })), today)).toBe(false);
    expect(isScheduleOverdue(materialSchedule(m({ planned_delivery_date: '2026-10-10', status: 'Cancelled' })), today)).toBe(false);
    // a planned date passing never marks anything complete
    expect(materialSchedule(m({ planned_delivery_date: '2020-01-01' })).outstanding).toBe(true);
  });

  it('a partial delivery stays outstanding even with an actual delivery date', () => {
    expect(isScheduleOverdue(materialSchedule(m({ planned_delivery_date: '2026-10-10', actual_delivery_date: '2026-10-09', status: 'Partially Delivered' })), today)).toBe(true);
    const byQty = materialSchedule(m({ planned_delivery_date: '2026-10-10', actual_delivery_date: '2026-10-09', qty_ordered: 100, qty_delivered: 40 }));
    expect(byQty).toMatchObject({ partial: true, outstanding: true });
    expect(materialSchedule(m({ planned_delivery_date: '2026-10-10', actual_delivery_date: '2026-10-09', qty_ordered: 100, qty_delivered: 100 })).outstanding).toBe(false);
  });

  it('older dates: conflicts or a blank planned date are flagged and keep the previous deadline', () => {
    const conflict = materialSchedule(m({ planned_delivery_date: '2026-10-20', revised_delivery_date: '2026-10-25', required_on_site_date: '2026-10-18' }));
    expect(conflict.needsReview).toBe(true);
    expect(conflict.reviewReason).toMatch(/revised delivery/);
    expect(conflict.deadline).toEqual({ date: '2026-10-25', label: 'Revised delivery (previous date)', legacy: true }); // previous precedence
    expect(conflict.previous.map((p) => p.field)).toEqual(['required_on_site_date', 'revised_delivery_date']);
    const blank = materialSchedule(m({ required_on_site_date: '2026-10-10' }));
    expect(blank).toMatchObject({ needsReview: true, deadline: { date: '2026-10-10', legacy: true } });
    expect(blank.reviewReason).toMatch(/blank/);
    // the same date in an older field is not a conflict
    expect(materialSchedule(m({ planned_delivery_date: '2026-10-20', required_on_site_date: '2026-10-20' })).needsReview).toBe(false);
    // once confirmed, older dates are reference only
    expect(materialSchedule(m({ planned_delivery_date: '2026-10-20', revised_delivery_date: '2026-10-25', delivery_schedule_confirmed_at: '2026-10-01T00:00:00Z' })))
      .toMatchObject({ needsReview: false, deadline: { date: '2026-10-20', legacy: false } });
  });

  it('contradictions are reported, never fixed automatically', () => {
    expect(scheduleWarnings(m({ status: 'Delivered', planned_delivery_date: '2026-10-01' }), today)[0]).toMatch(/actual delivery date is blank/);
    expect(scheduleWarnings(m({ status: 'Ordered', actual_delivery_date: '2026-10-01' }), today)[0]).toMatch(/status is still “Ordered”/);
    expect(scheduleWarnings(m({ status: 'Dispatched', actual_delivery_date: '2026-10-01', qty_ordered: 10, qty_delivered: 4 }), today).join(' ')).toMatch(/Partially Delivered/);
    expect(scheduleWarnings(m({ status: 'Delivered', actual_delivery_date: '2026-10-20' }), today)[0]).toMatch(/future/);
    expect(scheduleWarnings(m({ status: 'Delivered', actual_delivery_date: '2026-10-01' }), today)).toEqual([]);
  });
});

describe('contractor supply (pure rules)', () => {
  const c = (over: Partial<MaterialScheduleInput>) => m({ supply_responsibility: 'contractor', ...over });
  it('planned completion is the deadline; only an actual completion date completes the work', () => {
    const s = materialSchedule(c({ planned_completion_date: '2026-10-10', status: 'Delivered' }));
    expect(s).toMatchObject({ workflow: 'contractor', plannedLabel: 'Planned completion', actualLabel: 'Actual completion', deadline: { date: '2026-10-10', label: 'Planned completion' } });
    expect(isScheduleOverdue(s, today)).toBe(true); // material delivered ≠ work completed
    expect(isScheduleOverdue(materialSchedule(c({ planned_completion_date: '2026-10-10', actual_completion_date: '2026-10-12' })), today)).toBe(false);
    expect(materialSchedule(c({ planned_completion_date: '2026-10-10', status: 'Cancelled' })).outstanding).toBe(false);
  });

  it('old delivery dates are never reinterpreted as completion dates', () => {
    const s = materialSchedule(c({ planned_delivery_date: '2026-10-01', actual_delivery_date: '2026-10-03' }));
    expect(s).toMatchObject({ needsReview: true, planned: null, actual: null, deadline: { date: '2026-10-01', legacy: true } });
    expect(s.previous.map((p) => p.field)).toEqual(['planned_delivery_date', 'actual_delivery_date']);
    // a dedicated completion date (or a confirmed work schedule) ends the review; older dates stay as previous details
    expect(materialSchedule(c({ planned_delivery_date: '2026-10-01', planned_completion_date: '2026-11-01' }))).toMatchObject({ needsReview: false, deadline: { date: '2026-11-01', legacy: false } });
    expect(materialSchedule(c({ planned_delivery_date: '2026-10-01', work_schedule_confirmed_at: '2026-10-02T00:00:00Z' }))).toMatchObject({ needsReview: false, deadline: null });
  });

  it('needs confirmation: no simplified schedule is assumed; previous dates keep their deadline', () => {
    const s = materialSchedule(m({ supply_responsibility: 'needs_confirmation', required_on_site_date: '2026-10-10' }));
    expect(s).toMatchObject({ workflow: 'unassigned', needsReview: true, planned: null, deadline: { date: '2026-10-10', legacy: true } });
    expect(materialSchedule(m({ supply_responsibility: 'needs_confirmation' }))).toMatchObject({ needsReview: false, deadline: null });
  });
});

describe('API: saving, switching and reconciling (isolated test project)', () => {
  let ctx: Ctx;
  let P = '';
  let admin: Agent;
  let pm: Agent;
  let catId = '';
  const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  beforeAll(async () => {
    ctx = await setup();
    P = `/api/projects/${ctx.projects.p1}`;
    admin = await ctx.agent('admin');
    pm = await ctx.agent('pm');
    catId = (await pm.get(`${P}/categories`)).body.material[0].id;
  });
  afterAll(async () => { await ctx.close(); });
  const create = async (body: Record<string, unknown>) => {
    const r = await pm.post(`${P}/materials`, { category_id: catId, description: `Line ${Math.random()}`, ...body });
    expect(r.status).toBe(201);
    return r.body;
  };

  it('the migration only adds columns: existing lines keep every saved date', async () => {
    const seeded = await q(`SELECT required_on_site_date::text, planned_completion_date, actual_completion_date, delivery_schedule_confirmed_at, work_schedule_confirmed_at
                              FROM material_items WHERE project_id = $1 AND required_on_site_date IS NOT NULL`, [ctx.projects.p1]);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((r) => r.required_on_site_date && r.planned_completion_date === null && r.actual_completion_date === null && r.delivery_schedule_confirmed_at === null)).toBe(true);
  });

  it('new owner and contractor lines save their two dates; future actual dates are rejected', async () => {
    const o = await create({ supply_responsibility: 'owner', planned_delivery_date: '2026-11-01', actual_delivery_date: '2026-10-01' });
    expect(materialSchedule(o)).toMatchObject({ needsReview: false, planned: '2026-11-01', actual: '2026-10-01' });
    const w = await create({ supply_responsibility: 'contractor', planned_completion_date: '2026-11-15' });
    expect(materialSchedule(w)).toMatchObject({ workflow: 'contractor', planned: '2026-11-15', actual: null });
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    expect((await pm.patch(`${P}/materials/${o.id}`, { actual_delivery_date: tomorrow })).status).toBe(400);
    expect((await pm.patch(`${P}/materials/${w.id}`, { actual_completion_date: tomorrow })).body.error).toMatch(/can't be in the future/);
    // planned date changes are recorded in the audit history (no separate revised field)
    await pm.patch(`${P}/materials/${o.id}`, { planned_delivery_date: '2026-11-08' });
    const log = (await pm.get(`${P}/audit`)).body.find((a: any) => a.entity_id === o.id && a.action === 'delivery_date_change');
    expect(log.before.planned_delivery_date).toBe('2026-11-01');
    expect(log.after.planned_delivery_date).toBe('2026-11-08');
  });

  it('switching responsibility keeps every saved date and flags mappings that need confirmation', async () => {
    const o = await create({ supply_responsibility: 'owner', planned_delivery_date: '2026-11-01', actual_delivery_date: '2026-10-02', qty_ordered: 10, qty_delivered: 4 });
    const toWork = (await pm.patch(`${P}/materials/${o.id}`, { supply_responsibility: 'contractor' })).body;
    expect(toWork).toMatchObject({ planned_delivery_date: '2026-11-01', actual_delivery_date: '2026-10-02', qty_ordered: 10, qty_delivered: 4, planned_completion_date: null });
    expect(materialSchedule(toWork)).toMatchObject({ needsReview: true, actual: null }); // delivery ≠ completion
    const done = (await pm.patch(`${P}/materials/${o.id}`, { planned_completion_date: '2026-12-01' })).body;
    const back = (await pm.patch(`${P}/materials/${o.id}`, { supply_responsibility: 'owner' })).body;
    expect(back).toMatchObject({ planned_delivery_date: '2026-11-01', planned_completion_date: '2026-12-01', actual_delivery_date: '2026-10-02' });
    expect(materialSchedule(back)).toMatchObject({ workflow: 'owner', planned: '2026-11-01', needsReview: false });
    expect(done.planned_completion_date).toBe('2026-12-01');
  });

  it('owner reconciliation: the chosen saved date becomes the planned delivery; older fields stay; audited', async () => {
    const o = await create({ supply_responsibility: 'owner', required_on_site_date: '2026-10-10', revised_delivery_date: '2026-10-20' });
    expect(materialSchedule(o)).toMatchObject({ needsReview: true, deadline: { date: '2026-10-20', legacy: true } });
    const url = `${P}/materials/${o.id}/confirm-schedule`;
    expect((await (await ctx.agent('viewer')).post(url, { workflow: 'owner', planned_source: 'revised_delivery_date' })).status).toBe(403);
    expect((await (await ctx.agent('contractor')).post(url, { workflow: 'owner', planned_source: 'revised_delivery_date' })).status).toBe(403);
    expect((await (await ctx.agent('pm2')).post(url, { workflow: 'owner', planned_source: 'revised_delivery_date' })).status).toBe(404);
    expect((await pm.post(url, { workflow: 'contractor', planned_source: 'revised_delivery_date' })).status).toBe(400);
    expect((await pm.post(url, { workflow: 'owner', planned_source: 'confirmed_delivery_date' })).body.error).toMatch(/no saved date/);
    expect((await pm.post(url, { workflow: 'owner', planned_source: 'notes' })).status).toBe(400);
    const r = await pm.post(url, { workflow: 'owner', planned_source: 'required_on_site_date' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ planned_delivery_date: '2026-10-10', required_on_site_date: '2026-10-10', revised_delivery_date: '2026-10-20' });
    expect(r.body.delivery_schedule_confirmed_at).toBeTruthy();
    expect(materialSchedule(r.body)).toMatchObject({ needsReview: false, deadline: { date: '2026-10-10', legacy: false } });
    const log = (await pm.get(`${P}/audit`)).body.find((a: any) => a.entity_id === o.id && a.action === 'schedule_confirmed');
    expect(log.summary).toMatch(/planned delivery 2026-10-10 \(from required on site/);
    expect(log.before.planned_delivery_date).toBeNull();
    // keeping blank is only possible when there is no planned date
    expect((await pm.post(url, { workflow: 'owner', planned_source: 'none' })).status).toBe(400);
  });

  it('contractor reconciliation: delivery dates map only when explicitly chosen', async () => {
    const w = await create({ supply_responsibility: 'contractor', planned_delivery_date: '2026-09-05', actual_delivery_date: '2026-09-06' });
    const url = `${P}/materials/${w.id}/confirm-schedule`;
    const r = (await admin.post(url, { workflow: 'contractor', planned_source: 'none' })).body;
    expect(r).toMatchObject({ planned_completion_date: null, actual_completion_date: null, planned_delivery_date: '2026-09-05', actual_delivery_date: '2026-09-06' });
    expect(materialSchedule(r)).toMatchObject({ needsReview: false, deadline: null });
    const w2 = await create({ supply_responsibility: 'contractor', planned_delivery_date: '2026-09-05', actual_delivery_date: '2026-09-06' });
    const r2 = (await admin.post(`${P}/materials/${w2.id}/confirm-schedule`, { workflow: 'contractor', planned_source: 'planned_delivery_date', actual_from_delivery: true })).body;
    expect(r2).toMatchObject({ planned_completion_date: '2026-09-05', actual_completion_date: '2026-09-06', planned_delivery_date: '2026-09-05' });
    // needs confirmation: choose a responsibility first
    const u = await create({ supply_responsibility: 'needs_confirmation', required_on_site_date: '2026-10-09' });
    expect((await admin.post(`${P}/materials/${u.id}/confirm-schedule`, { workflow: 'owner', planned_source: 'required_on_site_date' })).body.error).toMatch(/Select and save Owner supply or Contractor supply/);
  });

  it('dashboard, reminders and CSV use the same simplified deadlines; contractor work is counted separately', async () => {
    const late = await create({ supply_responsibility: 'contractor', planned_completion_date: '2026-09-01', status: 'Delivered' });
    const owner = await create({ supply_responsibility: 'owner', planned_delivery_date: '2026-09-02' });
    const flagged = await create({ supply_responsibility: 'owner', required_on_site_date: '2026-09-03' });
    const d = (await admin.get(`${P}/dashboard`)).body.materials;
    const byId = (id: string) => d.overdue.find((x: any) => x.id === id);
    expect(byId(late.id)).toMatchObject({ work: true, basis: 'Planned completion', date: '2026-09-01' });
    expect(byId(owner.id)).toMatchObject({ work: false, basis: 'Planned delivery' });
    expect(byId(flagged.id)).toMatchObject({ legacy: true, basis: 'Required on site (previous date)', date: '2026-09-03' });
    expect(d.overdueWork).toBeGreaterThanOrEqual(1);
    expect(d.overdueDeliveries).toBe(d.overdue.length - d.overdueWork);
    expect(d.datesNeedReview).toBeGreaterThanOrEqual(1);

    const events = await collectDueEvents(ctx.pool, '2026-10-15');
    const ev = (id: string) => events.filter((e) => e.entityId === id);
    expect(ev(late.id)[0]).toMatchObject({ kind: 'material.overdue', dedupeKey: `material.overdue:${late.id}:2026-09-01`, body: 'Contractor work is overdue.' });
    expect(ev(owner.id)[0]).toMatchObject({ dedupeKey: `material.overdue:${owner.id}:2026-09-02`, body: 'A material delivery is overdue.' });
    // a flagged line keeps the same reminder key as before (no duplicate reminders)
    expect(ev(flagged.id)[0].dedupeKey).toBe(`material.overdue:${flagged.id}:2026-09-03`);
    // reconciling to the same date keeps the same key
    await admin.post(`${P}/materials/${flagged.id}/confirm-schedule`, { workflow: 'owner', planned_source: 'required_on_site_date' });
    expect((await collectDueEvents(ctx.pool, '2026-10-15')).find((e) => e.entityId === flagged.id)!.dedupeKey).toBe(`material.overdue:${flagged.id}:2026-09-03`);
    // completed work stops alerting
    await pm.patch(`${P}/materials/${late.id}`, { actual_completion_date: '2026-09-05' });
    expect((await collectDueEvents(ctx.pool, '2026-10-15')).some((e) => e.entityId === late.id)).toBe(false);

    const csv = (await pm.get(`${P}/reports/materials.csv`)).text;
    const header = csv.split('\r\n')[0];
    for (const h of ['Schedule', 'Planned date', 'Actual date', 'Deadline used', 'Date review', 'Planned completion', 'Actual completion', 'Previous: Required on site / supply due']) expect(header).toContain(h);
    const row = csv.split('\r\n').find((l) => l.includes(owner.description))!;
    expect(row).toContain('Material delivery,2026-09-02,,2026-09-02 (Planned delivery),,yes');
  });
});
