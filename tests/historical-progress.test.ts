// Update 14: recording work completed before a project was entered (historical progress entry), task completion
// workflow and phase work status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup, type Agent, type Ctx } from './helpers';
import { runDueChecks } from '../server/notify/scheduler';

let ctx: Ctx;
let admin: Agent, pm: Agent, pm2: Agent, viewer: Agent, contractor: Agent;
let P1: string, P2: string;
type T = { id: string; phase_id: string; name: string; status: string; actual_end: string | null; actual_start: string | null; completion_date_unknown: boolean; completion_note: string; completion_recorded_at: string | null; completion_recorded_by: string | null; is_hold_point: boolean; depends_on: string[] };
type Ph = { id: string; seq: number; name: string };

beforeAll(async () => {
  ctx = await setup();
  [admin, pm, pm2, viewer, contractor] = await Promise.all(['admin', 'pm', 'pm2', 'viewer', 'contractor'].map((r) => ctx.agent(r)));
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
});
afterAll(async () => { await ctx.close(); });

const q = async (sql: string, args: unknown[] = []) => (await ctx.pool.query(sql, args)).rows;
const tl = async (P = P1, a: Agent = pm) => (await a.get(`${P}/timeline`)).body as { phases: Ph[]; tasks: T[] };
const taskOf = async (id: string) => (await tl()).tasks.find((t) => t.id === id)!;
const MIG = fs.readFileSync(path.join(process.cwd(), 'migrations', '010_historical_progress.sql'), 'utf8');

