import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, History, MessageSquare } from 'lucide-react';
import { post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { Avatar } from '../Avatar';
import { Button, Card, inputCls, useUi } from '../ui';

// Building blocks shared by Consultant Visits and Site Visits (same look and behaviour).

export function DateTile({ iso, muted }: { iso: string | null | undefined; muted?: boolean }) {
  if (!iso) return <span className="w-13 h-13 grid place-items-center rounded-lg border border-dashed border-slate-200 text-[10px] text-slate-400 text-center leading-tight py-2">No date</span>;
  const d = new Date(iso);
  return (
    <span className={`grid place-items-center rounded-lg border py-1.5 ${muted ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-sky-100 bg-sky-50 text-sky-800'}`} aria-hidden="true">
      <span className="text-[10px] font-bold uppercase">{d.toLocaleString('en-GB', { month: 'short' })}</span>
      <span className="text-lg font-bold leading-none">{d.getDate()}</span>
    </span>
  );
}

export function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-0.5 text-slate-800 break-words">{children}</dd></div>;
}

export interface CalendarEntry { id: string; title: string; iso: string | null; tone: 'sky' | 'amber' | 'emerald' | 'slate'; struck?: boolean; label: string }
const TONE: Record<CalendarEntry['tone'], string> = { sky: 'bg-sky-50 text-sky-800', amber: 'bg-amber-50 text-amber-800', emerald: 'bg-emerald-50 text-emerald-800', slate: 'bg-slate-100 text-slate-500' };

/** Month grid (weeks start on Monday) in the browser's time zone — the same zone the date & time fields use. */
export function VisitCalendar({ entries, onOpen }: { entries: CalendarEntry[]; onOpen: (id: string) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const first = new Date(month);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    if (!e.iso) continue;
    const k = key(new Date(e.iso));
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const undated = entries.filter((e) => !e.iso);
  const today = key(new Date());
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft className="w-4 h-4" /></Button>
        <h3 className="text-sm font-bold text-slate-900">{month.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</h3>
        <Button size="sm" variant="ghost" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight className="w-4 h-4" /></Button>
      </div>
      <div className="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden text-xs" data-testid="visit-calendar">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="bg-slate-50 px-1.5 py-1 font-semibold text-slate-500 text-center">{d}</div>)}
        {days.map((d) => {
          const items = (byDay.get(key(d)) ?? []).sort((a, b) => Date.parse(a.iso!) - Date.parse(b.iso!));
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div key={key(d)} className={`bg-white min-h-[4.5rem] p-1 min-w-0 ${inMonth ? '' : 'bg-slate-50/70 text-slate-400'}`}>
              <div className={`text-[11px] font-semibold ${key(d) === today ? 'inline-grid place-items-center w-5 h-5 rounded-full bg-sky-600 text-white' : ''}`}>{d.getDate()}</div>
              <div className="space-y-0.5 mt-0.5">
                {items.slice(0, 3).map((e) => (
                  <button key={e.id} type="button" onClick={() => onOpen(e.id)} title={`${e.title} — ${e.label}`} aria-label={`${e.title}, ${e.label}, ${formatDateTime(e.iso)}`}
                    className={`block w-full truncate text-left rounded px-1 py-0.5 text-[10px] font-semibold ${TONE[e.tone]} ${e.struck ? 'line-through' : ''}`}>
                    {new Date(e.iso!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} {e.title}
                  </button>
                ))}
                {items.length > 3 && <span className="block text-[10px] text-slate-500">+{items.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
      {undated.length > 0 && <p className="mt-2 text-xs text-slate-500">{undated.length} visit{undated.length === 1 ? '' : 's'} without a date: {undated.map((e) => <button key={e.id} type="button" className="underline mr-2" onClick={() => onOpen(e.id)}>{e.title}</button>)}</p>}
    </Card>
  );
}

/** Comments with author and time; posting needs write access to the visit (checked on the server). */
export function Comments({ base, type, visitId, canPost, onPosted }: { base: string; type: 'consultant' | 'site'; visitId: string; canPost: boolean; onPosted: () => Promise<void> | void }) {
  const { data, reload } = useApi<Array<{ id: string; body: string; created_at: string; author_id: string | null; author_name: string | null; author_avatar_version?: string | null }>>(`${base}/${type}/${visitId}/comments`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  return (
    <section className="border border-slate-200 rounded-lg p-3">
      <h4 className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" />Comments</h4>
      {!data ? <p className="text-xs text-slate-400">Loading…</p> : data.length === 0 ? <p className="text-xs text-slate-500 mb-2">No comments yet.</p> : (
        <ul className="space-y-2 mb-3">
          {data.map((c) => (
            <li key={c.id} className="text-xs flex items-start gap-2">
              <Avatar userId={c.author_id} name={c.author_name ?? '?'} version={c.author_avatar_version} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-slate-500"><span className="font-semibold text-slate-700">{c.author_name ?? 'Unknown'}</span> · {formatDateTime(c.created_at)}</p>
                <p className="text-slate-800 whitespace-pre-wrap break-words" dir="auto">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canPost && (
        <form className="flex flex-col sm:flex-row gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          try { await post(`${base}/${type}/${visitId}/comments`, { body: text }); setText(''); await reload(); await onPosted(); } catch (ex) { toast((ex as Error).message, 'error'); } finally { setBusy(false); }
        }}>
          <textarea dir="auto" rows={2} className={inputCls} placeholder="Add a comment" aria-label="Add a comment" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" busy={busy} disabled={!text.trim()}>Post</Button>
        </form>
      )}
    </section>
  );
}

/** Collapsible activity history from the audit log. */
export function VisitHistory({ base, type, visitId }: { base: string; type: 'consultant' | 'site'; visitId: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900" onClick={() => setShow(!show)} aria-expanded={show}>
        <History className="w-3.5 h-3.5" />{show ? 'Hide activity history' : 'Show activity history'}
      </button>
      {show && <HistoryList url={`${base}/${type}/${visitId}/history`} />}
    </div>
  );
}
function HistoryList({ url }: { url: string }) {
  const { data } = useApi<Array<{ id: string; summary: string; created_at: string; who: string | null }>>(url);
  if (!data) return <p className="text-xs text-slate-400 mt-2">Loading…</p>;
  return (
    <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3">
      {data.map((h) => <li key={h.id} className="text-xs text-slate-600"><span className="text-slate-400">{formatDateTime(h.created_at)}</span> · {h.who ?? 'System'} — {h.summary}</li>)}
      {data.length === 0 && <li className="text-xs text-slate-500">No history.</li>}
    </ul>
  );
}

/** Segmented button group used for filters and List / Calendar. */
export function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: Array<{ id: T; label: React.ReactNode }> }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-slate-200 overflow-hidden bg-white">
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}
          className={`px-3 py-1.5 text-sm min-h-9 inline-flex items-center gap-1 border-l first:border-l-0 border-slate-200 ${value === o.id ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>{o.label}</button>
      ))}
    </div>
  );
}
