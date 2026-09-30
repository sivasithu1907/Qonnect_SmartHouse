import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { setup, type Ctx, type Agent } from './helpers';
import type { PushMessage, PushSender, SendResult, StoredSubscription } from '../server/notify/push';
import { runDueChecks } from '../server/notify/scheduler';
import { PUSH_RATE_LIMIT } from '../server/notify/notifier';

class FakeSender implements PushSender {
  configured = true;
  publicKey = 'BFakePublicKeyForTests';
  sent: Array<{ sub: StoredSubscription; msg: PushMessage; topic: string }> = [];
  failFor = new Map<string, number>();
  async send(sub: StoredSubscription, msg: PushMessage, topic: string): Promise<SendResult> {
    this.sent.push({ sub, msg, topic });
    const code = this.failFor.get(sub.endpoint);
    if (code) return { ok: false, gone: code === 404 || code === 410, statusCode: code };
    return { ok: true };
  }
}

export function fakeSubscription(host = 'fcm.googleapis.com') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${crypto.randomBytes(12).toString('hex')}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

let ctx: Ctx;
let sender: FakeSender;
let P: string;
const agents: Record<string, Agent> = {};
const del = (a: Agent, url: string) => a.raw.delete(url).set('X-CSRF-Token', a.csrf);
const notes = async (userKey: string) => (await ctx.pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at', [ctx.users[userKey]])).rows;

beforeAll(async () => {
  sender = new FakeSender();
  ctx = await setup({ pushSender: sender });
  P = `/api/projects/${ctx.projects.p1}`;
  for (const k of ['admin', 'pm', 'pm2', 'contractor', 'contractor2', 'consultant', 'consultant2', 'viewer']) agents[k] = await ctx.agent(k);
});
afterAll(async () => { await ctx.close(); });
beforeEach(() => { sender.sent = []; sender.failFor.clear(); });

async function subscribe(k: string, sub = fakeSubscription()) {
  const r = await agents[k].post('/api/notifications/subscriptions', sub);
  expect([200, 201]).toContain(r.status);
  return sub;
}

describe('subscriptions & preferences', () => {
  it('requires login and CSRF; exposes only the public VAPID key', async () => {
    expect((await request(ctx.app).get('/api/notifications/push-config')).status).toBe(401);
    const cfg = await agents.pm.get('/api/notifications/push-config');
    expect(cfg.body).toEqual({ configured: true, publicKey: 'BFakePublicKeyForTests' });
    expect((await agents.pm.raw.post('/api/notifications/subscriptions').send(fakeSubscription())).status).toBe(403);
  });

  it('validates subscriptions: HTTPS, known push service, correct key sizes', async () => {
    const bad = [
      { ...fakeSubscription(), endpoint: 'https://evil.example.com/push/1' },
      { ...fakeSubscription(), endpoint: 'http://fcm.googleapis.com/fcm/send/abc' },
      { ...fakeSubscription(), endpoint: 'https://127.0.0.1/internal' },
      { ...fakeSubscription(), keys: { p256dh: 'short-key-short-key-xx', auth: crypto.randomBytes(16).toString('base64url') } },
      { ...fakeSubscription(), keys: { p256dh: fakeSubscription().keys.p256dh, auth: crypto.randomBytes(8).toString('base64url') } },
    ];
    for (const b of bad) expect((await agents.pm.post('/api/notifications/subscriptions', b)).status).toBe(400);
    for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']) {
      expect((await agents.pm.post('/api/notifications/subscriptions', fakeSubscription(host))).status).toBe(201);
    }
  });

  it('re-subscribing the same browser updates it instead of duplicating', async () => {
    const sub = await subscribe('viewer');
    const again = await agents.viewer.post('/api/notifications/subscriptions', sub);
    expect(again.status).toBe(200);
    const list = await agents.viewer.get('/api/notifications/subscriptions');
    expect(list.body).toHaveLength(1);
  });

  it('users can only see and remove their own subscriptions; keys are never returned', async () => {
    const sub = await subscribe('consultant');
    const mine = await agents.consultant.get('/api/notifications/subscriptions');
    expect(mine.body).toHaveLength(1);
    expect(JSON.stringify(mine.body)).not.toContain(sub.keys.p256dh);
    expect(JSON.stringify(mine.body)).not.toContain(sub.endpoint);
    const id = mine.body[0].id;
    expect((await agents.consultant2.get('/api/notifications/subscriptions')).body).toHaveLength(0);
    expect((await del(agents.consultant2, `/api/notifications/subscriptions/${id}`)).status).toBe(404);
    expect((await agents.consultant2.post('/api/notifications/subscriptions/remove', { endpoint: sub.endpoint })).body.removed).toBe(0);
    expect((await agents.consultant.get('/api/notifications/subscriptions')).body).toHaveLength(1);
    expect((await del(agents.consultant, `/api/notifications/subscriptions/${id}`)).status).toBe(200);
    expect((await agents.consultant.get('/api/notifications/subscriptions')).body).toHaveLength(0);
  });

  it('a device re-used by another account moves to that account (possession of endpoint + keys)', async () => {
    const sub = await subscribe('contractor2');
    await subscribe('consultant2', sub);
    expect((await agents.contractor2.get('/api/notifications/subscriptions')).body).toHaveLength(0);
    expect((await agents.consultant2.get('/api/notifications/subscriptions')).body).toHaveLength(1);
    await agents.consultant2.post('/api/notifications/subscriptions/remove', { endpoint: sub.endpoint });
  });

  it('manages preferences and ignores mutes for projects the user cannot access', async () => {
    const d = await agents.contractor.get('/api/notifications/preferences');
    expect(d.body.push_enabled).toBe(false);
    expect(d.body.event_types).toContain('site_visit');
    expect((await agents.contractor.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor.csrf).send({ event_types: ['nope'] })).status).toBe(400);
    const r = await agents.contractor.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor.csrf)
      .send({ muted_project_ids: [ctx.projects.p2] });
    expect(r.body.muted_project_ids).toEqual([]); // contractor is not a member of P2
  });
});