describe('setting: Allow historical progress entry', () => {
  it('is off for every project by default; migration 010 enables only PIN 70153699 and is repeatable', async () => {
    // the test install creates its projects after the migrations, so both start off
    expect((await q(`SELECT code, allow_historical_progress FROM projects ORDER BY code`)).every((r) => r.allow_historical_progress === false)).toBe(true);
    await ctx.pool.query(MIG);
    const rows = await q(`SELECT code, allow_historical_progress FROM projects ORDER BY code`);
    expect(rows.find((r) => r.code === 'PIN 70153699')!.allow_historical_progress).toBe(true);
    expect(rows.find((r) => r.code === 'PIN 70153016')!.allow_historical_progress).toBe(false);
    await ctx.pool.query(MIG);
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE user_email = 'system (migration 010)'`))[0].n).toBe(1);
    // nothing was completed by the migration
    expect((await q(`SELECT count(*)::int AS n FROM timeline_tasks WHERE status = 'Completed'`))[0].n).toBe(0);
  });

  it('only admins can change it; a new project starts off', async () => {
    expect((await pm.patch(`${P1}/historical-progress`, { enabled: false })).status).toBe(403);
    expect((await admin.patch(`${P1}/historical-progress`, { enabled: false })).body.allow_historical_progress).toBe(false);
    expect((await admin.patch(`${P1}/historical-progress`, { enabled: true })).body.allow_historical_progress).toBe(true);
    const np = await admin.post('/api/projects', { code: 'PIN 99000001', name: 'New villa' });
    expect(np.status).toBe(201);
    expect(np.body.allow_historical_progress).toBe(false);
    const audits = await q(`SELECT summary FROM audit_log WHERE entity_type = 'project_settings' AND project_id = $1 ORDER BY id`, [ctx.projects.p1]);
    expect(audits.map((a) => a.summary).join('\n')).toMatch(/Turned off historical progress entry[\s\S]*Allowed historical progress entry/);
  });

  it('without the setting, unknown dates and phase bulk completion are refused on the server', async () => {
    const t2 = await tl(P2, pm2);
    const task = t2.tasks[0];
    expect((await pm2.post(`${P2}/timeline/tasks/${task.id}/complete`, { date_unknown: true })).status).toBe(403);
    expect((await pm2.post(`${P2}/timeline/phases/${task.phase_id}/complete-tasks`, { task_ids: [task.id], actual_end: '2026-01-10' })).status).toBe(403);
    // the normal workflow still works: a known date
    const ok = await pm2.post(`${P2}/timeline/tasks/${task.id}/complete`, { actual_end: '2026-01-10' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'Completed', completion_date_unknown: false, completion_historical: false });
  });
});

describe('recording a single task as completed', () => {
  let phase: Ph; let tasks: T[];
  beforeAll(async () => {
    const d = await tl();
    phase = d.phases[0];
    tasks = d.tasks.filter((t) => t.phase_id === phase.id);
  });

  it('validates dates: historical dates accepted, future and inconsistent dates refused, no date invented', async () => {
    const t = tasks.find((x) => !x.is_hold_point && !x.depends_on.length)!;
    expect((await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, {})).status).toBe(400); // no date and not "unknown"
    expect((await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2099-01-01' })).status).toBe(400);
    expect((await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-10', actual_start: '2025-12-20' })).status).toBe(400);
    expect((await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-10', date_unknown: true })).status).toBe(400);
    expect((await viewer.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-10' })).status).toBe(403);
    expect((await contractor.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-10' })).status).toBe(403);
    expect((await pm2.post(`${P2}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-10' })).status).toBe(404); // other project
    const r = await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-14', actual_start: '2025-12-02', note: 'Completed before the project was entered into the application.', historical: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'Completed', actual_end: '2025-12-14', actual_start: '2025-12-02', completion_date_unknown: false, completion_historical: true, completion_recorded_by: ctx.users.pm });
    expect(r.body.completion_recorded_at).toBeTruthy();
    expect((await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { actual_end: '2025-12-14' })).status).toBe(400); // already completed
    const a = (await q(`SELECT action, summary, before, after FROM audit_log WHERE entity_id = $1 AND action = 'complete'`, [t.id]))[0];
    expect(a.summary).toMatch(/Not Scheduled → Completed; completed 2025-12-14; note: Completed before the project/);
    expect(a.before.status).toBe('Not Scheduled');
  });

  it('exact date unknown keeps the date empty and stays valid when the task is edited later', async () => {
    const t = (await pm.post(`${P1}/timeline/tasks`, { phase_id: phase.id, name: 'Site hoarding' })).body as T;
    const r = await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { date_unknown: true, note: 'Done before the app' });
    expect(r.body).toMatchObject({ status: 'Completed', actual_end: null, completion_date_unknown: true, completion_note: 'Done before the app' });
    // editing another field keeps it completed with an unknown date
    expect((await pm.patch(`${P1}/timeline/tasks/${t.id}`, { notes: 'site photos in Drive' })).body).toMatchObject({ status: 'Completed', completion_date_unknown: true, actual_end: null });
    // entering the date later clears the "unknown" flag
    expect((await pm.patch(`${P1}/timeline/tasks/${t.id}`, { actual_end: '2026-01-20' })).body).toMatchObject({ actual_end: '2026-01-20', completion_date_unknown: false });
    expect((await pm.patch(`${P1}/timeline/tasks/${t.id}`, { actual_end: '2099-01-01' })).status).toBe(400);
  });

  it('hold points and open predecessors need an explicit reason, which is audited; nothing is approved automatically', async () => {
    const d = await tl();
    const hp = d.tasks.find((x) => x.is_hold_point && x.status !== 'Completed')!;
    const r1 = await pm.post(`${P1}/timeline/tasks/${hp.id}/complete`, { actual_end: '2026-02-01' });
    expect(r1.status).toBe(409);
    expect(r1.body.details.issues.map((x: { code: string }) => x.code)).toContain('hold_point');
    const r2 = await pm.post(`${P1}/timeline/tasks/${hp.id}/complete`, { actual_end: '2026-02-01', override_reason: 'Consultant inspection passed on 01/02/2026 (paper record)' });
    expect(r2.status).toBe(200);
    const a = (await q(`SELECT summary, after FROM audit_log WHERE entity_id = $1 AND action = 'complete'`, [hp.id]))[0];
    expect(a.summary).toMatch(/reason: Consultant inspection passed/);
    expect(a.after.override_reason).toMatch(/Consultant inspection/);
  });

  it('reopen corrects an accidental completion: permission-controlled, reason required, audited', async () => {
    const d = await tl();
    const done = d.tasks.find((x) => x.status === 'Completed' && x.actual_end === '2025-12-14')!;
    expect((await viewer.post(`${P1}/timeline/tasks/${done.id}/reopen`, { reason: 'mistake' })).status).toBe(403);
    expect((await pm.post(`${P1}/timeline/tasks/${done.id}/reopen`, {})).status).toBe(400);
    expect((await pm2.post(`${P2}/timeline/tasks/${done.id}/reopen`, { reason: 'mistake' })).status).toBe(404);
    const r = await pm.post(`${P1}/timeline/tasks/${done.id}/reopen`, { reason: 'Marked the wrong task', status: 'In Progress' });
    expect(r.body).toMatchObject({ status: 'In Progress', actual_end: null, completion_date_unknown: false, completion_note: '' });
    const a = (await q(`SELECT summary, before FROM audit_log WHERE entity_id = $1 AND action = 'reopen'`, [done.id]))[0];
    expect(a.summary).toMatch(/Completed → In Progress — Marked the wrong task \(was completed 2025-12-14\)/);
    expect(a.before.actual_end).toBe('2025-12-14');
    expect((await pm.post(`${P1}/timeline/tasks/${done.id}/reopen`, { reason: 'again' })).status).toBe(400);
  });
});

