// Browser side of Web Push. Permission is requested ONLY from enablePush(), which the
// Notifications page calls when the user taps "Enable notifications".
import { get, post, api } from './api';
import { isIOS, isStandalone, pushSupported } from './pwa';

export type PushState =
  | 'unsupported'        // browser has no Push API
  | 'ios-needs-install'  // iPhone/iPad: add to Home Screen first
  | 'server-off'         // server has no VAPID keys yet
  | 'default'            // permission not requested yet
  | 'denied'             // user blocked notifications
  | 'granted-off'        // permission granted but no subscription on this device
  | 'enabled';           // subscribed on this device

interface PushConfig { configured: boolean; publicKey: string }
let configCache: PushConfig | null = null;
export async function pushConfig(): Promise<PushConfig> {
  if (!configCache) configCache = await get<PushConfig>('/api/notifications/push-config');
  return configCache;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function getPushState(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return 'ios-needs-install';
  if (!pushSupported()) return 'unsupported';
  const cfg = await pushConfig().catch(() => ({ configured: false, publicKey: '' }));
  if (!cfg.configured) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';
  return (await currentSubscription()) ? 'enabled' : 'granted-off';
}

function keyToBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function sendToServer(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
  await post('/api/notifications/subscriptions', { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: json.keys });
}

const SUBSCRIBE_TIMEOUT_MS = 20_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Must be called from a user gesture (button tap). Never re-prompts when permission is denied. */
export async function enablePush(): Promise<PushState> {
  const state = await getPushState();
  if (state === 'unsupported' || state === 'ios-needs-install' || state === 'server-off' || state === 'denied') return state;
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return result === 'denied' ? 'denied' : 'default';
  }
  const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  const { publicKey } = await pushConfig();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) as BufferSource }),
        SUBSCRIBE_TIMEOUT_MS,
      );
    } catch (e) {
      // e.g. the browser's push service is unreachable (network/firewall) or disabled in this browser
      throw new Error((e as Error).message === 'timeout'
        ? "This browser couldn't reach its push service. Check your connection and try again. Alerts still appear in the bell list."
        : "This browser couldn't turn on push notifications. Alerts still appear in the bell list.");
    }
  }
  await sendToServer(sub);
  return 'enabled';
}

/** Turns push off for this device (browser + server). Other devices keep their subscriptions. */
export async function disablePushOnThisDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await post('/api/notifications/subscriptions/remove', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
}

/** On app start: if this browser is subscribed, make sure the server has the current subscription for this user. */
export async function syncSubscription(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const cfg = await pushConfig();
    if (!cfg.configured) return;
    const sub = await currentSubscription();
    const prefs = await get<{ push_enabled: boolean }>('/api/notifications/preferences');
    if (sub && prefs.push_enabled) await sendToServer(sub);
  } catch { /* best effort */ }
}

/** Before signing out on a shared device: stop this device receiving the user's alerts. */
export async function detachDeviceOnLogout(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) await api('POST', '/api/notifications/subscriptions/remove', { endpoint: sub.endpoint });
  } catch { /* ignore */ }
}
