// End-to-end Web Push through the REAL sender (web-push library, VAPID, aes128gcm encryption)
// to a local push-service stand-in. The test acts as the browser: it owns the subscription
// private key, decrypts the payload and verifies the VAPID JWT signature.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { setup, type Ctx, type Agent } from './helpers';
import { createWebPushSender } from '../server/notify/push';
import { loadConfig } from '../server/config';

const require = createRequire(import.meta.url);
const ece = require('http_ece') as { decrypt: (buf: Buffer, params: Record<string, unknown>) => Buffer };

interface Received { path: string; headers: http.IncomingHttpHeaders; body: Buffer }
let server: https.Server;
let port = 0;
const received: Received[] = [];
let nextStatus = 201;

let ctx: Ctx;
let pm: Agent;
let contractor: Agent;
const vapid = webpush.generateVAPIDKeys();

const browserKeys = crypto.createECDH('prime256v1');
browserKeys.generateKeys();
const authSecret = crypto.randomBytes(16);

beforeAll(async () => {
  // local HTTPS "push service" with a throw-away self-signed certificate for 127.0.0.1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  (https.globalAgent.options as { ca?: Buffer }).ca = cert; // trust it for this test process only
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = nextStatus;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;

  const cfgOverrides = {
    vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, vapidSubject: 'mailto:ops@example.test',
    pushAllowedHosts: ['127.0.0.1'],
  };
  const realSender = createWebPushSender(loadConfig({ databaseUrl: 'postgres://unused', ...cfgOverrides }));
  ctx = await setup({ pushSender: realSender, cfg: cfgOverrides });
  pm = await ctx.agent('pm');
  contractor = await ctx.agent('contractor');
});
afterAll(async () => {
  await ctx.close();
  await new Promise((r) => server.close(r));
});

describe('real Web Push delivery', () => {
  it('delivers an encrypted, VAPID-signed, generic payload that the browser can decrypt', async () => {
    const cfg = await contractor.get('/api/notifications/push-config');
    expect(cfg.body).toEqual({ configured: true, publicKey: vapid.publicKey });
    const sub = {
      endpoint: `https://127.0.0.1:${port}/push/device-1`,
      keys: { p256dh: browserKeys.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    };
    expect((await contractor.post('/api/notifications/subscriptions', sub)).status).toBe(201);

    const v = await pm.post(`/api/projects/${ctx.projects.p1}/visits/site`, { purpose: 'Private purpose text', assigned_user_id: ctx.users.contractor });
    await ctx.notifier.flush();
    expect(received).toHaveLength(1);
    const msg = received[0];
    expect(msg.path).toBe('/push/device-1');
    expect(msg.headers['content-encoding']).toBe('aes128gcm');
    expect(Number(msg.headers.ttl)).toBe(86400);
    expect(String(msg.headers.topic)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);

    // --- decrypt as the browser would
    const plain = ece.decrypt(msg.body, { version: 'aes128gcm', privateKey: browserKeys, authSecret: authSecret.toString('base64url') });
    const payload = JSON.parse(plain.toString('utf8'));
    expect(payload).toMatchObject({
      title: 'Qonnect · PIN 70153699',
      body: 'A site visit has been assigned to you.',
      url: `/#/site/${ctx.projects.p1}/${v.body.id}`,
    });
    expect(plain.toString()).not.toContain('Private purpose text');

    // --- verify the VAPID JWT (RFC 8292) with the public key
    const auth = String(msg.headers.authorization);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    expect(m).toBeTruthy();
    const [token, k] = [m![1], m![2]];
    expect(k).toBe(vapid.publicKey);
    const [h, p, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.aud).toBe(`https://127.0.0.1:${port}`);
    expect(claims.sub).toBe('mailto:ops@example.test');
    const raw = Buffer.from(vapid.publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);

    const n = (await ctx.pool.query('SELECT push_status FROM notifications WHERE user_id = $1', [ctx.users.contractor])).rows;
    expect(n).toEqual([{ push_status: 'sent' }]);
  });

  it('removes the subscription when the push service answers 410 Gone', async () => {
    nextStatus = 410;
    await pm.post(`/api/projects/${ctx.projects.p1}/visits/site`, { purpose: 'Second', assigned_user_id: ctx.users.contractor });
    await ctx.notifier.flush();
    expect(received).toHaveLength(2);
    expect((await ctx.pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [ctx.users.contractor])).rows).toHaveLength(0);
    nextStatus = 201;
  });
});