describe('completing several tasks of a phase', () => {
  let phase: Ph; let ids: string[];
  beforeAll(async () => {
    // a dedicated phase with four tasks: one already completed (kept), A → B dependency, one left unselected
    phase = (await pm.post(`${P1}/timeline/phases`, { name: 'Bulk test phase' })).body;
    const mk = async (name: string, extra: Record<string, unknown> = {}) => (await pm.post(`${P1}/timeline/tasks`, { phase_id: phase.id, name, ...extra })).body.id as string;
    const done = await mk('Already done');
    await pm.post(`${P1}/timeline/tasks/${done}/complete`, { actual_end: '2025-12-20', note: 'Original note' });
    const a = await mk('Excavation');
    const b = await mk('Footings', { depends_on: [a] });
    const left = await mk('Not yet');
    ids = [done, a, b, left];
  });

  it('dependencies inside the selection are fine; outside ones need a reason; cross-project refused', async () => {
    const [, a, b] = ids;
    const outside = (await pm.post(`${P1}/timeline/tasks`, { phase_id: phase.id, name: 'Depends on unselected', depends_on: [ids[3]] })).body.id;
    const r = await pm.post(`${P1}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [a, b, outside], date_unknown: true, note: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.details.issues).toEqual([expect.objectContaining({ task_id: outside, code: 'dependencies' })]);
    expect([403, 404]).toContain((await pm2.post(`${P2}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [a], date_unknown: true })).status);
    expect((await taskOf(a)).status).toBe('Not Scheduled');
    const otherPhase = (await tl()).phases.find((p) => p.id !== phase.id)!;
    expect((await pm.post(`${P1}/timeline/phases/${otherPhase.id}/complete-tasks`, { task_ids: [a], date_unknown: true })).status).toBe(400);
    expect((await viewer.post(`${P1}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [a], date_unknown: true })).status).toBe(403);
    await pm.post(`${P1}/timeline/tasks/${outside}/archive`);
  });

  it('updates only the selected incomplete tasks, keeps completed ones, and is safe to submit twice', async () => {
    const [done, a, b, left] = ids;
    const r = await pm.post(`${P1}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [done, a, b], date_unknown: true, note: 'Completed before the project was entered into the application.' });
    expect(r.status).toBe(200);
    expect(r.body.completed.sort()).toEqual([a, b].sort());
    expect(r.body.skipped).toEqual([done]);
    const d = await tl();
    const by = (id: string) => d.tasks.find((t) => t.id === id)!;
    expect(by(done)).toMatchObject({ actual_end: '2025-12-20', completion_note: 'Original note', completion_date_unknown: false });
    expect(by(a)).toMatchObject({ status: 'Completed', actual_end: null, completion_date_unknown: true, completion_note: 'Completed before the project was entered into the application.' });
    expect(by(b)).toMatchObject({ status: 'Completed', completion_date_unknown: true });
    expect(by(left)).toMatchObject({ status: 'Not Scheduled', actual_end: null, completion_date_unknown: false });
    const again = await pm.post(`${P1}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [a, b], date_unknown: true, note: 'dup' });
    expect(again.body.completed).toEqual([]);
    const audits = await q(`SELECT entity_type, summary, after FROM audit_log WHERE action = 'complete' AND (entity_id = ANY($1::text[]) OR entity_id = $2)`, [[a, b], phase.id]);
    expect(audits.filter((x) => x.entity_type === 'timeline_task')).toHaveLength(2);
    expect(audits.filter((x) => x.entity_type === 'timeline_phase')).toHaveLength(1);
    expect(audits.find((x) => x.entity_type === 'timeline_phase')!.summary).toMatch(/Recorded 2 tasks of phase \d+\. Bulk test phase as completed \(exact date unknown; batch \w+\); 1 already completed and unchanged/);
    expect(new Set(audits.map((x) => x.after.batch)).size).toBe(1);
  });

  it('turning the setting off keeps everything recorded', async () => {
    await admin.patch(`${P1}/historical-progress`, { enabled: false });
    expect((await taskOf(ids[1]))).toMatchObject({ status: 'Completed', completion_date_unknown: true });
    expect((await pm.post(`${P1}/timeline/phases/${phase.id}/complete-tasks`, { task_ids: [ids[3]], actual_end: '2026-01-01' })).status).toBe(403);
    await admin.patch(`${P1}/historical-progress`, { enabled: true });
  });
});

describe('dashboard, reminders and counts', () => {
  it('completed tasks (with or without dates) are not overdue, not upcoming, and produce no due reminders', async () => {
    const phase = (await pm.post(`${P1}/timeline/phases`, { name: 'Reminder phase' })).body;
    const t = (await pm.post(`${P1}/timeline/tasks`, { phase_id: phase.id, name: 'Old planned task', planned_start: '2026-01-01', planned_end: '2026-01-05', assigned_user_id: ctx.users.contractor })).body;
    await pm.post(`${P1}/timeline/tasks/${t.id}/complete`, { date_unknown: true, note: 'old' });
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-10-18');
    await ctx.notifier.flush();
    expect((await q(`SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1 AND kind IN ('task.overdue', 'task.due_soon')`, [t.id]))[0].n).toBe(0);
    const d = (await pm.get(`${P1}/dashboard`)).body;
    expect(d.upcoming.some((u: { id: string }) => u.id === t.id)).toBe(false);
    const dt = d.tasks.find((x: { id: string }) => x.id === t.id);
    expect(dt).toMatchObject({ status: 'Completed', actual_end: null, completion_date_unknown: true });
    const all = (await tl()).tasks;
    expect(d.timeline.completed).toBe(all.filter((x) => x.status === 'Completed').length);
    expect(d.timeline.total).toBe(all.length);
  });
});
