import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Download, Laptop, Send, Trash2 } from 'lucide-react';
import { api, get, post } from '../lib/api';
import type { Project } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { disablePushOnThisDevice, enablePush, getPushState, type PushState } from '../lib/push';
import { isIOS } from '../lib/pwa';
import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '../../shared/constants';
import { IosInstallSteps } from '../components/InstallApp';
import { Badge, Button, Card, Notice, PageHeader, Spinner, useUi } from '../components/ui';
import { useSession } from '../lib/session';

interface Prefs { push_enabled: boolean; event_types: string[]; muted_project_ids: string[] }
interface Device { id: string; user_agent: string; created_at: string; last_success_at: string | null; failure_count: number }

const STATE_TEXT: Record<PushState, { label: string; tone: 'emerald' | 'amber' | 'rose' | 'slate' | 'sky' }> = {
  enabled: { label: 'Enabled on this device', tone: 'emerald' },
  'granted-off': { label: 'Allowed, but off on this device', tone: 'sky' },
  default: { label: 'Permission not requested yet', tone: 'amber' },
  denied: { label: 'Blocked in this browser', tone: 'rose' },
  unsupported: { label: 'Not supported by this browser', tone: 'slate' },
  'ios-needs-install': { label: 'Add to Home Screen first', tone: 'amber' },
  'server-off': { label: 'Not configured on the server yet', tone: 'slate' },
};

function deviceName(ua: string) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

/** Relevant event types for the user's role (others are hidden, since they'd never fire). */
function relevantTypes(can: (c: string) => boolean): NotificationEventType[] {
  return NOTIFICATION_EVENT_TYPES.filter((t) => {
    if (t === 'payment_due') return can('payments.read');
    if (t === 'material_date' || t === 'material_due') return can('materials.write') || can('materials.contractor');
    return true;
  });
}

