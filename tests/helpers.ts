// Test harness: fresh PostgreSQL schema per test file, real migrations + seed,
// one user per role, and authenticated supertest agents (cookie + CSRF).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import request from 'supertest';
import type pg from 'pg';
import { createPool } from '../server/db';
import { createApp } from '../server/app';
import { loadConfig, type AppConfig } from '../server/config';
import type { PushSender } from '../server/notify/push';
import type { Notifier } from '../server/notify/notifier';
import { runMigrations } from '../server/lib/migrate';
import { seedProjects } from '../server/seed/apply';
import { hashPassword } from '../server/lib/passwords';
import { resetLoginThrottle } from '../server/auth';

const TEST_DB_ENV = process.env.TEST_DATABASE_URL;
if (!TEST_DB_ENV) throw new Error('Set TEST_DATABASE_URL to a throw-away PostgreSQL database (its public schema is dropped by the tests).');
export const TEST_DB: string = TEST_DB_ENV;
export const PASSWORD = 'TestPassword123';

export interface Ctx {
  pool: pg.Pool;
  app: ReturnType<typeof createApp>;
  notifier: Notifier;
  cfg: AppConfig;
  uploadDir: string;
  projects: { p1: string; p2: string };
  users: Record<string, string>;
  agent: (role: string) => Promise<Agent>;
  close: () => Promise<void>;
}

export interface Agent {
  get: (url: string) => request.Test;
  post: (url: string, body?: unknown) => request.Test;
  patch: (url: string, body?: unknown) => request.Test;
  upload: (url: string, fields: Record<string, string>, file: { buf: Buffer; name: string }) => request.Test;
  raw: ReturnType<typeof request.agent>;
  csrf: string;
}

export async function setup(opts: { pushSender?: PushSender; cfg?: Partial<AppConfig> } = {}): Promise<Ctx> {
  process.env.NODE_ENV = 'test';
  const pool = createPool(TEST_DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, path.resolve('migrations'), () => undefined);
  await seedProjects(pool, () => undefined);
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-uploads-'));
  const cfg = loadConfig({ databaseUrl: TEST_DB, uploadDir, cookieSecure: false, nodeEnv: 'test', staticDir: '/nonexistent', maxUploadMb: 1, notifySchedulerEnabled: false, ...opts.cfg });
  const app = createApp(pool, cfg, { pushSender: opts.pushSender });

  const pr = await pool.query('SELECT id, code FROM projects');
  const p1 = pr.rows.find((r) => r.code === 'PIN 70153699').id;
  const p2 = pr.rows.find((r) => r.code === 'PIN 70153016').id;

  const hash = await hashPassword(PASSWORD);
  const users: Record<string, string> = {};
  const defs: Array<[string, string, string[]]> = [
    ['admin', 'admin', []],
    ['pm', 'project_manager', [p1]],
    ['pm2', 'project_manager', [p2]],
    ['contractor', 'contractor', [p1]],
    ['contractor2', 'contractor', [p1]],
    ['consultant', 'consultant', [p1]],
    ['consultant2', 'consultant', [p1]],
    ['viewer', 'viewer', [p1]],
    ['outsider', 'viewer', []],
  ];
  for (const [key, role, projects] of defs) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [`${key}@test.local`, key, role, hash],
    );
    users[key] = rows[0].id;
    for (const p of projects) await pool.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2)', [p, rows[0].id]);
  }

  const agent = async (key: string): Promise<Agent> => {
    resetLoginThrottle();
    const raw = request.agent(app);
    const res = await raw.post('/api/auth/login').send({ email: `${key}@test.local`, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status} ${JSON.stringify(res.body)}`);
    const csrf = res.body.csrfToken as string;
    return {
      raw,
      csrf,
      get: (url) => raw.get(url),
      post: (url, body) => raw.post(url).set('X-CSRF-Token', csrf).send((body ?? {}) as object),
      patch: (url, body) => raw.patch(url).set('X-CSRF-Token', csrf).send((body ?? {}) as object),
      upload: (url, fields, file) => {
        let t = raw.post(url).set('X-CSRF-Token', csrf);
        for (const [k, v] of Object.entries(fields)) t = t.field(k, v);
        return t.attach('file', file.buf, file.name);
      },
    };
  };

  return {
    pool, app, notifier: app.locals.notifier as Notifier, cfg, uploadDir, projects: { p1, p2 }, users, agent,
    close: async () => {
      await pool.end();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
