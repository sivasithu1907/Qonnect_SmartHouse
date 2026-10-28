// Profile pictures: upload (JPEG / PNG / WebP), crop, re-encode and metadata removal, replace / remove,
// rejection of non-images and oversize files, who may change and who may see a picture, that a change touches
// nothing else on the account, and that pictures survive an application restart.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { PASSWORD, setup, type Agent, type Ctx } from './helpers';
import { createApp } from '../server/app';
import { resetLoginThrottle } from '../server/auth';

let ctx: Ctx;
let admin: Agent, pm: Agent, pm2: Agent, contractor: Agent, viewer: Agent, outsider: Agent;
const url = (id: string) => `/api/users/${id}/avatar`;
const dir = () => path.join(ctx.uploadDir, '_avatars');
const files = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : []);
const bin = (t: request.Test) => t.buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });

/** 400×200 picture: left half red, right half blue. */
const halves = (fmt: 'jpeg' | 'png' | 'webp') => sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
  .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }, left: 200, top: 0 }])
  .toFormat(fmt).toBuffer();

beforeAll(async () => {
  ctx = await setup();
  [admin, pm, pm2, contractor, viewer, outsider] = await Promise.all(['admin', 'pm', 'pm2', 'contractor', 'viewer', 'outsider'].map((k) => ctx.agent(k)));
});
afterAll(async () => { await ctx?.close(); });

