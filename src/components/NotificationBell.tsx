import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, Settings } from 'lucide-react';
import { get, post } from '../lib/api';
import type { AppNotification } from '../lib/types';
import { formatDateTime } from '../lib/format';

/** Header bell with the user's in-app notifications (their own only). Refreshes every minute and on focus. */
export function NotificationBell({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ items: AppNotification[]; unread: number }>({ items: [], unread: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try { setData(await get('/api/notifications?limit=30')); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const openItem = async (n: AppNotification) => {
    setOpen(false);
    if (!n.read_at) await post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    const hash = n.url.includes('#') ? n.url.slice(n.url.indexOf('#')) : '';
    if (hash) window.location.hash = hash;
    void load();
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => { setOpen(!open); if (!open) void load(); }} className="relative p-2 rounded-lg text-slate-600 hover:bg-slate-100" aria-label={`Notifications${data.unread ? ` (${data.unread} unread)` : ''}`}>
        <Bell className="w-5 h-5" />
        {data.unread > 0 && <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 sm:w-96 bg-white rounded-xl shadow-xl border border-slate-200 z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
            <span className="text-xs font-bold text-slate-700">Notifications</span>
            <div className="flex items-center gap-1">
              {data.unread > 0 && <button onClick={async () => { await post('/api/notifications/read-all'); void load(); }} className="text-[11px] font-semibold text-sky-700 hover:underline flex items-center gap-1"><CheckCheck className="w-3.5 h-3.5" />Mark all read</button>}
              <button onClick={() => { setOpen(false); onOpenSettings(); }} className="p-1 text-slate-500 hover:text-slate-800" title="Notification settings" aria-label="Notification settings"><Settings className="w-4 h-4" /></button>
            </div>
          </div>
          <ul className="max-h-96 overflow-y-auto divide-y divide-slate-100">
            {data.items.length === 0 && <li className="px-3 py-6 text-center text-xs text-slate-500">No notifications yet.</li>}
            {data.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => openItem(n)} className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 ${n.read_at ? '' : 'bg-sky-50/60'}`}>
                  <div className="flex items-start gap-2">
                    {!n.read_at && <span className="mt-1.5 w-2 h-2 rounded-full bg-sky-600 shrink-0" />}
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900">{n.body}</div>
                      <div className="text-[11px] text-slate-500">{n.project_code} · {formatDateTime(n.created_at)}</div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
