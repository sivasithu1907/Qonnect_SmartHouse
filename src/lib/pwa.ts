// PWA helpers: service worker registration/updates, install prompt and platform detection.

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Call once at startup (before React renders) so the browser's install event is not missed. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own "Install app" option instead of the mini-infobar
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}
export const onInstallStateChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const canPromptInstall = () => !!deferredPrompt;

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  const p = deferredPrompt;
  deferredPrompt = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  notify();
  return outcome;
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod, and iPad (iPadOS reports itself as "Macintosh" with touch). */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function iosVersion(): number | null {
  const m = /OS (\d+)[_.](\d+)/.exec(navigator.userAgent) || /Version\/(\d+)\.(\d+)/.exec(navigator.userAgent);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// ------------------------------------------------------------------ service worker
let waitingWorker: ServiceWorker | null = null;
const updateListeners = new Set<() => void>();
export const onUpdateAvailable = (fn: () => void) => { updateListeners.add(fn); return () => updateListeners.delete(fn); };
export const updateAvailable = () => !!waitingWorker;

/** Registers /sw.js (production only). A new version waits until the user chooses to reload. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const track = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = w;
            updateListeners.forEach((l) => l());
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) {
        waitingWorker = reg.waiting;
        updateListeners.forEach((l) => l());
      }
      reg.addEventListener('updatefound', () => track(reg.installing));
      // check for a new version when the app comes back to the foreground, and hourly
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void reg.update().catch(() => undefined); });
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60_000);
    } catch {
      /* registration failure never blocks the app */
    }
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !waitingWorker) return;
    reloading = true;
    window.location.reload();
  });
}

/** Activates the waiting version; the page reloads once it takes control. */
export function applyUpdate() {
  waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
}