describe('event notifications', () => {
  it('site visit assignment notifies only the assignee, with a generic private payload', async () => {
    await subscribe('contractor');
    const v = await agents.pm.post(`${P}/visits/site`, { purpose: 'Check tile storage for owner — bank ref 12345', assigned_user_id: ctx.users.contractor, visit_at: '2026-10-05T06:00:00.000Z' });
    expect(v.status).toBe(201);
    await ctx.notifier.flush();
    const n = await notes('contractor');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'site_visit.assigned', body: 'A site visit has been assigned to you.', push_status: 'sent' });
    expect(n[0].url).toBe(`/#/site/${ctx.projects.p1}/${v.body.id}`);
    expect(sender.sent).toHaveLength(1);
    const payload = JSON.stringify(sender.sent[0].msg);
    expect(payload).not.toMatch(/tile storage|12345|bank/i);
    expect(sender.sent[0].msg.title).toBe('Qonnect · PIN 70153699');
    expect(await notes('pm')).toHaveLength(0); // actor is never notified
  });

  it('repeated or minor edits do not re-notify; rescheduling does, once', async () => {
    const v = await agents.pm.post(`${P}/visits/site`, { purpose: 'Second visit', assigned_user_id: ctx.users.contractor, visit_at: '2026-10-06T06:00:00.000Z' });
    await ctx.notifier.flush();
    const before = (await notes('contractor')).length;
    await agents.pm.patch(`${P}/visits/site/${v.body.id}`, { assigned_user_id: ctx.users.contractor, notes: 'minor edit' });
    await agents.pm.patch(`${P}/visits/site/${v.body.id}`, { areas: 'Ground floor' });
    await ctx.notifier.flush();
    expect(await notes('contractor')).toHaveLength(before);
    await agents.pm.patch(`${P}/visits/site/${v.body.id}`, { visit_at: '2026-10-07T06:00:00.000Z' });
    await agents.pm.patch(`${P}/visits/site/${v.body.id}`, { visit_at: '2026-10-07T06:00:00.000Z' });
    await ctx.notifier.flush();
    const after = await notes('contractor');
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1].kind).toBe('site_visit.rescheduled');
  });

  it('push off → in-app only; event type off or project muted → nothing', async () => {
    await agents.contractor2.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor2.csrf).send({ push_enabled: false });
    await agents.pm.post(`${P}/visits/site`, { purpose: 'A', assigned_user_id: ctx.users.contractor2 });
    await ctx.notifier.flush();
    const n = await notes('contractor2');
    expect(n).toHaveLength(1);
    expect(n[0].push_status).toBe('skipped');
    expect(sender.sent).toHaveLength(0);
    await agents.contractor2.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor2.csrf).send({ event_types: ['payment_due'] });
    await agents.pm.post(`${P}/visits/site`, { purpose: 'B', assigned_user_id: ctx.users.contractor2 });
    await agents.contractor2.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor2.csrf).send({ event_types: ['site_visit'], muted_project_ids: [ctx.projects.p1] });
    await agents.pm.post(`${P}/visits/site`, { purpose: 'C', assigned_user_id: ctx.users.contractor2 });
    await ctx.notifier.flush();
    expect(await notes('contractor2')).toHaveLength(1);
    await agents.contractor2.raw.put('/api/notifications/preferences').set('X-CSRF-Token', agents.contractor2.csrf).send({ muted_project_ids: [] });
  });

  it('consultant visits notify the assigned consultant, never the consultant who created it', async () => {
    const own = await agents.consultant.post(`${P}/visits/consultant`, { purpose: 'Own visit' });
    expect(own.status).toBe(201);
    await agents.pm.post(`${P}/visits/consultant`, { purpose: 'Assigned', consultant_user_id: ctx.users.consultant2, planned_at: '2026-10-09T06:00:00.000Z' });
    await ctx.notifier.flush();
    expect((await notes('consultant')).filter((n) => n.event_type === 'consultant_visit')).toHaveLength(0);
    expect((await notes('consultant2')).map((n) => n.kind)).toContain('consultant_visit.assigned');
  });

  it('timeline task assignment notifies the assignee; non-members cannot be assigned', async () => {
    const tl = await agents.pm.get(`${P}/timeline`);
    const task = tl.body.tasks[0];
    expect((await agents.pm.patch(`${P}/timeline/tasks/${task.id}`, { assigned_user_id: ctx.users.pm2 })).status).toBe(400);
    const r = await agents.pm.patch(`${P}/timeline/tasks/${task.id}`, { assigned_user_id: ctx.users.viewer });
    expect(r.status).toBe(200);
    await ctx.notifier.flush();
    expect((await notes('viewer')).map((n) => n.kind)).toContain('task.assigned');
    const tl2 = await agents.pm.get(`${P}/timeline`);
    expect(tl2.body.tasks.find((t: { id: string }) => t.id === task.id).assigned_user_name).toBe('viewer');
  });

  it('material delivery date change notifies material managers and the assigned contractor only', async () => {
    const mats = (await agents.admin.get(`${P}/materials`)).body.items;
    const m = mats.find((x: { description: string }) => x.description === 'Spotlights');
    await agents.admin.patch(`${P}/materials/${m.id}`, { assigned_contractor_id: ctx.users.contractor });
    const before = { admin: (await notes('admin')).length, contractor: (await notes('contractor')).length, viewer: (await notes('viewer')).length, contractor2: (await notes('contractor2')).length };
    await agents.pm.patch(`${P}/materials/${m.id}`, { planned_delivery_date: '2026-11-01' });
    await agents.pm.patch(`${P}/materials/${m.id}`, { notes: 'unrelated' });
    await ctx.notifier.flush();
    expect((await notes('admin')).length).toBe(before.admin + 1);
    expect((await notes('contractor')).length).toBe(before.contractor + 1);
    expect((await notes('viewer')).length).toBe(before.viewer);
    expect((await notes('contractor2')).length).toBe(before.contractor2);
    expect((await notes('pm')).filter((n) => n.kind === 'material.date_changed')).toHaveLength(0);
  });
});

