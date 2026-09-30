// Runtime configuration from environment variables. No secrets are hard-coded.
import path from 'node:path';
import { resolveDatabaseUrl } from './db';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  uploadDir: string;
  maxUploadMb: number;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: number | boolean;
  appOrigin: string; // optional, enables Origin header checks when set
  timeZone: string;
  staticDir: string;
  // Web Push (VAPID). Push is disabled when the keys are not set.
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  pushAllowedHosts: string[];      // host suffixes of trusted push services (SSRF protection)
  pushAllowInsecureEndpoints: boolean; // tests only
  notifySchedulerEnabled: boolean;
}

const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com',          // Chrome, Edge (Chromium), Android
  'push.services.mozilla.com',                              // Firefox
  'push.apple.com',                                          // Safari / iOS / iPadOS
  'notify.windows.com',                                      // legacy Edge / Windows
];

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const databaseUrl = overrides.databaseUrl ?? resolveDatabaseUrl();
  const tp = process.env.TRUST_PROXY;
  return {
    nodeEnv,
    port: int('PORT', 8080),
    databaseUrl,
    uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './data/uploads'),
    maxUploadMb: int('MAX_UPLOAD_MB', 15),
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    cookieSecure: bool('COOKIE_SECURE', nodeEnv === 'production'),
    trustProxy: tp === undefined || tp === '' ? false : /^\d+$/.test(tp) ? Number(tp) : bool('TRUST_PROXY', false),
    appOrigin: (process.env.APP_ORIGIN ?? '').replace(/\/$/, ''),
    timeZone: process.env.APP_TIMEZONE ?? 'Asia/Qatar',
    staticDir: path.resolve(process.env.STATIC_DIR ?? './dist'),
    vapidPublicKey: (process.env.VAPID_PUBLIC_KEY ?? '').trim(),
    vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY ?? '').trim(),
    vapidSubject: (process.env.VAPID_SUBJECT ?? '').trim(),
    pushAllowedHosts: [
      ...DEFAULT_PUSH_HOSTS,
      ...(process.env.PUSH_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    ],
    pushAllowInsecureEndpoints: false,
    notifySchedulerEnabled: bool('NOTIFY_SCHEDULER', nodeEnv === 'production'),
    ...overrides,
  };
}
