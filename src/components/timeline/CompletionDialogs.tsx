import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Paperclip, ShieldCheck } from 'lucide-react';
import { ApiError, post } from '../../lib/api';
import { formatDate, todayLocalISO } from '../../lib/format';
import type { Phase, Project, Task } from '../../lib/types';
import { Attachments } from '../Attachments';
import { Badge, Button, inputCls, Modal, Notice, StatusBadge, useUi } from '../ui';

export const HISTORICAL_NOTE = 'Completed before the project was entered into the application.';

interface Issue { code: string; message: string }
/** Same checks as the server: open predecessors (other than tasks completed together), hold point, blocked / on hold. */
export function taskIssues(t: Task, byId: Map<string, Task>, together: Set<string>): Issue[] {
  const out: Issue[] = [];
  const open = t.depends_on.map((id) => byId.get(id)).filter((d): d is Task => !!d && d.status !== 'Completed' && !d.archived_at && !together.has(d.id));
  if (open.length) out.push({ code: 'dependencies', message: `Predecessors not completed: ${open.map((d) => d.name).join('; ')}` });
  if (t.is_hold_point) out.push({ code: 'hold_point', message: 'Inspection / hold point — completing it does not record an inspection approval' });
  if (t.status === 'Blocked' || t.status === 'On Hold') out.push({ code: 'blocked', message: `Currently ${t.status.toLowerCase()}` });
  return out;
}

function DateChoice({ historical, date, setDate, unknown, setUnknown, label = 'Actual completion date' }: {
  historical: boolean; date: string; setDate: (v: string) => void; unknown: boolean; setUnknown: (v: boolean) => void; label?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-slate-600">{label}{!unknown && <span className="text-rose-500"> *</span>}
        <input type="date" className={`${inputCls} mt-1`} value={date} max={todayLocalISO()} disabled={unknown} onChange={(e) => setDate(e.target.value)} aria-describedby="date-help" />
      </label>
      {historical && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="rounded border-slate-300" checked={unknown} onChange={(e) => { setUnknown(e.target.checked); if (e.target.checked) setDate(''); }} />
          Exact completion date unknown
        </label>
      )}
      <p id="date-help" className="text-[11px] text-slate-500">
        When the work actually finished — earlier dates are fine; future dates are not accepted. {unknown ? 'The date stays empty and is recorded as unknown.' : 'Today is not filled in automatically.'} The time you record this is kept separately.
      </p>
    </div>
  );
}