describe('due-date checks (scheduler)', () => {
  it('payment due soon / overdue go only to users with payment access in that project, once per due date', async () => {
    const soon = await agents.pm.post(`${P}/payments/milestones`, { payee_type: 'contractor', payee_name: 'X', description: 'Advance', scheduled_amount: 99999, due_date: '2026-10-02' });
    const late = await agents.pm.post(`${P}/payments/milestones`, { payee_type: 'kahramaa', payee_name: 'K', description: 'Fee', scheduled_amount: 35000, due_date: '2026-09-20' });
    const count = async (id: string) => (await ctx.pool.query('SELECT u.name, n.kind, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.entity_id = $1 ORDER BY u.name', [id])).rows;
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-09-30');
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-09-30');
    const s = await count(soon.body.id);
    expect(s.map((r) => r.name)).toEqual(['admin', 'pm', 'viewer']);
    expect(s.every((r) => r.kind === 'payment.due_soon' && r.body === 'A payment milestone is due soon.')).toBe(true);
    const l = await count(late.body.id);
    expect(l.map((r) => r.name)).toEqual(['admin', 'pm', 'viewer']);
    expect(l[0]).toMatchObject({ kind: 'payment.overdue', body: 'A payment milestone needs attention.' });
    expect(JSON.stringify(sender.sent)).not.toMatch(/99999|35000|Kahramaa|Advance/);
    // fully paid milestones do not alert
    await agents.pm.post(`${P}/payments/milestones/${late.body.id}/transactions`, { amount: 35000, paid_date: '2026-09-25', method: 'cash' });
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-10-05');
    expect((await count(late.body.id)).length).toBe(3);
  });

  it('material deliveries due soon and overdue use only stored dates', async () => {
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-10-08');
    const soon = (await ctx.pool.query(`SELECT DISTINCT entity_id FROM notifications WHERE kind = 'material.due_soon'`)).rows;
    expect(soon).toHaveLength(4); // the four tile/marble lines due 10 Oct 2026
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-10-12');
    expect((await ctx.pool.query(`SELECT DISTINCT entity_id FROM notifications WHERE kind = 'material.overdue'`)).rows).toHaveLength(4);
    const who = (await ctx.pool.query(`SELECT DISTINCT u.name FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind LIKE 'material.%due%' OR n.kind = 'material.overdue' ORDER BY 1`)).rows.map((r) => r.name);
    expect(who).toEqual(['admin', 'pm']);
  });

  it('tasks: assignee is told when due; managers when unassigned or overdue', async () => {
    const tl = (await agents.pm.get(`${P}/timeline`)).body.tasks;
    const [a, b] = [tl[1], tl[2]];
    await agents.pm.patch(`${P}/timeline/tasks/${a.id}`, { planned_end: '2026-10-01', assigned_user_id: ctx.users.contractor });
    await agents.pm.patch(`${P}/timeline/tasks/${b.id}`, { planned_end: '2026-10-01' });
    await ctx.notifier.flush();
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-09-30');
    const rows = async (id: string, kind: string) => (await ctx.pool.query('SELECT u.name FROM notifications n JOIN users u ON u.id = n.user_id WHERE entity_id = $1 AND kind = $2 ORDER BY 1', [id, kind])).rows.map((r) => r.name);
    expect(await rows(a.id, 'task.due_soon')).toEqual(['contractor']);
    expect(await rows(b.id, 'task.due_soon')).toEqual(['admin', 'pm']);
    await runDueChecks(ctx.pool, ctx.notifier, 'Asia/Qatar', '2026-10-03');
    expect(await rows(a.id, 'task.overdue')).toEqual(['admin', 'contractor', 'pm']);
  });
});

