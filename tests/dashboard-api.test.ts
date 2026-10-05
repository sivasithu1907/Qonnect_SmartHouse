// Dashboard API: real records only — upcoming window in the application time zone, partial and
// over-budget payments, missing consultant reports, record links in the selected project, roles.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, setup, type Agent, type Ctx } from './helpers';
import { addDaysISO, todayISO } from '../shared/calc';
import { financeOverview } from '../src/lib/dashboard';

let ctx: Ctx;
let P1 = '';
let P2 = '';
let admin: Agent;
let pm: Agent;
let today = '';
const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;

beforeAll(async () => {
  ctx = await setup();
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
  admin = await ctx.agent('admin');
  pm = await ctx.agent('pm');
  today = todayISO(ctx.cfg.timeZone);
});
afterAll(async () => { await ctx.close(); });

describe('finance figures', () => {
  it('partial payments: paid = transfers, scheduled unpaid = outstanding balances, overdue is a subset', async () => {
    await admin.patch(`${P1}/settings`, { control_budget: 1000000, control_budget_confirmed: true });
    const a = (await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Builder', description: 'Stage 1', scheduled_amount: 180000, due_date: addDaysISO(today, 10) })).body;
    await pm.post(`${P1}/payments/milestones/${a.id}/transactions`, { amount: 90000, paid_date: today, method: 'bank_transfer', reference: 'T-1' });
    const b = (await pm.post(`${P1}/payments/milestones`, { payee_type: 'consultant', payee_name: 'Consultant', description: 'Fee', scheduled_amount: 15000, due_date: addDaysISO(today, -5) })).body;
    const c = (await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Builder', description: 'Cancelled', scheduled_amount: 5000, status: 'cancelled' })).body;
    expect(b.id && c.id).toBeTruthy();
    const d = (await admin.get(`${P1}/dashboard`)).body;
    expect(d.finance).toMatchObject({ paid: 90000, pending: 105000, overdue: 15000, overdueCount: 1, transactionCount: 1, unpaidCount: 2, controlBudget: 1000000, controlBudgetConfirmed: true });
    const o = financeOverview(d.finance);
    expect(o).toMatchObject({ remaining: 910000, over: 0 });
    expect(o.spentPct).toBeCloseTo(9, 5);
  });

  it('over budget: remaining is negative and the over amount is exact', async () => {
    const m = (await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Builder', description: 'Big stage', scheduled_amount: 1000000 })).body;
    await pm.post(`${P1}/payments/milestones/${m.id}/transactions`, { amount: 1000000, paid_date: today, method: 'bank_transfer', reference: 'T-2' });
    const o = financeOverview((await admin.get(`${P1}/dashboard`)).body.finance);
    expect(o).toMatchObject({ paid: 1090000, remaining: -90000, over: 90000 });
    expect(o.spentPct!.toFixed(1)).toBe('109.0');
  });

  it('roles without financial access get no finance block', async () => {
    const d = (await (await ctx.agent('contractor')).get(`${P1}/dashboard`)).body;
    expect(d.finance).toBeNull();
    expect(JSON.stringify(d)).not.toContain('1090000');
  });
});

describe('next 14 days', () => {
  it('includes only dated records from today to today + 13 (local dates), excludes overdue and completed, and links into the selected project', async () => {
    const mats = (await admin.get(`${P1}/materials`)).body.items;
    const [m1, m2, m3, m4] = mats;
    await admin.patch(`${P1}/materials/${m1.id}`, { confirmed_delivery_date: today, status: 'Ordered' });
    await admin.patch(`${P1}/materials/${m2.id}`, { planned_delivery_date: addDaysISO(today, 13), status: 'Ordered' });
    await admin.patch(`${P1}/materials/${m3.id}`, { planned_delivery_date: addDaysISO(today, 14), status: 'Ordered' }); // outside
    await admin.patch(`${P1}/materials/${m4.id}`, { planned_delivery_date: addDaysISO(today, -1), status: 'Ordered' }); // overdue
    const tasks = (await admin.get(`${P1}/timeline`)).body.tasks;
    await q(`UPDATE timeline_tasks SET planned_start = $2, planned_end = $3, status = 'Scheduled' WHERE id = $1`, [tasks[0].id, addDaysISO(today, 3), addDaysISO(today, 40)]);
    await q(`UPDATE timeline_tasks SET planned_start = $2, planned_end = $3, status = 'Completed' WHERE id = $1`, [tasks[1].id, addDaysISO(today, 2), addDaysISO(today, 4)]);
    await q(`UPDATE timeline_tasks SET planned_start = $2, planned_end = $3, status = 'In Progress' WHERE id = $1`, [tasks[2].id, addDaysISO(today, -20), addDaysISO(today, 5)]);
    // a site visit at 23:30 Qatar time on the last day is still inside the window (date-only, application time zone)
    const lastDay = addDaysISO(today, 13);
    const sv = (await admin.post(`${P1}/visits/site`, { purpose: 'Late check', visit_at: `${lastDay}T23:30:00+03:00` })).body;
    const cv = (await admin.post(`${P1}/visits/consultant`, { purpose: 'Slab inspection', planned_at: `${addDaysISO(today, 1)}T09:00:00+03:00`, consultant_name: 'Supervision consultant' })).body;
    const d = (await admin.get(`${P1}/dashboard`)).body;
    expect(d.upcomingDays).toBe(14);
    const keys = d.upcoming.map((i: any) => i.key);
    expect(keys).toContain(`material-${m1.id}`);
    expect(keys).toContain(`material-${m2.id}`);
    expect(keys).not.toContain(`material-${m3.id}`);
    expect(keys).not.toContain(`material-${m4.id}`);
    expect(keys).toContain(`task-${tasks[0].id}`);
    expect(keys).not.toContain(`task-${tasks[1].id}`);
    expect(d.upcoming.find((i: any) => i.key === `task-${tasks[2].id}`)).toMatchObject({ date: addDaysISO(today, 5), dateLabel: 'Planned finish' });
    expect(d.upcoming.find((i: any) => i.key === `site-${sv.id}`)).toMatchObject({ date: lastDay, kind: 'site_visit', href: `#/site/${ctx.projects.p1}/${sv.id}` });
    expect(d.upcoming.find((i: any) => i.key === `consultant-${cv.id}`)).toMatchObject({ who: 'Supervision consultant', href: `#/consultant/${ctx.projects.p1}/${cv.id}` });
    expect(d.upcoming.find((i: any) => i.key === `material-${m1.id}`)).toMatchObject({ date: today, dateLabel: 'Supplier-confirmed delivery', dateKind: 'confirmed', deliveryStatus: 'confirmed', href: `#/materials/${ctx.projects.p1}/${m1.id}` });
    expect(d.upcoming.find((i: any) => i.key === `material-${m2.id}`)).toMatchObject({ dateKind: 'planned', deliveryStatus: 'unconfirmed' });
    const dates = d.upcoming.map((i: any) => i.date);
    expect([...dates].sort()).toEqual(dates); // chronological
    expect(d.upcoming.every((i: any) => i.href.includes(ctx.projects.p1))).toBe(true);
    // overdue delivery goes to Needs attention instead
    expect(d.materials.overdue.map((x: any) => x.id)).toContain(m4.id);
  });

  it('another project never shows these records', async () => {
    const d2 = (await admin.get(`${P2}/dashboard`)).body;
    expect(d2.upcoming.every((i: any) => i.href.includes(ctx.projects.p2))).toBe(true);
    expect(JSON.stringify(d2)).not.toContain('Late check');
    expect((await (await ctx.agent('pm2')).get(`${P1}/dashboard`)).status).toBe(404);
  });
});

describe('needs-attention sources', () => {
  it('lists completed consultant visits without a consultant report until one is uploaded', async () => {
    const v = (await admin.post(`${P1}/visits/consultant`, { purpose: 'Backfill inspection', planned_at: `${addDaysISO(today, -3)}T10:00:00+03:00`, status: 'Completed' })).body;
    expect((await admin.get(`${P1}/dashboard`)).body.consultantReportsMissing.map((x: any) => x.id)).toContain(v.id);
    expect((await admin.upload(`${P1}/attachments`, { entity_type: 'consultant_visit', entity_id: v.id, kind: 'consultant_report' }, { buf: PDF, name: 'report.pdf' })).status).toBe(201);
    expect((await admin.get(`${P1}/dashboard`)).body.consultantReportsMissing.map((x: any) => x.id)).not.toContain(v.id);
  });

  it('returns tasks with hold points and dependencies for phases and milestones', async () => {
    const d = (await admin.get(`${P1}/dashboard`)).body;
    expect(d.tasks.length).toBe(d.timeline.total);
    expect(d.tasks.some((t: any) => t.is_hold_point)).toBe(true);
    expect(d.tasks.some((t: any) => t.depends_on.length > 0)).toBe(true);
    expect(d.project).toHaveProperty('planned_start_date');
    expect(d.project).toHaveProperty('target_completion_date');
  });
});
