import React, { useState } from 'react';
import { CheckCircle2, Circle, Plus } from 'lucide-react';
import { patch, post } from '../lib/api';
import type { VisitAction } from '../lib/types';
import { formatDate } from '../lib/format';
import { Button, inputCls, useUi } from './ui';

/** Follow-up actions (description, responsible, due date, open/closed) for a visit. */
export function VisitActions({ base, type, visitId, actions, canEdit, onChange, members }: {
  base: string; type: 'consultant' | 'site'; visitId: string; actions: VisitAction[]; canEdit: boolean; onChange: () => void;
  /** project members offered as the responsible person (optional; a free-text name is always possible) */
  members?: Array<{ id: string; name: string }>;
}) {
  const [respUser, setRespUser] = useState('');
  const [desc, setDesc] = useState('');
  const [resp, setResp] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const add = async () => {
    if (!desc.trim()) return;
    setBusy(true);
    try {
      const who = members?.find((m) => m.id === respUser);
      await post(`${base}/${type}/${visitId}/actions`, { description: desc, responsible: resp || who?.name || '', responsible_user_id: respUser || null, due_date: due || null });
      setDesc(''); setResp(''); setDue(''); setRespUser('');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const toggle = async (a: VisitAction) => {
    try { await patch(`${base}/actions/${a.id}`, { status: a.status === 'Open' ? 'Closed' : 'Open' }); onChange(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <p className="text-xs font-bold text-slate-700 mb-2">Follow-up actions</p>
      {actions.length === 0 ? <p className="text-xs text-slate-500 mb-2">No follow-up actions.</p> : (
        <ul className="space-y-1.5 mb-3">
          {actions.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-xs">
              <button disabled={!canEdit} onClick={() => toggle(a)} className="mt-0.5" title={a.status === 'Open' ? 'Mark closed' : 'Reopen'}>
                {a.status === 'Closed' ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-amber-500" />}
              </button>
              <div className={a.status === 'Closed' ? 'line-through text-slate-400' : 'text-slate-700'}>
                {a.description}
                <span className="text-slate-400 no-underline"> {a.responsible && `· ${a.responsible}`} {a.due_date && `· due ${formatDate(a.due_date)}`}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className={`grid grid-cols-1 gap-2 ${members ? 'sm:grid-cols-[1fr_150px_130px_130px_auto]' : 'sm:grid-cols-[1fr_140px_140px_auto]'}`}>
          <input className={inputCls} placeholder="Action required" aria-label="Action required" value={desc} onChange={(e) => setDesc(e.target.value)} />
          {members && (
            <select className={inputCls} value={respUser} onChange={(e) => setRespUser(e.target.value)} aria-label="Responsible user">
              <option value="">Responsible user…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <input className={inputCls} placeholder={members ? 'Or name' : 'Responsible'} aria-label="Responsible name" value={resp} onChange={(e) => setResp(e.target.value)} />
          <input className={inputCls} type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <Button onClick={add} busy={busy}><Plus className="w-3.5 h-3.5" />Add</Button>
        </div>
      )}
    </div>
  );
}