describe('isolation, delivery failures, rate limits', () => {
  it('never notifies users of other projects; list hides projects the user lost access to', async () => {
    expect(await notes('pm2')).toHaveLength(0);
    const vl = await agents.viewer.get('/api/notifications');
    expect(vl.body.items.length).toBeGreaterThan(0);
    await ctx.pool.query('DELETE FROM project_members WHERE user_id = $1 AND project_id = $2', [ctx.users.viewer, ctx.projects.p1]);
    const after = await agents.viewer.get('/api/notifications');
    expect(after.body.items).toHaveLength(0);
    expect(after.body.unread).toBe(0);
    await ctx.pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2)', [ctx.projects.p1, ctx.users.viewer]);
  });

  it('read state is per user', async () => {
    const mine = (await agents.contractor.get('/api/notifications')).body;
    expect(mine.unread).toBeGreaterThan(0);
    const id = mine.items[0].id;
    expect((await agents.viewer.post(`/api/notifications/${id}/read`)).status).toBe(404);
    expect((await agents.contractor.post(`/api/notifications/${id}/read`)).status).toBe(200);
    expect((await agents.contractor.get('/api/notifications')).body.unread).toBe(mine.unread - 1);
    await agents.contractor.post('/api/notifications/read-all');
    expect((await agents.contractor.get('/api/notifications')).body.unread).toBe(0);
  });

  it('removes expired (410/404) subscriptions and ones that keep failing', async () => {
    const gone = await subscribe('consultant2');
    const flaky = await subscribe('consultant2');
    sender.failFor.set(gone.endpoint, 410);
    sender.failFor.set(flaky.endpoint, 500);
    await agents.pm.post(`${P}/visits/consultant`, { purpose: 'Fail test', consultant_user_id: ctx.users.consultant2 });
    await ctx.notifier.flush();
    const subs = (await ctx.pool.query('SELECT endpoint, failure_count FROM push_subscriptions WHERE user_id = $1', [ctx.users.consultant2])).rows;
    expect(subs.map((s) => s.endpoint)).toEqual([flaky.endpoint]);
    expect(subs[0].failure_count).toBe(1);
    const last = (await notes('consultant2')).pop();
    expect(last.push_status).toBe('failed');
    for (let i = 0; i < 4; i++) await ctx.notifier.deliver(null, ctx.users.consultant2, { title: 't', body: 'b', url: '/', tag: 'x' }, `retry-${i}`);
    expect((await ctx.pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [ctx.users.consultant2])).rows).toHaveLength(0);
  });

  it('caps pushes per user; extra alerts stay in the in-app list', async () => {
    await subscribe('consultant');
    await ctx.pool.query(`DELETE FROM notifications WHERE user_id = $1`, [ctx.users.consultant]);
    for (let i = 0; i < PUSH_RATE_LIMIT.max + 2; i++) {
      await agents.pm.post(`${P}/visits/consultant`, { purpose: `Burst ${i}`, consultant_user_id: ctx.users.consultant });
    }
    await ctx.notifier.flush();
    const n = await notes('consultant');
    expect(n).toHaveLength(PUSH_RATE_LIMIT.max + 2);
    expect(n.filter((x) => x.push_status === 'sent')).toHaveLength(PUSH_RATE_LIMIT.max);
    expect(n.filter((x) => x.push_status === 'rate_limited')).toHaveLength(2);
  });

  it('test push goes only to the caller and is rate limited', async () => {
    await subscribe('pm');
    const r = await agents.pm.post('/api/notifications/test');
    expect(r.body.status).toBe('sent');
    expect(sender.sent.every((s) => s.msg.url === '/#/notifications')).toBe(true);
    const owners = (await ctx.pool.query('SELECT DISTINCT user_id FROM push_subscriptions WHERE endpoint = ANY($1)', [sender.sent.map((s) => s.sub.endpoint)])).rows;
    expect(owners).toEqual([{ user_id: ctx.users.pm }]);
    await agents.pm.post('/api/notifications/test');
    await agents.pm.post('/api/notifications/test');
    expect((await agents.pm.post('/api/notifications/test')).status).toBe(429);
  });

  it('reports push as not configured when VAPID keys are missing', async () => {
    const off = await setup();
    const a = await off.agent('pm');
    expect((await a.get('/api/notifications/push-config')).body).toEqual({ configured: false, publicKey: '' });
    expect((await a.post('/api/notifications/subscriptions', fakeSubscription())).status).toBe(503);
    await off.close();
  });
});

describe('VAPID configuration check', () => {
  it('treats malformed VAPID settings as not configured instead of failing every send', async () => {
    const { createWebPushSender, vapidProblem } = await import('../server/notify/push');
    const { loadConfig } = await import('../server/config');
    const webpush = (await import('web-push')).default;
    const good = webpush.generateVAPIDKeys();
    const ok = loadConfig({ databaseUrl: 'postgres://unused', vapidPublicKey: good.publicKey, vapidPrivateKey: good.privateKey, vapidSubject: 'mailto:ops@example.test' });
    expect(vapidProblem(ok)).toBeNull();
    expect(createWebPushSender(ok).configured).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const badSubject = { ...ok, vapidSubject: 'ops@example.test' };
    expect(vapidProblem(badSubject)).not.toBeNull();
    expect(createWebPushSender(badSubject).configured).toBe(false);
    const badKey = { ...ok, vapidPrivateKey: 'short' };
    expect(createWebPushSender(badKey).configured).toBe(false);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(good.privateKey);
    warn.mockRestore();
  });
});