describe('upload, crop and processing', () => {
  it('a JPEG with camera details and GPS is cropped, resized to 256×256 WebP and stripped of metadata', async () => {
    const jpg = await sharp(await halves('jpeg')).withMetadata({ exif: { IFD0: { Copyright: 'SECRET-OWNER', Artist: 'Someone' } } }).jpeg().toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeDefined();
    const r = await pm.upload(url(ctx.users.pm), { x: '200', y: '0', size: '200' }, { buf: jpg, name: 'holiday photo.jpg' });
    expect(r.status).toBe(200);
    expect(r.body.avatar_version).toMatch(/^\d+$/);
    const [name] = files();
    expect(name).toMatch(/^[0-9a-f-]{36}\.webp$/); // generated name, never the uploaded one
    const stored = fs.readFileSync(path.join(dir(), name));
    const meta = await sharp(stored).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.toString('latin1')).not.toContain('SECRET-OWNER');
    // the chosen square (right half) is blue
    const { data } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    const mid = (128 * 256 + 128) * 3;
    expect(data[mid + 2]).toBeGreaterThan(200);
    expect(data[mid]).toBeLessThan(60);
    const row = (await ctx.pool.query('SELECT avatar_file, avatar_sha256, avatar_size_bytes FROM users WHERE id = $1', [ctx.users.pm])).rows[0];
    expect(row).toMatchObject({ avatar_file: name, avatar_size_bytes: stored.length });
    expect(row.avatar_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('camera orientation is applied before cropping', async () => {
    // stored 400×200 with EXIF orientation 6 (rotate 90°) = displayed 200×400
    const jpg = await sharp(await halves('jpeg')).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const r = await contractor.upload(url(ctx.users.contractor), { x: '0', y: '0', size: '200' }, { buf: jpg, name: 'p.jpg' });
    expect(r.status).toBe(200);
    const file = (await ctx.pool.query('SELECT avatar_file FROM users WHERE id = $1', [ctx.users.contractor])).rows[0].avatar_file;
    const meta = await sharp(path.join(dir(), file)).metadata();
    expect(meta).toMatchObject({ width: 256, height: 256 });
    expect(meta.orientation).toBeUndefined();
  });

  it('PNG and WebP are accepted; an out-of-range crop falls back to a centred square', async () => {
    expect((await viewer.upload(url(ctx.users.viewer), {}, { buf: await halves('png'), name: 'a.png' })).status).toBe(200);
    expect((await viewer.upload(url(ctx.users.viewer), { x: '390', y: '0', size: '200' }, { buf: await halves('webp'), name: 'a.webp' })).status).toBe(200);
  });

  it('rejects files that are not real JPEG / PNG / WebP pictures, whatever their name, and keeps the current picture', async () => {
    const before = (await ctx.pool.query('SELECT avatar_file, avatar_updated_at FROM users WHERE id = $1', [ctx.users.pm])).rows[0];
    const keep = files();
    const fake = await pm.upload(url(ctx.users.pm), {}, { buf: Buffer.from('<?php echo "hi"; ?> not an image'), name: 'evil.png' });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toBe('This file is not a JPEG, PNG or WebP picture');
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    expect((await pm.upload(url(ctx.users.pm), {}, { buf: gif, name: 'x.jpg' })).status).toBe(400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect((await pm.upload(url(ctx.users.pm), {}, { buf: svg, name: 'x.webp' })).status).toBe(400);
    expect((await pm.upload(url(ctx.users.pm), {}, { buf: (await halves('jpeg')).subarray(0, 200), name: 'cut.jpg' })).status).toBe(400);
    expect((await pm.post(url(ctx.users.pm), {})).status).toBe(400); // no file
    const big = await pm.upload(url(ctx.users.pm), {}, { buf: Buffer.alloc(5 * 1024 * 1024 + 10, 0xff), name: 'big.jpg' });
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/larger than 5 MB/);
    expect((await ctx.pool.query('SELECT avatar_file, avatar_updated_at FROM users WHERE id = $1', [ctx.users.pm])).rows[0]).toEqual(before);
    expect(files()).toEqual(keep);
  });
});

describe('replace and remove', () => {
  it('replacing stores the new picture and deletes the old file; the version changes', async () => {
    const old = (await ctx.pool.query('SELECT avatar_file FROM users WHERE id = $1', [ctx.users.pm])).rows[0].avatar_file;
    const v1 = (await pm.get('/api/auth/me')).body.user.avatar_version;
    await new Promise((r) => setTimeout(r, 5));
    const r = await pm.upload(url(ctx.users.pm), {}, { buf: await halves('png'), name: 'b.png' });
    expect(r.status).toBe(200);
    expect(r.body.avatar_version).not.toBe(v1);
    const now = (await ctx.pool.query('SELECT avatar_file FROM users WHERE id = $1', [ctx.users.pm])).rows[0].avatar_file;
    expect(now).not.toBe(old);
    expect(fs.existsSync(path.join(dir(), old))).toBe(false);
    expect(fs.existsSync(path.join(dir(), now))).toBe(true);
    // the signed-in session sees the new version without signing out
    expect((await pm.get('/api/auth/me')).body.user.avatar_version).toBe(r.body.avatar_version);
  });

  it('removing clears the picture and deletes the file; initials are shown (404 for the image)', async () => {
    const file = (await ctx.pool.query('SELECT avatar_file FROM users WHERE id = $1', [ctx.users.viewer])).rows[0].avatar_file;
    const r = await viewer.raw.delete(url(ctx.users.viewer)).set('X-CSRF-Token', viewer.csrf);
    expect(r.status).toBe(200);
    expect(r.body.avatar_version).toBeNull();
    expect(fs.existsSync(path.join(dir(), file))).toBe(false);
    expect((await viewer.get(url(ctx.users.viewer))).status).toBe(404);
    expect((await viewer.get('/api/auth/me')).body.user.avatar_version).toBeNull();
    // removing again is harmless
    expect((await viewer.raw.delete(url(ctx.users.viewer)).set('X-CSRF-Token', viewer.csrf)).status).toBe(200);
  });

  it('changes are audited', async () => {
    const { rows } = await ctx.pool.query(`SELECT summary FROM audit_log WHERE entity_type = 'user' AND summary ILIKE '%profile picture%' ORDER BY id`);
    expect(rows.map((r) => r.summary)).toContain('Changed own profile picture');
    expect(rows.map((r) => r.summary)).toContain('Removed own profile picture');
  });
});

describe('who may change a picture (enforced on the server)', () => {
  it('users cannot change or remove someone else\'s picture', async () => {
    const png = await halves('png');
    for (const a of [contractor, viewer, pm2, pm]) {
      const target = a === pm ? ctx.users.contractor : ctx.users.pm;
      const r = await a.upload(url(target), {}, { buf: png, name: 'x.png' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('You can only change your own profile picture');
      expect((await a.raw.delete(url(target)).set('X-CSRF-Token', a.csrf)).status).toBe(403);
    }
  });

  it('administrators manage anyone\'s picture; nothing else on the account changes', async () => {
    const snap = async () => ({
      user: (await ctx.pool.query('SELECT email, name, role, password_hash, is_active, locked_until, failed_logins FROM users WHERE id = $1', [ctx.users.viewer])).rows[0],
      projects: (await ctx.pool.query('SELECT project_id FROM project_members WHERE user_id = $1 ORDER BY 1', [ctx.users.viewer])).rows,
      sessions: (await ctx.pool.query('SELECT count(*)::int n FROM sessions WHERE user_id = $1', [ctx.users.viewer])).rows[0].n,
    });
    const before = await snap();
    const r = await admin.upload(url(ctx.users.viewer), { name: 'Hacker', role: 'admin', projectIds: ctx.projects.p2 }, { buf: await halves('jpeg'), name: 'v.jpg' });
    expect(r.status).toBe(200);
    expect(await snap()).toEqual(before);
    expect((await viewer.get('/api/auth/me')).status).toBe(200); // still signed in
    const audit = (await ctx.pool.query(`SELECT summary FROM audit_log WHERE summary LIKE 'Changed the profile picture of%' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit.summary).toBe('Changed the profile picture of viewer@test.local');
    expect((await admin.raw.delete(url(ctx.users.viewer)).set('X-CSRF-Token', admin.csrf)).status).toBe(200);
    expect(await snap()).toEqual(before);
  });

  it('requires sign-in and a CSRF token; malformed ids get 404', async () => {
    expect((await request(ctx.app).get(url(ctx.users.pm))).status).toBe(401);
    expect((await pm.raw.post(url(ctx.users.pm)).attach('file', await halves('png'), 'x.png')).status).toBe(403);
    expect((await pm.get('/api/users/not-a-uuid/avatar')).status).toBe(404);
    expect((await admin.upload(url('00000000-0000-4000-8000-000000000000'), {}, { buf: await halves('png'), name: 'x.png' })).status).toBe(404);
  });
});

describe('who may see a picture', () => {
  beforeAll(async () => {
    expect((await admin.upload(url(ctx.users.admin), {}, { buf: await halves('png'), name: 'a.png' })).status).toBe(200);
    expect((await pm2.upload(url(ctx.users.pm2), {}, { buf: await halves('png'), name: 'a.png' })).status).toBe(200);
  });

  it('served privately as WebP with safe headers', async () => {
    const r = await bin(contractor.get(url(ctx.users.pm)));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('private, max-age=3600');
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect((await sharp(r.body as Buffer).metadata()).format).toBe('webp');
  });

  it('people on the same project, the person themself and administrators can see it', async () => {
    expect((await contractor.get(url(ctx.users.pm))).status).toBe(200); // shares PIN 70153699
    expect((await pm.get(url(ctx.users.pm))).status).toBe(200);
    expect((await admin.get(url(ctx.users.pm2))).status).toBe(200);
    expect((await pm.get(url(ctx.users.admin))).status).toBe(200); // admins work on every project
  });

  it('no shared project → looks like no picture (404), so the endpoint is not a user directory', async () => {
    expect((await pm.get(url(ctx.users.pm2))).status).toBe(404);
    expect((await pm2.get(url(ctx.users.pm))).status).toBe(404);
    expect((await outsider.get(url(ctx.users.pm))).status).toBe(404);
    expect((await outsider.get(url(ctx.users.admin))).status).toBe(404);
    const missing = await pm.get(url('00000000-0000-4000-8000-000000000000'));
    expect(missing.status).toBe(404);
    expect((await pm.get(url(ctx.users.pm2))).body).toEqual(missing.body); // same answer as an unknown id
  });

  it('lists used by the app carry the picture version (users admin, members, sign-in)', async () => {
    const users = (await admin.get('/api/users')).body as Array<{ id: string; avatar_version: string | null }>;
    expect(users.find((u) => u.id === ctx.users.pm)?.avatar_version).toMatch(/^\d+$/);
    expect(users.find((u) => u.id === ctx.users.viewer)?.avatar_version).toBeNull();
    const members = (await pm.get(`/api/projects/${ctx.projects.p1}/members`)).body as Array<{ id: string; avatar_version: string | null }>;
    expect(members.find((m) => m.id === ctx.users.pm)?.avatar_version).toMatch(/^\d+$/);
    resetLoginThrottle();
    const login = await request(ctx.app).post('/api/auth/login').send({ email: 'pm@test.local', password: PASSWORD });
    expect(login.body.user.avatar_version).toMatch(/^\d+$/);
  });
});

describe('persistence', () => {
  it('pictures survive an application restart (same database and uploads storage)', async () => {
    const before = await bin(pm.get(url(ctx.users.pm)));
    expect(before.status).toBe(200);
    const app2 = createApp(ctx.pool, ctx.cfg);
    resetLoginThrottle();
    const a = request.agent(app2);
    expect((await a.post('/api/auth/login').send({ email: 'contractor@test.local', password: PASSWORD })).status).toBe(200);
    const after = await bin(a.get(url(ctx.users.pm)));
    expect(after.status).toBe(200);
    expect(Buffer.compare(after.body as Buffer, before.body as Buffer)).toBe(0);
  });

  it('pictures are stored only in the uploads storage, never in the source tree or public build', () => {
    for (const f of files()) expect(f).toMatch(/^[0-9a-f-]{36}\.webp$/);
    expect(fs.existsSync(path.resolve('public/_avatars'))).toBe(false);
    expect(fs.existsSync(path.resolve('dist/_avatars'))).toBe(false);
    expect(fs.readdirSync(dir()).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