export function NotificationSettings({ projects, onInstallApp }: { projects: Project[]; onInstallApp: () => void }) {
  const { can } = useSession();
  const { toast, confirm } = useUi();
  const [state, setState] = useState<PushState | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [st, p, d] = await Promise.all([getPushState(), get<Prefs>('/api/notifications/preferences'), get<Device[]>('/api/notifications/subscriptions')]);
    setState(st); setPrefs(p); setDevices(d);
  }, []);
  useEffect(() => { void refresh().catch((e) => toast((e as Error).message, 'error')); }, [refresh, toast]);

  const savePrefs = async (patch: Partial<Prefs>) => {
    try { setPrefs(await api<Prefs>('PUT', '/api/notifications/preferences', patch)); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const onEnable = async () => {
    setBusy(true);
    try {
      const st = await enablePush(); // the ONLY place the browser permission prompt can appear
      setState(st);
      if (st === 'enabled') toast('Push notifications enabled on this device');
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const onDisableDevice = async () => {
    setBusy(true);
    try { await disablePushOnThisDevice(); toast('Push notifications turned off on this device'); await refresh(); } finally { setBusy(false); }
  };
  const onTest = async () => {
    try {
      const r = await post<{ status: string }>('/api/notifications/test');
      toast(r.status === 'sent' || r.status === 'partial' ? 'Test notification sent — it should appear in a few seconds.' : 'No active device received it. Enable notifications on this device first.', r.status === 'sent' || r.status === 'partial' ? 'success' : 'error');
      await refresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const removeDevice = async (d: Device) => {
    if (!(await confirm(<>Stop push notifications on <b>{deviceName(d.user_agent)}</b>?</>, { confirmLabel: 'Remove device', danger: true }))) return;
    await api('DELETE', `/api/notifications/subscriptions/${d.id}`);
    await refresh();
  };

  if (!state || !prefs) return <Spinner />;
  const types = relevantTypes(can);
  const st = STATE_TEXT[state];

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader icon={<Bell className="w-5 h-5" />} title="Notifications" subtitle="Choose which alerts you receive. Alerts always appear in the bell list in the header; push notifications are optional." />

      <Card title="Push notifications on this device" actions={<Badge tone={st.tone}>{st.label}</Badge>}>
        <div className="space-y-3 text-sm text-slate-700">
          {state === 'default' && (
            <>
              <p>Get an alert on this device even when Qonnect isn't open. Your browser will ask for permission after you tap the button.</p>
              <Button variant="primary" busy={busy} onClick={onEnable}><Bell className="w-4 h-4" />Enable notifications</Button>
            </>
          )}
          {state === 'granted-off' && (
            <>
              <p>Notifications are allowed in this browser but not switched on for Qonnect on this device.</p>
              <Button variant="primary" busy={busy} onClick={onEnable}><Bell className="w-4 h-4" />Enable notifications</Button>
            </>
          )}
          {state === 'enabled' && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={onTest}><Send className="w-4 h-4" />Send test notification</Button>
              <Button variant="danger" busy={busy} onClick={onDisableDevice}><BellOff className="w-4 h-4" />Turn off on this device</Button>
            </div>
          )}
          {state === 'denied' && (
            <Notice tone="amber" title="Notifications are blocked for Qonnect in this browser.">
              Qonnect won't ask again. You can keep using the app normally, and all alerts still appear in the bell list in the header.
              To allow push later, open your browser's site settings for this address (the padlock or site icon next to the address bar), set <b>Notifications</b> to <b>Allow</b>, then return here and tap Enable.
            </Notice>
          )}
          {state === 'unsupported' && (
            <Notice tone="sky">
              This browser doesn't support web push notifications. Everything else works, and your alerts still appear in the bell list in the header.
              Recent versions of Chrome, Edge, Firefox and Samsung Internet support push, as does Safari on macOS 13+ and iPhone/iPad 16.4+ from the Home Screen.
            </Notice>
          )}
          {state === 'server-off' && (
            <Notice tone="sky">Push delivery hasn't been set up on this server yet. Your alerts still appear in the bell list in the header.</Notice>
          )}
          {state === 'ios-needs-install' && (
            <div className="space-y-3">
              <p>On iPhone and iPad, web push only works after Qonnect is added to the Home Screen and opened from there.</p>
              <IosInstallSteps />
              <p className="text-xs text-slate-500">Then open Qonnect from the Home Screen, come back to this page and tap <b>Enable notifications</b>.</p>
            </div>
          )}
          {!isIOS() && state !== 'enabled' && state !== 'denied' && (
            <button onClick={onInstallApp} className="text-xs font-semibold text-sky-700 hover:underline inline-flex items-center gap-1"><Download className="w-3.5 h-3.5" />Install Qonnect as an app</button>
          )}
        </div>
      </Card>

      <Card title="What to notify me about" subtitle="Applies to the bell list and to push notifications.">
        <ul className="space-y-2">
          {types.map((t) => {
            const on = prefs.event_types.includes(t);
            return (
              <li key={t}>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={on}
                    onChange={() => savePrefs({ event_types: on ? prefs.event_types.filter((x) => x !== t) : [...prefs.event_types, t] })} />
                  <span><span className="font-semibold text-slate-800">{NOTIFICATION_EVENT_LABELS[t].label}</span>
                    <span className="block text-xs text-slate-500">{NOTIFICATION_EVENT_LABELS[t].help}</span></span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 pt-3 border-t border-slate-100">
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={prefs.push_enabled} onChange={() => savePrefs({ push_enabled: !prefs.push_enabled })} />
            <span><b>Send push notifications</b> to my devices <span className="text-xs text-slate-500">(turn off to keep alerts in the bell list only)</span></span>
          </label>
        </div>
      </Card>

      {projects.length > 1 && (
        <Card title="Projects" subtitle="Untick a project to stop all its alerts for you.">
          <ul className="space-y-1.5">
            {projects.map((p) => {
              const muted = prefs.muted_project_ids.includes(p.id);
              return (
                <li key={p.id}>
                  <label className="flex items-center gap-3 text-sm">
                    <input type="checkbox" checked={!muted}
                      onChange={() => savePrefs({ muted_project_ids: muted ? prefs.muted_project_ids.filter((x) => x !== p.id) : [...prefs.muted_project_ids, p.id] })} />
                    <span className="font-semibold text-slate-800">{p.name} — {p.code}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card title="My devices" subtitle="Devices where you enabled push. Only you can see or remove these.">
        {devices.length === 0 ? <p className="text-xs text-slate-500">No devices yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Laptop className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{deviceName(d.user_agent)}</div>
                    <div className="text-[11px] text-slate-500">Added {formatDateTime(d.created_at)}{d.last_success_at ? ` · last delivered ${formatDateTime(d.last_success_at)}` : ''}{d.failure_count ? ` · ${d.failure_count} failed attempt(s)` : ''}</div>
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeDevice(d)} title="Remove device"><Trash2 className="w-3.5 h-3.5 text-rose-500" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-slate-500">Push notifications contain only a short general message (for example “A payment milestone needs attention”) and the project code. Tapping one opens Qonnect, where you sign in as usual to see details.</p>
    </div>
  );
}
