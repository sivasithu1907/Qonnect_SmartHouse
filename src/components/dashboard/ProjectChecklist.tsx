import React, { useState } from 'react';
import { Archive, ArrowDown, ArrowUp, Ban, CheckCircle2, ChevronDown, Circle, CircleDot, ExternalLink, FileSignature, FileText, Hourglass, Pencil, Plus, RotateCcw, Search } from 'lucide-react';
import { patch, post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import type { ContractsResponse, Member, Project, Section } from '../../lib/types';
import type { SetupItem } from '../../lib/projectHealth';
import { checklistCounts, type Prerequisite } from '../../lib/dashboard';
import { formatDate, formatDateTime } from '../../lib/format';
import { PREREQUISITE_STATUSES } from '../../../shared/constants';
import { Attachments } from '../Attachments';
import { SetupRow } from '../ProjectHealth';
import { Badge, Button, inputCls, Modal, Notice, RecordForm, useUi, type FieldSpec } from '../ui';

type Filter = 'all' | 'outstanding' | 'completed';
type Tone = 'emerald' | 'sky' | 'amber' | 'slate';
const STATUS_TONE: Record<string, Tone> = { Completed: 'emerald', 'In progress': 'sky', 'Awaiting review': 'amber', 'Not applicable': 'slate', 'Not started': 'slate' };
const STATUS_ICON: Record<string, React.FC<{ className?: string }>> = { Completed: CheckCircle2, 'In progress': CircleDot, 'Awaiting review': Hourglass, 'Not applicable': Ban, 'Not started': Circle };
const ICON_COLOR: Record<Tone, string> = { emerald: 'text-emerald-600', sky: 'text-sky-600', amber: 'text-amber-600', slate: 'text-slate-300' };

interface PhaseOption { id: string; seq: number; name: string }

/** Full-width, collapsible checklist: project setup (from saved data) and project prerequisites & documents. */
export function ProjectChecklist({ project, setup, phases, today, onSettings, onNavigate }: {
  project: Project; setup: SetupItem[]; phases: PhaseOption[]; today: string; onSettings: () => void; onNavigate: (s: Section) => void;
}) {
  const { can } = useSession();
  const canRead = can('prerequisites.read');
  const writable = can('prerequisites.write') && !project.archived_at;
  const base = `/api/projects/${project.id}/prerequisites`;
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<Prerequisite[]>(canRead ? `${base}${showArchived ? '?includeArchived=1' : ''}` : null);
  const { data: members } = useApi<Member[]>(writable ? `/api/projects/${project.id}/members` : null);
  const { data: contracts } = useApi<ContractsResponse>(writable && can('contracts.read') ? `/api/projects/${project.id}/contracts` : null);
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: Prerequisite | null } | null>(null);
  const { toast, confirm } = useUi();

  const all = data ?? [];
  const active = all.filter((p) => !p.archived_at);
  const archived = all.filter((p) => p.archived_at);
  const counts = checklistCounts(setup, canRead ? active : []);
  const matchesFilter = (done: boolean, na: boolean) => filter === 'all' || (filter === 'completed' ? done : !done && !na);
  const s = q.trim().toLowerCase();
  const setupShown = setup.filter((i) => matchesFilter(i.done, false) && (!s || `${i.label} ${i.detail}`.toLowerCase().includes(s)));
  const preShown = active.filter((p) => matchesFilter(p.status === 'Completed', p.status === 'Not applicable')
    && (!s || `${p.title} ${p.phase_name ?? ''} ${p.responsible_display ?? ''} ${p.status} ${p.contract_title ?? ''}`.toLowerCase().includes(s)));
  const detail = all.find((p) => p.id === detailId) ?? null;

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const move = (id: string, dir: -1 | 1) => {
    const ids = active.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => post(`${base}/reorder`, { ids }), 'Order saved');
  };
  const archive = async (p: Prerequisite) => {
    if (await confirm(<>Archive <b>{p.title}</b>? It leaves the checklist but is kept with its files and history. You can restore it.</>, { title: 'Archive prerequisite', confirmLabel: 'Archive', danger: true })) {
      await run(() => post(`${base}/${p.id}/archive`), 'Prerequisite archived');
      setDetailId(null);
    }
  };

  const phaseOptions = phases.map((p) => ({ value: p.id, label: `${p.seq}. ${p.name}` }));
  const memberOptions = (members ?? []).map((m) => ({ value: m.id, label: m.name }));
  const contractOptions = (contracts?.contracts ?? []).map((k) => ({ value: k.id, label: `${k.title} — ${k.company_name}`, group: k.category_name }));
  const formFields: FieldSpec[] = [
    { name: 'title', label: 'Title', required: true, wide: true, placeholder: 'e.g. Building permit' },
    { name: 'phase_id', label: 'Related phase', type: 'searchselect', nullable: true, options: phaseOptions },
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'responsible_user_id', label: 'Responsible person (project member)', type: 'select', nullable: true, options: memberOptions },
    { name: 'responsible_name', label: 'Or responsible party (name)', help: 'Use when the responsible party has no account, e.g. the consultant firm.' },
    { name: 'contract_id', label: 'Linked contract', type: 'searchselect', nullable: true, options: contractOptions, hidden: !contracts, help: 'Link an existing contract instead of uploading its files again.' },
    { name: 'document_url', label: 'Document link (e.g. Google Drive file)', type: 'url', wide: true },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  const save = async (row: Prerequisite | null, v: Record<string, unknown>) => {
    if (row) await patch(`${base}/${row.id}`, v);
    else await post(base, v);
    toast(row ? 'Prerequisite updated' : 'Prerequisite added');
    setEdit(null);
    await reload();
  };

  return (
    <section aria-labelledby="ck-title" className="bg-white rounded-xl border border-slate-200 shadow-2xs">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_minmax(10rem,16rem)] items-center gap-x-4 gap-y-2 px-4 py-4">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="ck-body" aria-label={open ? 'Collapse checklist' : 'Expand checklist'}
          className="w-9 h-9 grid place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100">
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        <div className="min-w-0">
          <h2 id="ck-title" className="text-sm font-bold text-slate-900">Project setup & prerequisites</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {counts.total ? <><b className="text-slate-800">{counts.done} of {counts.total}</b> completed · <b className="text-slate-800">{counts.remaining}</b> remaining{counts.notApplicable ? ` · ${counts.notApplicable} not applicable` : ''}</> : 'No checklist items yet'}
          </p>
        </div>
        {counts.total > 0 && (
          <div className="col-span-2 sm:col-span-1 space-y-1">
            <div className="flex justify-between text-xs text-slate-500"><span>Checklist progress</span><b className="font-mono text-slate-800">{counts.pct}</b></div>
            <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden" role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={counts.total} aria-valuenow={counts.done}>
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(counts.done / counts.total) * 100}%` }} />
            </div>
          </div>
        )}
      </div>

      {open && (
        <div id="ck-body" className="border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
            <div role="group" aria-label="Filter checklist" className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
              {(['all', 'outstanding', 'completed'] as const).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 text-xs font-semibold min-h-9 border-l first:border-l-0 border-slate-200 ${filter === f ? 'bg-sky-50 text-sky-800' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                  {f === 'all' ? 'All' : f === 'outstanding' ? 'Outstanding' : 'Completed'}
                </button>
              ))}
            </div>
            {setup.length + active.length > 8 && (
              <label className="relative flex-1 min-w-[180px] max-w-xs">
                <span className="sr-only">Search checklist</span>
                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search checklist" className={`${inputCls} pl-8`} />
              </label>
            )}
          </div>

          <div className="px-4 pt-3">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">Project setup <span className="font-mono text-xs font-semibold text-slate-500">{counts.setupDone} of {counts.setupTotal}</span></h3>
            <p className="text-xs text-slate-500 mt-0.5">Completes automatically from saved project data. You see the steps your role can complete.</p>
            {setup.length === 0 ? <p className="text-xs text-slate-500 py-3">No setup steps for your role.</p>
              : setupShown.length === 0 ? <p className="text-xs text-slate-500 py-3">No setup steps match this filter.</p>
              : <ul className="divide-y divide-slate-100">{setupShown.map((i) => <SetupRow key={i.key} i={i} onSettings={onSettings} onNavigate={onNavigate} />)}</ul>}
          </div>

          <div className="px-4 pt-4 pb-4 border-t border-slate-100 mt-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">Prerequisites & documents
                {canRead && <span className="font-mono text-xs font-semibold text-slate-500">{counts.preDone} of {counts.preApplicable}{counts.notApplicable ? ` · ${counts.notApplicable} N/A` : ''}</span>}</h3>
              <span className="flex-1" />
              {canRead && (
                <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
              )}
              {writable && <Button size="sm" variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-3.5 h-3.5" />Add item</Button>}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">Project-specific items such as permits, surveys, reports and agreements. Uploading or opening a document never changes an item’s status — an authorised user records each decision.</p>
            {!canRead ? <p className="text-xs text-slate-500 py-3">Prerequisites are visible to admins, project managers and viewers.</p>
              : error ? <div className="pt-3"><Notice tone="rose">{error}</Notice></div>
              : !data ? <p className="text-xs text-slate-400 py-3">Loading…</p>
              : active.length === 0 ? (
                <div className="mt-3 text-center py-8 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/60">
                  <p className="text-sm font-semibold text-slate-700">No prerequisites added yet</p>
                  <p className="text-xs text-slate-500 mt-1">{writable ? 'Add the permits, agreements and reports this project needs. Nothing is added automatically.' : 'An admin or project manager can add them.'}</p>
                  {writable && <div className="mt-3"><Button variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-4 h-4" />Add the first item</Button></div>}
                </div>
              ) : preShown.length === 0 ? <p className="text-xs text-slate-500 py-3">No prerequisites match this filter.</p>
              : (
                <ul className="divide-y divide-slate-100" data-testid="prereq-list">
                  {preShown.map((p) => {
                    const tone = STATUS_TONE[p.status] ?? 'slate';
                    const StatusIcon = STATUS_ICON[p.status] ?? Circle;
                    const idx = active.findIndex((x) => x.id === p.id);
                    const muted = p.status === 'Completed' || p.status === 'Not applicable';
                    return (
                      <li key={p.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] md:grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 py-3 items-start">
                        <StatusIcon className={`w-5 h-5 ${ICON_COLOR[tone]}`} aria-hidden="true" />
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold break-words ${muted ? 'text-slate-500' : 'text-slate-900'}`}>{p.title}</p>
                          <p className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                            <span>{p.phase_seq ? `Phase ${p.phase_seq} · ${p.phase_name}` : 'No phase linked'}</span>
                            {p.responsible_display && <span>Responsible: {p.responsible_display}</span>}
                            {p.due_date && !muted && <span className={p.due_date < today ? 'text-rose-700 font-semibold' : ''}>Due {formatDate(p.due_date)}{p.due_date < today ? ' · past due' : ''}</span>}
                            {p.status === 'Completed' && p.completed_on && <span>Completed {formatDate(p.completed_on)}{p.decided_by_name ? ` · recorded by ${p.decided_by_name}` : ''}</span>}
                            {p.status === 'Not applicable' && p.decided_by_name && <span>Marked not applicable by {p.decided_by_name}</span>}
                          </p>
                        </div>
                        <div className="col-start-2 md:col-start-3 flex flex-wrap items-center gap-2 md:justify-end">
                          <Badge tone={tone}>{p.status}</Badge>
                          <DocumentChip p={p} onOpen={() => setDetailId(p.id)} />
                          <Button size="sm" onClick={() => setDetailId(p.id)} aria-label={`Details: ${p.title}`}>Details</Button>
                          {writable && (
                            <span className="inline-flex">
                              <Button size="sm" variant="ghost" title="Move up" aria-label={`Move ${p.title} up`} disabled={idx <= 0} onClick={() => move(p.id, -1)}><ArrowUp className="w-3.5 h-3.5" /></Button>
                              <Button size="sm" variant="ghost" title="Move down" aria-label={`Move ${p.title} down`} disabled={idx === active.length - 1} onClick={() => move(p.id, 1)}><ArrowDown className="w-3.5 h-3.5" /></Button>
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            {showArchived && archived.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-bold text-slate-600 mb-1">Archived ({archived.length})</p>
                <ul className="divide-y divide-slate-200">
                  {archived.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-sm text-slate-500 break-words">{p.title}</span>
                      {writable && <Button size="sm" onClick={() => run(() => post(`${base}/${p.id}/restore`), 'Prerequisite restored')}><RotateCcw className="w-3.5 h-3.5" />Restore</Button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="px-4 pb-4 text-xs text-slate-500">Checklist progress is separate from task completion. Completing every row does not mean the project is ready for construction.</p>
        </div>
      )}

      <Modal open={!!edit} title={edit?.row ? 'Edit prerequisite' : 'Add prerequisite'} onClose={() => setEdit(null)} wide>
        {edit && <RecordForm fields={formFields} initial={edit.row} mode={edit.row ? 'edit' : 'create'} onCancel={() => setEdit(null)} onSubmit={(v) => save(edit.row, v)} />}
      </Modal>
      {detail && (
        <PrerequisiteDetails key={`${detail.id}-${detail.status}`} project={project} p={detail} today={today} writable={writable}
          onClose={() => setDetailId(null)} onEdit={() => { setEdit({ row: detail }); setDetailId(null); }} onArchive={() => archive(detail)}
          onChanged={reload} />
      )}
    </section>
  );
}

function DocumentChip({ p, onOpen }: { p: Prerequisite; onOpen: () => void }) {
  const cls = 'inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:text-sky-700 min-h-8';
  const n = p.attachment_count + (p.document_url ? 1 : 0);
  if (p.contract_id && p.contract_title) {
    return <button type="button" onClick={onOpen} className={cls} title={`Linked contract: ${p.contract_title}`}><FileSignature className="w-3.5 h-3.5 shrink-0" /><span className="truncate">Contract: {p.contract_title}</span>{n > 0 && <span className="text-slate-500">+{n}</span>}</button>;
  }
  if (p.contract_linked) return <button type="button" onClick={onOpen} className={cls}><FileSignature className="w-3.5 h-3.5 shrink-0" /><span className="truncate">Linked contract</span></button>;
  if (n > 0) return <button type="button" onClick={onOpen} className={cls}><FileText className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{n} document{n === 1 ? '' : 's'}</span></button>;
  if (p.status === 'Not applicable') return null;
  return <span className="inline-flex items-center rounded-lg border border-dashed border-slate-200 px-2.5 py-1 text-xs text-slate-400 min-h-8">No document attached</span>;
}

function PrerequisiteDetails({ project, p, today, writable, onClose, onEdit, onArchive, onChanged }: {
  project: Project; p: Prerequisite; today: string; writable: boolean; onClose: () => void; onEdit: () => void; onArchive: () => void; onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [completedOn, setCompletedOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const editable = writable && !p.archived_at;
  const record = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await patch(`/api/projects/${project.id}/prerequisites/${p.id}`, pending === 'Completed' ? { status: pending, completed_on: completedOn } : { status: pending });
      toast(pending === 'Completed' ? 'Completion recorded' : `Status set to ${pending}`);
      setPending(null);
      await onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={p.title} subtitle={p.phase_seq ? `Phase ${p.phase_seq} · ${p.phase_name}` : 'Prerequisite'} onClose={onClose} wide>
      <div className="space-y-5">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Status</dt><dd className="mt-1"><Badge tone={STATUS_TONE[p.status] ?? 'slate'}>{p.status}</Badge></dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Responsible</dt><dd className="mt-1 font-semibold text-slate-800">{p.responsible_display || 'Not assigned'}</dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Due date</dt><dd className="mt-1 font-semibold text-slate-800">{p.due_date ? formatDate(p.due_date) : 'Not set'}</dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Decision record</dt><dd className="mt-1 font-semibold text-slate-800">
            {p.status === 'Completed' && p.completed_on ? `Completed ${formatDate(p.completed_on)}` : p.status === 'Not applicable' ? 'Marked not applicable' : 'No decision recorded'}
            {p.decided_at && <span className="block text-xs font-normal text-slate-500">Recorded {formatDateTime(p.decided_at)}{p.decided_by_name ? ` by ${p.decided_by_name}` : ''}</span>}
          </dd></div>
          {p.notes && <div className="sm:col-span-2"><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes</dt><dd className="mt-1 text-slate-800 whitespace-pre-wrap break-words">{p.notes}</dd></div>}
        </dl>

        {editable && (
          <div className="space-y-2">
            <label htmlFor="pq-status" className="block text-xs font-semibold text-slate-600">Change status</label>
            <select id="pq-status" className={`${inputCls} sm:max-w-xs`} value={pending ?? p.status} onChange={(e) => setPending(e.target.value === p.status ? null : e.target.value)}>
              {PREREQUISITE_STATUSES.map((st) => <option key={st}>{st}</option>)}
            </select>
            {pending && (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 space-y-2 text-xs text-amber-900">
                <p>{pending === 'Completed' ? 'Record this item as completed? Your name and the time are saved as the decision. Attached files are not checked automatically.'
                  : pending === 'Not applicable' ? 'Mark this item as not applicable? It leaves the completion count, and your name is recorded.'
                  : `Change the status to “${pending}”?${p.status === 'Completed' || p.status === 'Not applicable' ? ' The recorded decision is cleared.' : ''}`}</p>
                {pending === 'Completed' && (
                  <label className="flex flex-wrap items-center gap-2 font-semibold text-slate-700">Completion date
                    <input type="date" className={`${inputCls} !w-auto`} value={completedOn} max={today} onChange={(e) => setCompletedOn(e.target.value)} />
                  </label>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" busy={busy} disabled={pending === 'Completed' && !completedOn} onClick={record}>{pending === 'Completed' ? 'Record completion' : 'Save status'}</Button>
                  <Button size="sm" onClick={() => setPending(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {(p.contract_id || p.document_url) && (
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Linked documents</p>
            {p.contract_id && (p.contract_title ? (
              <a href={`#/contracts/${project.id}/${p.contract_id}`} onClick={onClose} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 no-underline hover:bg-slate-50">
                <FileSignature className="w-5 h-5 text-sky-600 shrink-0" />
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-900 break-words">{p.contract_title}</span>
                  <span className="block text-xs text-slate-500">{p.contract_company} · {p.contract_status}{p.contract_archived_at ? ' · archived' : ''} · {p.contract_file_count ?? 0} file{p.contract_file_count === 1 ? '' : 's'} in Contracts & Documents</span></span>
                <span className="text-xs font-semibold text-sky-700">Open</span>
              </a>
            ) : <p className="text-xs text-slate-500">A contract is linked. Contract details are not available for your role.</p>)}
            {p.document_url && (
              <a href={p.document_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 no-underline hover:bg-slate-50">
                <ExternalLink className="w-5 h-5 text-sky-600 shrink-0" />
                <span className="min-w-0 flex-1 text-sm font-semibold text-slate-900 break-all">{p.document_url}</span>
              </a>
            )}
          </div>
        )}

        <div>
          <Attachments projectId={project.id} entityType="prerequisite" entityId={p.id} defaultKind="supporting_document" title="Uploaded documents"
            canUpload={editable} onChange={() => void onChanged()} />
          <p className="text-[11px] text-slate-500 mt-1">Uploading or opening a document doesn’t mark this item completed or approved.</p>
        </div>

        {editable && (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            <Button onClick={onEdit}><Pencil className="w-4 h-4" />Edit details</Button>
            <Button variant="ghost" onClick={onArchive}><Archive className="w-4 h-4" />Archive</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
