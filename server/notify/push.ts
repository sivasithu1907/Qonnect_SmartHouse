// Standards-based Web Push (RFC 8030 / 8291 / 8292) via the `web-push` library with VAPID.
// Subscription keys and the VAPID private key are never logged.
import crypto from 'node:crypto';
import webpush from 'web-push';
import type { AppConfig } from '../config';

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushMessage {
  title: string;
  body: string;
  url: string;   // same-origin in-app route
  tag: string;   // collapses duplicates on the device
}
export type SendResult = { ok: true } | { ok: false; gone: boolean; statusCode?: number };

export interface PushSender {
  readonly configured: boolean;
  readonly publicKey: string;
  send(sub: StoredSubscription, msg: PushMessage, topic: string): Promise<SendResult>;
}

export function pushConfigured(cfg: AppConfig) {
  return !!(cfg.vapidPublicKey && cfg.vapidPrivateKey && cfg.vapidSubject);
}

/** Real sender. The payload is encrypted end-to-end for the browser (aes128gcm). */
/** Checks the VAPID settings once (format of keys and subject) without logging their values. */
export function vapidProblem(cfg: AppConfig): string | null {
  if (!pushConfigured(cfg)) return null;
  try {
    webpush.getVapidHeaders('https://push.example', cfg.vapidSubject, cfg.vapidPublicKey, cfg.vapidPrivateKey, 'aes128gcm');
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0].replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
  }
}

export function createWebPushSender(cfg: AppConfig): PushSender {
  const problem = vapidProblem(cfg);
  if (problem) console.warn(`Web push disabled: VAPID settings are invalid (${problem}). Check VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.`);
  const configured = pushConfigured(cfg) && !problem;
  const vapid = configured ? { subject: cfg.vapidSubject, publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey } : null;
  return {
    configured,
    publicKey: configured ? cfg.vapidPublicKey : '',
    async send(sub, msg, topic) {
      if (!vapid) return { ok: false, gone: false };
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(msg),
          { vapidDetails: vapid, TTL: 24 * 3600, urgency: 'normal', topic, timeout: 10_000, contentEncoding: 'aes128gcm' },
        );
        return { ok: true };
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode;
        // 404 / 410: the subscription has expired or was revoked by the user → remove it
        return { ok: false, gone: statusCode === 404 || statusCode === 410, statusCode };
      }
    },
  };
}

/** Push "Topic" header (max 32 URL-safe chars): the push service replaces an undelivered message with the same topic. */
export const topicFor = (key: string) => crypto.createHash('sha256').update(key).digest('base64url').slice(0, 32);

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
function b64urlBytes(v: string): number {
  if (!B64URL.test(v)) return -1;
  return Buffer.from(v.replace(/=+$/, ''), 'base64url').length;
}

/**
 * Validates a PushSubscription from the browser. Endpoints must be HTTPS URLs on a known push
 * service (prevents the server being used to call arbitrary/internal URLs); keys must be a
 * 65-byte uncompressed P-256 point and a 16-byte auth secret.
 */
export function validateSubscription(cfg: AppConfig, s: { endpoint: string; keys: { p256dh: string; auth: string } }): string | null {
  let u: URL;
  try {
    u = new URL(s.endpoint);
  } catch {
    return 'Invalid push endpoint';
  }
  if (u.protocol !== 'https:' && !(cfg.pushAllowInsecureEndpoints && u.protocol === 'http:')) return 'Push endpoint must use HTTPS';
  if (u.username || u.password) return 'Invalid push endpoint';
  const host = u.hostname.toLowerCase();
  const allowed = cfg.pushAllowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) return 'Push endpoint is not from a recognised browser push service';
  if (b64urlBytes(s.keys.p256dh) !== 65) return 'Invalid subscription key';
  if (b64urlBytes(s.keys.auth) !== 16) return 'Invalid subscription auth secret';
  return null;
}