function IssueList({ issues, reason, setReason }: { issues: Array<Issue & { task_name?: string }>; reason: string; setReason: (v: string) => void }) {
  if (!issues.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 space-y-2" role="alert">
      <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />Check before recording completion</p>
      <ul className="text-xs text-amber-900 list-disc ml-5 space-y-0.5">
        {issues.map((x, i) => <li key={i}>{x.task_name ? <b>{x.task_name}: </b> : null}{x.message}</li>)}
      </ul>
      <p className="text-[11px] text-amber-800">Nothing is approved automatically: inspections, permits, prerequisites and predecessor tasks keep their own records. If the work was in fact completed, explain why — the reason is kept in the audit history.</p>
      <label className="block text-xs font-semibold text-amber-900">Reason for recording completion anyway *
        <textarea rows={2} className={`${inputCls} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Inspection passed on site before the app was used; certificate in the project file" />
      </label>
    </div>
  );
}

/** Mark one task completed (normal workflow; unknown date only with historical progress entry). Optional supporting file afterwards. */
export function TaskCompleteDialog({ project, task, byId, onClose, onDone }: { project: Project; task: Task; byId: Map<string, Task>; onClose: () => void; onDone: () => Promise<void> }) {
  const historical = !!project.allow_historical_progress;
  const [date, setDate] = useState(task.actual_end ?? '');
  const [unknown, setUnknown] = useState(false);
  const [start, setStart] = useState(task.actual_start ?? '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { toast } = useUi();
  const issues = taskIssues(task, byId, new Set([task.id]));
  const submit = async () => {
    setErr(null);
    if (!unknown && !date) { setErr('Enter the actual completion date' + (historical ? ', or choose “Exact completion date unknown”.' : '.')); return; }
    if (issues.length && !reason.trim()) { setErr('Give a reason for recording completion despite the points above.'); return; }
    setBusy(true);
    try {
      await post(`/api/projects/${project.id}/timeline/tasks/${task.id}/complete`, {
        actual_end: unknown ? null : date, date_unknown: unknown, actual_start: start || null, note, historical: historical && (unknown || note.trim() === HISTORICAL_NOTE), override_reason: reason,
      });
      toast(`${task.name} recorded as completed`);
      setDone(true);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.details?.code === 'COMPLETION_ISSUES' ? 'Some points need a reason (see above).' : (e as Error).message);
    } finally { setBusy(false); }
  };
  const addEvidence = async () => {
    try {
      const w = await post<{ id: string }>(`/api/projects/${project.id}/work-updates`, {
        update_date: date || todayLocalISO(), title: `Completion record — ${task.name}`, description: note || (unknown ? 'Completion date not recorded.' : ''), related_task_id: task.id,
      });
      setEvidence(w.id);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open title={done ? 'Task completed' : 'Mark task completed'} subtitle={task.name} onClose={onClose}>
      {!done ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="text-slate-500">Current status:</span><StatusBadge status={task.status} />{task.is_hold_point && <Badge tone="violet"><ShieldCheck className="w-3 h-3" />Hold point</Badge>}</div>
          <DateChoice historical={historical} date={date} setDate={setDate} unknown={unknown} setUnknown={setUnknown} />
          {!unknown && (
            <label className="block text-xs font-semibold text-slate-600">Actual start date (optional)
              <input type="date" className={`${inputCls} mt-1`} value={start} max={date || todayLocalISO()} onChange={(e) => setStart(e.target.value)} />
            </label>
          )}
          <label className="block text-xs font-semibold text-slate-600">Completion note {historical && <span className="font-normal text-slate-400">(e.g. how the completion is known)</span>}
            <textarea rows={2} dir="auto" className={`${inputCls} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} />
            {historical && note !== HISTORICAL_NOTE && <button type="button" className="mt-1 text-[11px] font-semibold text-sky-700" onClick={() => setNote(HISTORICAL_NOTE)}>Use: “{HISTORICAL_NOTE}”</button>}
          </label>
          <IssueList issues={issues} reason={reason} setReason={setReason} />
          {err && <Notice tone="rose">{err}</Notice>}
          <p className="text-[11px] text-slate-500">Task completion is recorded progress, not consultant-certified physical construction progress.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={busy} onClick={submit}><CheckCircle2 className="w-4 h-4" />Record completion</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Notice tone="emerald">{task.name} is recorded as {unknown ? 'completed (exact date unknown)' : `completed on ${formatDate(date)}`}.</Notice>
          {!evidence ? (
            <p className="text-sm text-slate-600">Optional: add a supporting photo or document. It is kept as a work update linked to this task.
              <Button size="sm" className="ml-2" onClick={addEvidence}><Paperclip className="w-3.5 h-3.5" />Add supporting file</Button></p>
          ) : <Attachments projectId={project.id} entityType="work_update" entityId={evidence} defaultKind="supporting_document" canUpload title="Supporting files" />}
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}

/** Review and complete several tasks of one phase (historical progress entry only). Already completed tasks are never changed. */
export function PhaseCompleteDialog({ project, phase, tasks, byId, onClose, onDone }: { project: Project; phase: Phase; tasks: Task[]; byId: Map<string, Task>; onClose: () => void; onDone: () => Promise<void> }) {
  const open = tasks.filter((t) => t.status !== 'Completed');
  const [pick, setPick] = useState<Set<string>>(() => new Set(open.map((t) => t.id)));
  const [date, setDate] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [note, setNote] = useState(HISTORICAL_NOTE);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useUi();
  const issues = useMemo(() => open.filter((t) => pick.has(t.id)).flatMap((t) => taskIssues(t, byId, pick).map((x) => ({ ...x, task_name: t.name }))), [open, pick, byId]);
  const all = open.length > 0 && open.every((t) => pick.has(t.id));
  const submit = async () => {
    setErr(null);
    if (!pick.size) { setErr('Select at least one task.'); return; }
    if (!unknown && !date) { setErr('Enter the actual completion date, or choose “Exact completion date unknown”.'); return; }
    if (issues.length && !reason.trim()) { setErr('Give a reason for recording completion despite the points above.'); return; }
    setBusy(true);
    try {
      const r = await post<{ completed: string[]; skipped: string[] }>(`/api/projects/${project.id}/timeline/phases/${phase.id}/complete-tasks`, {
        task_ids: [...pick], actual_end: unknown ? null : date, date_unknown: unknown, note, override_reason: reason,
      });
      toast(`${r.completed.length} task${r.completed.length === 1 ? '' : 's'} recorded as completed`);
      await onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError && e.details?.code === 'COMPLETION_ISSUES' ? 'Some points need a reason (see above).' : (e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="Complete remaining tasks" subtitle={`Phase ${phase.seq}. ${phase.name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-slate-600">Record work that was already finished. Only the selected tasks change to Completed; completed tasks keep their dates and notes. The phase status follows its tasks.</p>
        <div className="border border-slate-200 rounded-lg">
          <label className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 text-xs font-semibold text-slate-700 bg-slate-50">
            <input type="checkbox" className="rounded border-slate-300" checked={all} disabled={!open.length} onChange={(e) => setPick(new Set(e.target.checked ? open.map((t) => t.id) : []))} />
            Select all incomplete tasks ({open.length})
          </label>
          <ul className="divide-y divide-slate-100 max-h-[40vh] overflow-y-auto overscroll-contain" data-testid="phase-complete-list">
            {tasks.map((t) => {
              const doneAlready = t.status === 'Completed';
              const mine = !doneAlready && pick.has(t.id) ? taskIssues(t, byId, pick) : [];
              return (
                <li key={t.id} className={`px-3 py-2 flex items-start gap-2 ${doneAlready ? 'bg-slate-50/60' : ''}`}>
                  <input type="checkbox" className="mt-0.5 rounded border-slate-300" disabled={doneAlready} checked={doneAlready || pick.has(t.id)} aria-label={`Complete ${t.name}`}
                    onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />
                  <div className="min-w-0 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="font-semibold text-slate-800">{t.name}</span><StatusBadge status={t.status} />{t.is_hold_point && <Badge tone="violet"><ShieldCheck className="w-3 h-3" />Hold point</Badge>}</div>
                    {doneAlready
                      ? <p className="text-slate-500">Already {t.actual_end ? `completed ${formatDate(t.actual_end)}` : 'completed (date not recorded)'} — unchanged</p>
                      : pick.has(t.id) ? <p className="text-emerald-700">Will be recorded as completed</p> : <p className="text-slate-400">Not selected — unchanged</p>}
                    {mine.map((x) => <p key={x.code} className="text-amber-800">{x.message}</p>)}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <DateChoice historical date={date} setDate={setDate} unknown={unknown} setUnknown={setUnknown} label="Actual completion date (applies to every selected task)" />
        <label className="block text-xs font-semibold text-slate-600">Historical completion note
          <textarea rows={2} dir="auto" className={`${inputCls} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <IssueList issues={issues} reason={reason} setReason={setReason} />
        {err && <Notice tone="rose">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={busy || !pick.size} onClick={submit}><CheckCircle2 className="w-4 h-4" />Record {pick.size} task{pick.size === 1 ? '' : 's'} as completed</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Correct an accidental completion; the reason and the previous values are kept in the audit history. */
export function ReopenDialog({ project, task, onClose, onDone }: { project: Project; task: Task; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('In Progress');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useUi();
  return (
    <Modal open title="Reopen task" subtitle={task.name} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-600">Use this when the task was marked completed by mistake. Its completion date and note are cleared; the previous values stay in the audit history.</p>
        <label className="block text-xs font-semibold text-slate-600">New status
          <select className={`${inputCls} mt-1`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {['In Progress', 'Scheduled', 'Not Scheduled', 'On Hold', 'Blocked'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold text-slate-600">Reason *
          <textarea rows={2} className={`${inputCls} mt-1`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {err && <Notice tone="rose">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={busy} onClick={async () => {
            if (reason.trim().length < 3) { setErr('Give a reason for reopening.'); return; }
            setBusy(true);
            try { await post(`/api/projects/${project.id}/timeline/tasks/${task.id}/reopen`, { reason, status }); toast('Task reopened'); await onDone(); onClose(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>Reopen task</Button>
        </div>
      </div>
    </Modal>
  );
}
