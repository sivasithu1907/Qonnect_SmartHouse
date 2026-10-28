import React, { useMemo, useState } from 'react';
import {
  Archive, CalendarDays, CalendarX2, CheckCircle2, Clock, FolderOpen, List, MessageSquare, Pencil, Plus, RotateCcw, Search, UserCheck,
} from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, ConsultantVisit, MaterialItem, Member, Phase, Project, Task } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { AvatarName } from '../components/Avatar';
import { visitState } from '../../shared/constants';
import { formatPhone } from '../../shared/directory';
import { Attachments } from '../components/Attachments';
import { VisitActions } from '../components/VisitActions';
import { Badge, Button, Card, EmptyState, inputCls, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, useUi, type FieldSpec, type Option } from '../components/ui';
import { DirectoryLinkBadge, useDirectoryLink } from '../components/directory/DirectoryLink';
import { ContactActions } from '../components/directory/ContactActions';
import { Comments, DateTile, Item, VisitCalendar, VisitHistory } from '../components/visits/shared';
import { labelOf, materialOptions as materialOpts, timelineTaskOptions } from '../lib/options';

export function useLinkOptions(projectId: string) {
  const { data: tl } = useApi<{ phases: Phase[]; tasks: Task[] }>(`/api/projects/${projectId}/timeline`);
  const { data: mats } = useApi<{ items: MaterialItem[] }>(`/api/projects/${projectId}/materials`);
  const taskOptions = timelineTaskOptions(tl?.phases ?? [], tl?.tasks ?? []);
  const materialOptions = materialOpts(mats?.items ?? []);
  const label = (opts: Option[], id: string | null) => {
    const o = opts.find((x) => x.value === id);
    return o ? (o.group && opts === materialOptions ? `${o.group} · ${o.label}` : labelOf(opts, id)) : '';
  };
  return { taskOptions, materialOptions, label };
}

type Filter = 'upcoming' | 'reports' | 'completed' | 'cancelled' | 'all';
type Workflow = { kind: 'reschedule' | 'complete' | 'cancel'; v: ConsultantVisit };
const STATE_TONE = { Scheduled: 'sky', Completed: 'emerald', Cancelled: 'slate' } as const;
const stateOf = (v: ConsultantVisit) => v.visit_state ?? visitState(v.status);
const reportOf = (v: ConsultantVisit) => v.report_status ?? ((v.report_count ?? 0) > 0 ? 'Report uploaded' : 'Report pending');
const whoOf = (v: ConsultantVisit) => v.directory_entry_name || v.consultant_name || v.consultant_user_name || 'Consultant not set';

export function StateBadges({ v }: { v: ConsultantVisit }) {
  const st = stateOf(v);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={STATE_TONE[st]}>{st}{v.status === 'Rescheduled' ? ' (rescheduled)' : v.status === 'In Progress' ? ' (in progress)' : ''}</Badge>
      {st !== 'Cancelled' && <Badge tone={reportOf(v) === 'Report uploaded' ? 'emerald' : st === 'Completed' ? 'amber' : 'slate'}>{reportOf(v)}</Badge>}
    </span>
  );
}

/**
 * Consultant visits: schedule → visit panel (reschedule / mark completed / cancel) → reports, follow-up actions and comments.
 * Visit status and report status are separate: a completed visit can still await its report, and uploading a report
 * never completes the visit. Payments stay in the central Payments register.
 */
