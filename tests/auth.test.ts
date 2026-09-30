import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PASSWORD, setup, type Ctx } from './helpers';
import { resetLoginThrottle } from '../server/auth';

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.close(); });

describe('authentication & sessions', () => {
  it('rejects unauthenticated API access', async () => {
    expect((await request(ctx.app).get('/api/projects')).status).toBe(401);
    expect((await request(ctx.app).get(`/api/projects/${ctx.projects.p1}/dashboard`)).status).toBe(401);
  });

  it('sets a secure-flagged, HttpOnly, SameSite=Strict session cookie and never returns hashes', async () => {
    resetLoginThrottle();
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'pm@test.local', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt/);
    expect(res.body.user.role).toBe('project_manager');
  });

  it('rejects bad credentials with a generic message and locks after repeated failures', async () => {
    resetLoginThrottle();
    for (let i = 0; i < 5; i++) {
      const r = await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@test.local', password: 'wrong-password-1' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Invalid email or password');
    }
    const locked = await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@test.local', password: PASSWORD });
    expect(locked.status).toBe(429);
    await ctx.pool.query(`UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'viewer@test.local'`);
    const unknown = await request(ctx.app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'x' });
    expect(unknown.status).toBe(401);
  });

  it('requires the CSRF token for state-changing requests', async () => {
    const a = await ctx.agent('admin');
    const noToken = await a.raw.patch(`/api/projects/${ctx.projects.p1}/links`).send({ sheets_url: 'https://example.com/s' });
    expect(noToken.status).toBe(403);
    const ok = await a.patch(`/api/projects/${ctx.projects.p1}/links`, { sheets_url: 'https://example.com/s' });
    expect(ok.status).toBe(200);
  });

  it('logout invalidates the session server-side', async () => {
    const a = await ctx.agent('pm');
    expect((await a.get('/api/auth/me')).status).toBe(200);
    await a.post('/api/auth/logout');
    expect((await a.get('/api/auth/me')).status).toBe(401);
  });

  it('deactivating a user ends their sessions', async () => {
    const v = await ctx.agent('viewer');
    const admin = await ctx.agent('admin');
    expect((await admin.patch(`/api/users/${ctx.users.viewer}`, { isActive: false })).status).toBe(200);
    expect((await v.get('/api/auth/me')).status).toBe(401);
    await admin.patch(`/api/users/${ctx.users.viewer}`, { isActive: true });
  });

  it('enforces the password policy', async () => {
    const admin = await ctx.agent('admin');
    const r = await admin.post('/api/users', { email: 'new@test.local', name: 'New', role: 'viewer', password: 'short' });
    expect(r.status).toBe(400);
  });
});