export function ConsultantVisits({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/visits`;
  const { data, error, reload } = useApi<ConsultantVisit[]>(`${base}/consultant`);
  const { user, can } = useSession();
  const manager = can('consultant.write') && !project.archived_at;
  const own = can('consultant.own') && !project.archived_at;
  const { data: members } = useApi<Member[]>(manager ? `/api/projects/${project.id}/members` : null);
  const { data: payments } = useApi<{ milestones: Array<{ id: string; payee_name: string; description: string; payee_type: string; archived_at: string | null }> }>(manager && can('payments.read') ? `/api/projects/${project.id}/payments` : null);
  const { taskOptions } = useLinkOptions(project.id);
  const dir = useDirectoryLink(project);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ row: ConsultantVisit | null } | null>(null);
  const [flow, setFlow] = useState<Workflow | null>(null);
  const { toast, confirm } = useUi();
  useFocusRecord(focusId, data, (v) => v.id, (v) => setOpenId(v.id), onFocusHandled);

  const now = Date.now();
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = (data ?? []).filter((v) => {
      const st = stateOf(v);
      const f = filter === 'all' ? true
        : filter === 'upcoming' ? st === 'Scheduled'
        : filter === 'reports' ? st === 'Completed' && reportOf(v) === 'Report pending'
        : filter === 'completed' ? st === 'Completed' : st === 'Cancelled';
      return f && (!s || `${v.purpose} ${whoOf(v)} ${v.directory_contact_name ?? ''} ${v.notes}`.toLowerCase().includes(s));
    });
    // upcoming first (soonest), then the rest newest first; undated scheduled visits at the end of upcoming
    const t = (v: ConsultantVisit) => (v.planned_at ? Date.parse(v.planned_at) : Number.POSITIVE_INFINITY);
    return rows.sort((a, b) => {
      const sa = stateOf(a) === 'Scheduled', sb = stateOf(b) === 'Scheduled';
      if (sa !== sb) return sa ? -1 : 1;
      return sa ? t(a) - t(b) : (Date.parse(b.actual_visit_at || b.planned_at || '') || 0) - (Date.parse(a.actual_visit_at || a.planned_at || '') || 0);
    });
  }, [data, filter, q]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const canWrite = (v: ConsultantVisit | null) => manager || (own && (!v || v.consultant_user_id === user.id));
  const counts = {
    upcoming: data.filter((v) => stateOf(v) === 'Scheduled').length,
    reports: data.filter((v) => stateOf(v) === 'Completed' && reportOf(v) === 'Report pending').length,
    completed: data.filter((v) => stateOf(v) === 'Completed').length,
    cancelled: data.filter((v) => stateOf(v) === 'Cancelled').length,
    all: data.length,
  };
  const open = data.find((v) => v.id === openId) ?? null;
  const internalMembers = (members ?? []).filter((m) => m.role === 'admin' || m.role === 'project_manager');

  const scheduleFields = (row: ConsultantVisit | null): FieldSpec[] => [
    { name: '_s1', label: 'Consultant', type: 'section' },
    ...(manager ? dir.fields(row, { label: 'Consultant / company (Contacts)', help: 'Entries assigned to this project. The contact list shows that company’s people only.' }) : []),
    { name: 'consultant_name', label: 'Or consultant name (free text)', help: manager ? 'Use when the consultant is not in Contacts. Kept as typed.' : undefined },
    { name: 'consultant_user_id', label: 'Consultant user account (can update this visit)', type: 'select', nullable: true, hidden: !manager, options: (members ?? []).filter((m) => m.role === 'consultant').map((m) => ({ value: m.id, label: m.name })) },
    { name: '_s2', label: 'Visit', type: 'section' },
    { name: 'planned_at', label: 'Date & time', type: 'datetime', hidden: !!row },
    { name: 'purpose', label: 'Purpose / scope', required: true, wide: true, placeholder: 'e.g. Slab reinforcement inspection before casting' },
    { name: 'related_task_id', label: 'Related timeline task (optional)', type: 'searchselect', nullable: true, options: taskOptions, wide: true },
    { name: 'assigned_user_id', label: 'Internal person responsible (optional)', type: 'select', nullable: true, hidden: !manager, options: internalMembers.map((m) => ({ value: m.id, label: m.name })) },
    { name: 'related_milestone_id', label: 'Related consultant payment (optional)', type: 'searchselect', nullable: true, hidden: !payments,
      options: (payments?.milestones ?? []).filter((m) => !m.archived_at).map((m) => ({ value: m.id, label: `${m.payee_name} — ${m.description}`, group: m.payee_type === 'consultant' ? 'Consultant payments' : 'Other payments' })),
      help: 'Only a link to the payment record — nothing is paid or changed here.' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
    ...(row ? [
      { name: '_s3', label: 'Findings', type: 'section' as const },
      { name: 'areas_inspected', label: 'Areas inspected', type: 'textarea' as const },
      { name: 'observations', label: 'Observations / findings', type: 'textarea' as const },
      { name: 'instructions', label: 'Instructions issued', type: 'textarea' as const },
      { name: 'next_visit_date', label: 'Next visit (planned)', type: 'date' as const },
    ] : []),
  ];

  const archive = async (v: ConsultantVisit) => {
    if (!(await confirm(<>Archive the visit <b>{v.purpose}</b>? It is kept with its files and history and can be restored.</>, { title: 'Archive visit', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(`${base}/consultant/${v.id}/archive`); toast('Visit archived'); setOpenId(null); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="space-y-5">
      <PageHeader icon={<UserCheck className="w-5 h-5" />} title="Consultant Visits" subtitle={`${project.name} — ${project.code} · inspections, reports and follow-up`}
        actions={<>
          <LinkButton href={project.consultant_drive_url} label="Consultant reports Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          {(manager || own) && <Button variant="primary" onClick={() => setForm({ row: null })}><Plus className="w-4 h-4" />Schedule visit</Button>}
        </>} />

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show visits" className="inline-flex flex-wrap rounded-lg border border-slate-200 overflow-hidden bg-white">
          {([['upcoming', 'Upcoming'], ['reports', 'Reports pending'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={`px-3 py-1.5 text-sm min-h-9 border-l first:border-l-0 border-slate-200 ${filter === id ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}>
              {label} <span className={`ml-0.5 text-xs ${id === 'reports' && counts.reports ? 'text-amber-700 font-bold' : 'text-slate-400'}`}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <label className="relative flex-1 min-w-[160px] max-w-xs">
          <span className="sr-only">Search visits</span>
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input type="search" className={`${inputCls} pl-8`} placeholder="Search purpose, consultant…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div role="group" aria-label="View" className="ml-auto inline-flex rounded-lg border border-slate-200 overflow-hidden bg-white">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')} className={`px-3 py-1.5 text-sm min-h-9 inline-flex items-center gap-1 ${view === 'list' ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600'}`}><List className="w-4 h-4" />List</button>
          <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')} className={`px-3 py-1.5 text-sm min-h-9 inline-flex items-center gap-1 border-l border-slate-200 ${view === 'calendar' ? 'bg-sky-50 text-sky-800 font-semibold' : 'text-slate-600'}`}><CalendarDays className="w-4 h-4" />Calendar</button>
        </div>
      </div>

      {view === 'calendar' ? <VisitCalendar onOpen={setOpenId} entries={list.map((v) => {
        const st = stateOf(v);
        return { id: v.id, title: v.purpose, iso: st === 'Completed' && v.actual_visit_at ? v.actual_visit_at : v.planned_at, tone: st === 'Completed' ? 'emerald' : st === 'Cancelled' ? 'slate' : 'sky', struck: st === 'Cancelled', label: st };
      })} /> : (
        <Card className="!p-0 overflow-hidden">
          {list.length === 0 ? <div className="p-6"><EmptyState title={data.length ? 'No visits in this view' : 'No consultant visits yet'}>{data.length ? 'Choose another filter.' : (manager || own) ? 'Use “Schedule visit” to plan the first inspection.' : ''}</EmptyState></div> : (
            <ul className="divide-y divide-slate-100" data-testid="visit-list">
              {list.map((v) => {
                const openActions = v.actions.filter((a) => a.status === 'Open').length;
                const when = v.actual_visit_at && stateOf(v) === 'Completed' ? v.actual_visit_at : v.planned_at;
                const overdue = stateOf(v) === 'Scheduled' && v.planned_at && Date.parse(v.planned_at) < now - 86400_000;
                return (
                  <li key={v.id} id={`rec-${v.id}`}>
                    <button type="button" onClick={() => setOpenId(v.id)} className="w-full text-left px-4 py-3 hover:bg-slate-50 grid grid-cols-[3.25rem_minmax(0,1fr)] sm:grid-cols-[3.25rem_minmax(0,1fr)_auto] gap-3 items-start">
                      <DateTile iso={when} muted={stateOf(v) === 'Cancelled'} />
                      <span className="min-w-0">
                        <span className={`block text-sm font-semibold break-words ${stateOf(v) === 'Cancelled' ? 'text-slate-500 line-through' : 'text-slate-900'}`}>{v.purpose}</span>
                        <span className="block text-xs text-slate-600 mt-0.5">{whoOf(v)}{v.directory_contact_name ? ` · ${v.directory_contact_name}` : ''}</span>
                        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{when ? formatDateTime(when) : 'Date not set'}{stateOf(v) === 'Completed' && v.actual_visit_at ? ' (visited)' : ''}</span>
                          {overdue && <span className="text-amber-700 font-semibold">Date passed — mark completed or reschedule</span>}
                          {v.related_task_name && <span>Task: {v.related_task_name}</span>}
                          {openActions > 0 && <span className="text-amber-700">{openActions} open action{openActions === 1 ? '' : 's'}</span>}
                          {(v.comment_count ?? 0) > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="w-3 h-3" />{v.comment_count}</span>}
                        </span>
                      </span>
                      <span className="col-start-2 sm:col-start-3 sm:justify-self-end"><StateBadges v={v} /></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      <p className="text-xs text-slate-500">Consultant fees are recorded in Payments (payee type “Consultant”). A visit can link to its payment record, but nothing is paid or changed from here.</p>

      <Modal open={!!form} onClose={() => setForm(null)} wide title={form?.row ? 'Edit visit details' : 'Schedule consultant visit'}>
        {form && (
          <RecordForm key={form.row?.id ?? 'new'} fields={scheduleFields(form.row)} initial={form.row ?? { status: 'Planned' }} mode={form.row ? 'edit' : 'create'} onCancel={() => setForm(null)}
            submitLabel={form.row ? 'Save' : 'Schedule visit'}
            onSubmit={async (v) => {
              if (form.row) { await patch(`${base}/consultant/${form.row.id}`, v); toast('Visit saved'); await reload(); setForm(null); }
              else { const r = await post<ConsultantVisit>(`${base}/consultant`, v); toast('Visit scheduled'); await reload(); setForm(null); setOpenId(r.id); }
            }} />
        )}
      </Modal>
      {dir.dialog}

      {open && !form && !flow && (
        <VisitPanel project={project} v={open} base={base} writable={canWrite(open)} manager={manager} members={members ?? []}
          onClose={() => setOpenId(null)} onChanged={reload} onEdit={() => setForm({ row: open })} onFlow={(kind) => setFlow({ kind, v: open })} onArchive={() => archive(open)} />
      )}
      {flow && <WorkflowDialog base={base} flow={flow} onClose={() => setFlow(null)} onDone={async (msg) => { toast(msg); setFlow(null); await reload(); }} />}
      <RestoreArchived base={`${base}/consultant`} onDone={reload} canRestore={manager} />
    </div>
  );
}

function VisitPanel({ project, v, base, writable, manager, members, onClose, onChanged, onEdit, onFlow, onArchive }: {
  project: Project; v: ConsultantVisit; base: string; writable: boolean; manager: boolean; members: Member[];
  onClose: () => void; onChanged: () => Promise<void>; onEdit: () => void; onFlow: (k: Workflow['kind']) => void; onArchive: () => void;
}) {
  const st = stateOf(v);
  const { can } = useSession();
  return (
    <Modal open wide title={v.purpose} subtitle={`Consultant visit · ${project.code}`} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StateBadges v={v} />
          {writable && (
            <div className="flex flex-wrap gap-2">
              {st !== 'Completed' && <Button size="sm" onClick={() => onFlow('reschedule')}><CalendarDays className="w-3.5 h-3.5" />{st === 'Cancelled' ? 'Reschedule (reopen)' : 'Reschedule'}</Button>}
              {st === 'Scheduled' && <Button size="sm" variant="primary" onClick={() => onFlow('complete')}><CheckCircle2 className="w-3.5 h-3.5" />Mark completed</Button>}
              {st === 'Scheduled' && <Button size="sm" variant="ghost" onClick={() => onFlow('cancel')}><CalendarX2 className="w-3.5 h-3.5" />Cancel visit</Button>}
              <Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="w-3.5 h-3.5" />Edit details</Button>
              {manager && <Button size="sm" variant="ghost" onClick={onArchive} aria-label="Archive visit"><Archive className="w-3.5 h-3.5" /></Button>}
            </div>
          )}
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Item label="Consultant">
            <span className="font-semibold">{whoOf(v)}</span>
            {v.consultant_name && v.directory_entry_name && v.consultant_name !== v.directory_entry_name && <span className="block text-xs text-slate-500">Recorded as “{v.consultant_name}”</span>}
            {v.directory_entry_phone && <span className="block text-xs text-slate-500">Office {formatPhone(v.directory_entry_phone)}</span>}
            <DirectoryLinkBadge row={v} />
          </Item>
          <Item label="Contact person">
            {v.directory_contact_name ? <>
              <span className="font-semibold">{v.directory_contact_name}</span>{v.directory_contact_position && <span className="text-xs text-slate-500"> · {v.directory_contact_position}</span>}
              <span className="block text-xs text-slate-500">{[v.directory_contact_mobile && formatPhone(v.directory_contact_mobile), v.directory_contact_email].filter(Boolean).join(' · ')}</span>
              {(v.directory_contact_mobile || v.directory_contact_email || v.directory_contact_whatsapp) && <div className="mt-1"><ContactActions phone={v.directory_contact_mobile} whatsappNumber={v.directory_contact_whatsapp} email={v.directory_contact_email} compact name={v.directory_contact_name ?? undefined} /></div>}
            </> : <span className="text-slate-500">Not set</span>}
          </Item>
          <Item label="Scheduled">{v.planned_at ? formatDateTime(v.planned_at) : 'Not set'}{v.status === 'Rescheduled' && <span className="block text-xs text-slate-500">Rescheduled — see activity history</span>}</Item>
          <Item label="Actual visit">{v.actual_visit_at ? formatDateTime(v.actual_visit_at) : st === 'Completed' ? 'Not recorded' : '—'}</Item>
          <Item label="Related task">{v.related_task_name ? <a className="text-sky-700 hover:underline" href={`#/timeline/${project.id}/${v.related_task_id}`} onClick={onClose}>{v.related_task_name}</a> : '—'}</Item>
          <Item label="Internal responsible">{v.assigned_user_name ? <AvatarName userId={v.assigned_user_id} name={v.assigned_user_name} version={v.assigned_user_avatar_version} size="sm" /> : '—'}{v.consultant_user_name && <span className="block text-xs text-slate-500">Consultant account: {v.consultant_user_name}</span>}</Item>
          {v.related_milestone_id && (
            <Item label="Related payment">{can('payments.read') && v.related_milestone_payee
              ? <a className="text-sky-700 hover:underline" href={`#/payments/${project.id}/${v.related_milestone_id}`} onClick={onClose}>{v.related_milestone_payee} — {v.related_milestone_description}</a>
              : 'Linked (not available for your role)'}</Item>
          )}
          {st === 'Cancelled' && <Item label="Cancellation">{v.cancel_reason || 'No reason recorded'}</Item>}
          {v.notes && <div className="sm:col-span-2"><Item label="Notes"><span className="whitespace-pre-wrap">{v.notes}</span></Item></div>}
          {(v.observations || v.instructions || v.areas_inspected) && (
            <div className="sm:col-span-2 grid gap-3 sm:grid-cols-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <Item label="Areas inspected"><span className="whitespace-pre-wrap">{v.areas_inspected || '—'}</span></Item>
              <Item label="Observations"><span className="whitespace-pre-wrap">{v.observations || '—'}</span></Item>
              <Item label="Instructions"><span className="whitespace-pre-wrap">{v.instructions || '—'}</span></Item>
            </div>
          )}
        </dl>

        <Attachments projectId={project.id} entityType="consultant_visit" entityId={v.id} defaultKind="consultant_report" title="Reports & files"
          canUpload={writable} onChange={() => void onChanged()}
          hint={st === 'Completed' && reportOf(v) === 'Report pending' ? <span className="text-amber-800 font-semibold">This visit is completed and its report is still pending.</span> : 'Uploading a report sets “Report uploaded”; it does not complete the visit or pay anything.'} />

        <VisitActions base={base} type="consultant" visitId={v.id} actions={v.actions ?? []} canEdit={writable} onChange={() => void onChanged()}
          members={manager ? members.map((m) => ({ id: m.id, name: m.name })) : undefined} />

        <Comments base={base} type="consultant" visitId={v.id} canPost={writable} onPosted={onChanged} />

        <VisitHistory base={base} type="consultant" visitId={v.id} />
      </div>
    </Modal>
  );
}

function WorkflowDialog({ base, flow, onClose, onDone }: { base: string; flow: Workflow; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const { v, kind } = flow;
  const defaultActual = v.planned_at && Date.parse(v.planned_at) <= Date.now() ? v.planned_at : new Date().toISOString();
  const cfg = {
    reschedule: {
      title: 'Reschedule visit', submit: 'Save new date',
      fields: [{ name: 'planned_at', label: 'New date & time', type: 'datetime', required: true }, { name: 'reason', label: 'Reason (kept in the history)', type: 'textarea' }] as FieldSpec[],
      initial: { planned_at: v.planned_at }, url: 'reschedule', msg: 'Visit rescheduled',
    },
    complete: {
      title: 'Mark visit completed', submit: 'Mark completed',
      fields: [{ name: 'actual_visit_at', label: 'Actual visit date & time', type: 'datetime', required: true, help: 'Change it if the visit happened on a different day or time than planned.' }] as FieldSpec[],
      initial: { actual_visit_at: defaultActual }, url: 'complete', msg: 'Visit marked completed — upload the report when it arrives',
    },
    cancel: {
      title: 'Cancel visit', submit: 'Cancel visit',
      fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea' }] as FieldSpec[],
      initial: {}, url: 'cancel', msg: 'Visit cancelled',
    },
  }[kind];
  return (
    <Modal open title={cfg.title} subtitle={v.purpose} onClose={onClose}>
      {kind === 'complete' && <p className="text-xs text-slate-600 mb-3">The report status stays as it is: {reportOf(v).toLowerCase()}. Completing a visit never marks a payment paid.</p>}
      <RecordForm mode="create" fields={cfg.fields} initial={cfg.initial} submitLabel={cfg.submit} onCancel={onClose}
        onSubmit={async (vals) => { await post(`${base}/consultant/${v.id}/${cfg.url}`, vals); await onDone(cfg.msg); }} />
    </Modal>
  );
}

/** Small helper listing archived visits for restore (managers only). */
export function RestoreArchived({ base, onDone, canRestore }: { base: string; onDone: () => void; canRestore: boolean }) {
  const [show, setShow] = useState(false);
  const { data, reload } = useApi<any[]>(show ? `${base}?includeArchived=1` : null);
  const { toast } = useUi();
  if (!canRestore) return null;
  const archived = (data ?? []).filter((x) => x.archived_at);
  return (
    <div className="text-xs">
      <button className="text-slate-500 hover:text-slate-800 underline" onClick={() => setShow(!show)}>{show ? 'Hide archived' : 'Show archived records'}</button>
      {show && (archived.length === 0 ? <p className="text-slate-400 mt-2">No archived records.</p> : (
        <ul className="mt-2 space-y-1">
          {archived.map((x) => (
            <li key={x.id} className="flex items-center gap-2">
              <span className="text-slate-600">{x.purpose}</span>
              <Button size="sm" variant="ghost" onClick={async () => { await post(`${base}/${x.id}/restore`); toast('Restored'); await reload(); onDone(); }}><RotateCcw className="w-3.5 h-3.5" />Restore</Button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}


