import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive, CalendarDays, CalendarX2, CheckCircle2, ClipboardList, Clock, FolderOpen, List, ListChecks, MapPin, MessageSquare, Paperclip, Pencil, PlayCircle, Plus, Search,
} from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, ConsultantVisit, Member, Project, SiteVisit } from '../lib/types';
import { formatDateTime, todayLocalISO } from '../lib/format';
import { AvatarName } from '../components/Avatar';
import { siteVisitState, type SiteVisitState } from '../../shared/constants';
import { formatPhone } from '../../shared/directory';
import { Attachments } from '../components/Attachments';
import { VisitActions } from '../components/VisitActions';
import { Badge, Button, Card, EmptyState, inputCls, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, useUi, type FieldSpec } from '../components/ui';
import { DirectoryLinkBadge, useDirectoryLink } from '../components/directory/DirectoryLink';
import { ContactActions } from '../components/directory/ContactActions';
import { Comments, DateTile, Item, Segmented, VisitCalendar, VisitHistory } from '../components/visits/shared';
import { RestoreArchived, useLinkOptions } from './ConsultantVisits';

type Filter = 'upcoming' | 'in_progress' | 'completed' | 'cancelled' | 'actions' | 'all';
type Flow = { kind: 'start' | 'complete' | 'reschedule' | 'cancel'; v: SiteVisit };
const STATE_TONE: Record<SiteVisitState, 'sky' | 'amber' | 'emerald' | 'slate'> = { Scheduled: 'sky', 'In progress': 'amber', Completed: 'emerald', Cancelled: 'slate' };
const stateOf = (v: SiteVisit): SiteVisitState => v.visit_state ?? siteVisitState(v.status);
const openActionsOf = (v: SiteVisit) => v.open_action_count ?? v.actions.filter((a) => a.status === 'Open').length;
const assigneeOf = (v: SiteVisit) => v.assigned_user_name || v.assigned_name || '';
/** completed visits are placed at their actual time when recorded; everything else at the planned time */
const whenOf = (v: SiteVisit) => (stateOf(v) === 'Completed' && v.actual_visit_at ? v.actual_visit_at : v.visit_at);

export function StateBadge({ v }: { v: SiteVisit }) {
  const st = stateOf(v);
  return <Badge tone={STATE_TONE[st]}>{st}{v.status === 'Rescheduled' ? ' (rescheduled)' : ''}</Badge>;
}

/**
 * Site visits (owner / internal supervision, coordination, progress and material checks, snagging):
 * schedule → visit summary → findings, photos, follow-up actions and comments. Start and completion are
 * open to managers and the assigned user; rescheduling, cancelling, reassigning and archiving to managers.
 * No consultant report or payment is involved.
 */
export function SiteVisits({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/visits`;
  const { data, error, reload } = useApi<SiteVisit[]>(`${base}/site`);
  const { user, can } = useSession();
  const manager = can('site.write') && !project.archived_at;
  const assignee = can('site.assigned') && !project.archived_at;
  const { data: members } = useApi<Member[]>(manager ? `/api/projects/${project.id}/members` : null);
  const { data: cvs } = useApi<ConsultantVisit[]>(manager && can('consultant.read') ? `${base}/consultant` : null);
  const { taskOptions, materialOptions } = useLinkOptions(project.id);
  const dir = useDirectoryLink(project);
  const { toast, confirm } = useUi();
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ row: SiteVisit | null; findings?: boolean } | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  useFocusRecord(focusId, data, (v) => v.id, (v) => setOpenId(v.id), onFocusHandled);
  useEffect(() => {
    if (focusId === 'filter:overdue-actions') { setFilter('actions'); setView('list'); onFocusHandled?.(); }
  }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = todayLocalISO();
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = (data ?? []).filter((v) => {
      const st = stateOf(v);
      const f = filter === 'all' ? true
        : filter === 'upcoming' ? st === 'Scheduled'
        : filter === 'in_progress' ? st === 'In progress'
        : filter === 'completed' ? st === 'Completed'
        : filter === 'cancelled' ? st === 'Cancelled'
        : st !== 'Cancelled' && openActionsOf(v) > 0;
      const w = !who || (who === '_none' ? !assigneeOf(v) : who === v.assigned_user_id || who === `name:${v.assigned_name}`);
      return f && w && (!s || `${v.purpose} ${assigneeOf(v)} ${v.areas} ${v.directory_entry_name ?? ''} ${v.directory_contact_name ?? ''} ${v.findings} ${v.decisions ?? ''} ${v.notes}`.toLowerCase().includes(s));
    });
    const t = (v: SiteVisit) => (v.visit_at ? Date.parse(v.visit_at) : Number.POSITIVE_INFINITY);
    const live = (st: SiteVisitState) => st === 'Scheduled' || st === 'In progress';
    // in progress and upcoming first (soonest), then the rest newest first
    return rows.sort((a, b) => {
      const la = live(stateOf(a)), lb = live(stateOf(b));
      if (la !== lb) return la ? -1 : 1;
      return la ? t(a) - t(b) : (Date.parse(whenOf(b) ?? '') || 0) - (Date.parse(whenOf(a) ?? '') || 0);
    });
  }, [data, filter, who, q]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const isAssignee = (v: SiteVisit | null) => !!v && assignee && v.assigned_user_id === user.id;
  const canWrite = (v: SiteVisit | null) => manager || isAssignee(v);
  const active = data.filter((v) => stateOf(v) !== 'Cancelled');
  const counts = {
    upcoming: data.filter((v) => stateOf(v) === 'Scheduled').length,
    in_progress: data.filter((v) => stateOf(v) === 'In progress').length,
    completed: data.filter((v) => stateOf(v) === 'Completed').length,
    cancelled: data.filter((v) => stateOf(v) === 'Cancelled').length,
    actions: active.filter((v) => openActionsOf(v) > 0).length,
    all: data.length,
  };
  const openActions = active.reduce((n, v) => n + openActionsOf(v), 0);
  const overdueActions = active.reduce((n, v) => n + v.actions.filter((a) => a.status === 'Open' && a.due_date && a.due_date < today).length, 0);
  const assignees = [...new Map(data.filter((v) => assigneeOf(v)).map((v) => [v.assigned_user_id ?? `name:${v.assigned_name}`, assigneeOf(v)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const open = data.find((v) => v.id === openId) ?? null;
  const cvOptions = (cvs ?? []).filter((c) => !c.archived_at).map((c) => ({ value: c.id, label: `${formatDateTime(c.planned_at, 'No date')} · ${c.purpose}` }));

  const scheduleFields = (row: SiteVisit | null): FieldSpec[] => [
    { name: 'purpose', label: 'Purpose / title', required: true, wide: true, placeholder: 'e.g. Check tile storage and first-floor blockwork' },
    { name: 'visit_at', label: 'Planned date & time', type: 'datetime', hidden: !!row },
    { name: 'assigned_user_id', label: 'Assigned internal user', type: 'select', nullable: true, options: (members ?? []).map((m) => ({ value: m.id, label: m.name, hint: m.role })), help: 'Can start and complete the visit and record findings. Assigning gives no other access.' },
    ...(row?.assigned_name ? [{ name: 'assigned_name', label: 'Assigned person (recorded name)', help: 'Historical free-text name, kept as recorded.' } as FieldSpec] : []),
    { name: 'areas', label: 'Areas to inspect (optional)', type: 'textarea' },
    { name: '_s1', label: 'Related records (optional)', type: 'section' },
    ...dir.fields(row, { label: 'Company / individual (Contacts)', help: 'External party for this visit, separate from the assigned internal user.' }),
    { name: 'related_task_id', label: 'Related timeline task', type: 'searchselect', nullable: true, options: taskOptions, wide: true },
    { name: 'related_material_id', label: 'Related material line', type: 'searchselect', nullable: true, options: materialOptions, wide: true },
    { name: 'related_consultant_visit_id', label: 'Related consultant visit', type: 'searchselect', nullable: true, options: cvOptions, wide: true, hidden: !cvs },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  const findingsFields: FieldSpec[] = [
    { name: 'findings', label: 'Observations & issues identified', type: 'textarea' },
    { name: 'decisions', label: 'Decisions & instructions', type: 'textarea' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const archive = async (v: SiteVisit) => {
    if (!(await confirm(<>Archive the site visit <b>{v.purpose}</b>? It is kept with its photos, actions and history and can be restored.</>, { title: 'Archive visit', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(`${base}/site/${v.id}/archive`); toast('Visit archived'); setOpenId(null); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="space-y-5">
      <PageHeader icon={<MapPin className="w-5 h-5" />} title="Site Visits" subtitle={`${project.name} — ${project.code} · supervision, coordination, progress and material checks, snagging`}
        actions={<>
          <LinkButton href={project.site_visits_drive_url} label="Site visits Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          {manager && <Button variant="primary" onClick={() => setForm({ row: null })}><Plus className="w-4 h-4" />Schedule site visit</Button>}
        </>} />

      <section aria-label="Site visit summary">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Summary label="Upcoming visits" value={counts.upcoming} hint="Scheduled, not yet started" icon={<CalendarDays className="w-4 h-4 text-sky-600" />} onClick={() => setFilter('upcoming')} active={filter === 'upcoming'} />
          <Summary label="In progress" value={counts.in_progress} hint="Started, not completed" icon={<PlayCircle className="w-4 h-4 text-amber-600" />} onClick={() => setFilter('in_progress')} active={filter === 'in_progress'} />
          <Summary label="Completed visits" value={counts.completed} hint="All time" icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} onClick={() => setFilter('completed')} active={filter === 'completed'} />
          <Summary label="Open follow-up actions" value={openActions} hint={overdueActions ? <span className="text-rose-700 font-semibold">{overdueActions} past due date</span> : `On ${counts.actions} visit${counts.actions === 1 ? '' : 's'}`}
            icon={<ListChecks className="w-4 h-4 text-slate-500" />} onClick={() => setFilter('actions')} active={filter === 'actions'} />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">Counts cover this project’s site visits that are not archived. Cancelled visits are excluded from the follow-up count.</p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Show visits" value={filter} onChange={setFilter} options={([
          ['upcoming', 'Upcoming'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['actions', 'Open actions'], ['cancelled', 'Cancelled'], ['all', 'All'],
        ] as const).map(([id, label]) => ({ id, label: <>{label} <span className="ml-0.5 text-xs text-slate-400">{counts[id]}</span></> }))} />
        <select className={`${inputCls} !w-auto max-w-[14rem]`} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Assigned person">
          <option value="">All assignees</option>
          {assignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          <option value="_none">Unassigned</option>
        </select>
        <label className="relative flex-1 min-w-[160px] max-w-xs">
          <span className="sr-only">Search site visits</span>
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input type="search" className={`${inputCls} pl-8`} placeholder="Search purpose, area, person…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="ml-auto"><Segmented label="View" value={view} onChange={setView} options={[{ id: 'list', label: <><List className="w-4 h-4" />List</> }, { id: 'calendar', label: <><CalendarDays className="w-4 h-4" />Calendar</> }]} /></div>
      </div>

      {view === 'calendar' ? (
        <VisitCalendar onOpen={setOpenId} entries={list.map((v) => ({ id: v.id, title: v.purpose, iso: whenOf(v), tone: STATE_TONE[stateOf(v)], struck: stateOf(v) === 'Cancelled', label: stateOf(v) }))} />
      ) : (
        <Card className="!p-0 overflow-hidden">
          {list.length === 0 ? <div className="p-6"><EmptyState title={data.length ? 'No visits in this view' : 'No site visits yet'}>{data.length ? 'Choose another filter or clear the search.' : manager ? 'Use “Schedule site visit” to plan the first visit.' : ''}</EmptyState></div> : (
            <ul className="divide-y divide-slate-100" data-testid="site-visit-list">
              {list.map((v) => {
                const st = stateOf(v);
                const when = whenOf(v);
                const nOpen = openActionsOf(v);
                const late = st === 'Scheduled' && v.visit_at && Date.parse(v.visit_at) < Date.now() - 86400_000;
                return (
                  <li key={v.id} id={`rec-${v.id}`} className="px-4 py-3 grid grid-cols-[3.25rem_minmax(0,1fr)] sm:grid-cols-[3.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-start hover:bg-slate-50/60">
                    <DateTile iso={when} muted={st === 'Cancelled'} />
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold break-words ${st === 'Cancelled' ? 'text-slate-500 line-through' : 'text-slate-900'}`}>{v.purpose}</p>
                      <p className="text-xs text-slate-600 mt-0.5">{assigneeOf(v) || <span className="text-slate-400">Unassigned</span>}{v.areas ? <span className="text-slate-500"> · {v.areas.split('\n')[0]}</span> : ''}</p>
                      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{when ? formatDateTime(when) : 'Date not set'}{st === 'Completed' ? (v.actual_visit_at ? ' (actual)' : ' (planned)') : ''}</span>
                        {late && <span className="text-amber-700 font-semibold">Planned date passed — start, complete or reschedule</span>}
                        {v.attachment_count > 0 && <span className="inline-flex items-center gap-1"><Paperclip className="w-3 h-3" />{v.attachment_count} file{v.attachment_count === 1 ? '' : 's'}</span>}
                        {nOpen > 0 && <span className="inline-flex items-center gap-1 text-amber-700"><ClipboardList className="w-3 h-3" />{nOpen} open action{nOpen === 1 ? '' : 's'}</span>}
                        {(v.comment_count ?? 0) > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="w-3 h-3" />{v.comment_count}</span>}
                      </p>
                    </div>
                    <div className="col-start-2 sm:col-start-3 flex items-center gap-2 sm:justify-end">
                      <StateBadge v={v} />
                      <Button size="sm" onClick={() => setOpenId(v.id)} aria-label={`Open details: ${v.purpose}`}>Open details</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} wide title={form?.findings ? 'Findings' : form?.row ? 'Edit visit details' : 'Schedule site visit'} subtitle={form?.row?.purpose}>
        {form && (form.findings ? (
          <RecordForm key={`f-${form.row!.id}`} fields={findingsFields} initial={form.row!} mode="edit" onCancel={() => setForm(null)}
            extra={<p className="text-[11px] text-slate-500">Saving findings does not complete the visit or close any follow-up action.</p>}
            onSubmit={async (v) => { await patch(`${base}/site/${form.row!.id}`, v); toast('Findings saved'); await reload(); setForm(null); }} />
        ) : (
          <RecordForm key={form.row?.id ?? 'new'} fields={scheduleFields(form.row)} initial={form.row ?? { status: 'Planned' }} mode={form.row ? 'edit' : 'create'} onCancel={() => setForm(null)}
            submitLabel={form.row ? 'Save' : 'Schedule site visit'}
            onSubmit={async (v) => {
              if (form.row) { await patch(`${base}/site/${form.row.id}`, v); toast('Visit saved'); await reload(); setForm(null); }
              else { const r = await post<SiteVisit>(`${base}/site`, v); toast('Site visit scheduled'); await reload(); setForm(null); setOpenId(r.id); }
            }} />
        ))}
      </Modal>
      {dir.dialog}

      {open && !form && !flow && (
        <VisitPanel project={project} v={open} base={base} writable={canWrite(open)} manager={manager} members={members ?? []} today={today}
          onClose={() => setOpenId(null)} onChanged={reload} onEdit={() => setForm({ row: open })} onFindings={() => setForm({ row: open, findings: true })}
          onFlow={(kind) => setFlow({ kind, v: open })} onArchive={() => archive(open)} />
      )}
      {flow && <SiteWorkflowDialog base={base} flow={flow} onClose={() => setFlow(null)} onDone={async (msg) => { toast(msg); setFlow(null); await reload(); }} />}
      <RestoreArchived base={`${base}/site`} onDone={reload} canRestore={manager} />
    </div>
  );
}

function Summary({ label, value, hint, icon, onClick, active }: { label: string; value: number; hint: React.ReactNode; icon: React.ReactNode; onClick: () => void; active: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`text-left rounded-xl border bg-white px-4 py-3 min-w-0 hover:border-sky-300 ${active ? 'border-sky-400 ring-1 ring-sky-400' : 'border-slate-200'}`}>
      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">{icon}{label}</span>
      <span className="block mt-1 text-2xl font-bold font-mono tabular-nums text-slate-900">{value}</span>
      <span className="block text-[11px] text-slate-500">{hint}</span>
    </button>
  );
}

function VisitPanel({ project, v, base, writable, manager, members, today, onClose, onChanged, onEdit, onFindings, onFlow, onArchive }: {
  project: Project; v: SiteVisit; base: string; writable: boolean; manager: boolean; members: Member[]; today: string;
  onClose: () => void; onChanged: () => Promise<void>; onEdit: () => void; onFindings: () => void; onFlow: (k: Flow['kind']) => void; onArchive: () => void;
}) {
  const st = stateOf(v);
  const overdue = v.actions.filter((a) => a.status === 'Open' && a.due_date && a.due_date < today).length;
  return (
    <Modal open wide title={v.purpose} subtitle={`Site visit · ${project.code}`} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StateBadge v={v} />
            {openActionsOf(v) > 0 && <Badge tone={overdue ? 'rose' : 'amber'}>{openActionsOf(v)} open action{openActionsOf(v) === 1 ? '' : 's'}{overdue ? ` · ${overdue} overdue` : ''}</Badge>}
          </span>
          <div className="flex flex-wrap gap-2" aria-label="Visit actions">
            {writable && st === 'Scheduled' && <Button size="sm" onClick={() => onFlow('start')}><PlayCircle className="w-3.5 h-3.5" />Start visit</Button>}
            {writable && (st === 'Scheduled' || st === 'In progress') && <Button size="sm" variant="primary" onClick={() => onFlow('complete')}><CheckCircle2 className="w-3.5 h-3.5" />Mark completed</Button>}
            {manager && st !== 'Completed' && <Button size="sm" onClick={() => onFlow('reschedule')}><CalendarDays className="w-3.5 h-3.5" />{st === 'Cancelled' ? 'Reschedule (reopen)' : 'Reschedule'}</Button>}
            {manager && (st === 'Scheduled' || st === 'In progress') && <Button size="sm" variant="ghost" onClick={() => onFlow('cancel')}><CalendarX2 className="w-3.5 h-3.5" />Cancel visit</Button>}
            {manager && <Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="w-3.5 h-3.5" />Edit details</Button>}
            {manager && <Button size="sm" variant="ghost" onClick={onArchive} aria-label="Archive visit"><Archive className="w-3.5 h-3.5" /></Button>}
          </div>
        </div>

        <section aria-labelledby="sv-overview">
          <h4 id="sv-overview" className="text-xs font-bold text-slate-700 mb-2">Overview</h4>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Item label="Planned">{v.visit_at ? formatDateTime(v.visit_at) : 'Not set'}{v.status === 'Rescheduled' && <span className="block text-xs text-slate-500">Rescheduled — see activity history</span>}</Item>
            <Item label="Actual visit">{v.actual_visit_at ? formatDateTime(v.actual_visit_at) : st === 'Completed' ? 'Not recorded' : '—'}{v.started_at && <span className="block text-xs text-slate-500">Started {formatDateTime(v.started_at)}</span>}</Item>
            <Item label="Assigned">{v.assigned_user_name ? <AvatarName userId={v.assigned_user_id} name={v.assigned_user_name} version={v.assigned_user_avatar_version} size="sm" /> : assigneeOf(v) || 'Unassigned'}{v.assigned_user_name && v.assigned_name && v.assigned_name !== v.assigned_user_name && <span className="block text-xs text-slate-500">Recorded name: {v.assigned_name}</span>}</Item>
            <Item label="Company / contact">
              {v.directory_entry_name || v.directory_contact_name ? <>
                <span className="font-semibold">{v.directory_entry_name}</span>{v.directory_contact_name && <span> · {v.directory_contact_name}{v.directory_contact_position ? <span className="text-xs text-slate-500"> ({v.directory_contact_position})</span> : null}</span>}
                <span className="block text-xs text-slate-500">{[v.directory_contact_mobile && formatPhone(v.directory_contact_mobile), v.directory_contact_email].filter(Boolean).join(' · ')}</span>
                {(v.directory_contact_mobile || v.directory_contact_email || v.directory_contact_whatsapp) && <div className="mt-1"><ContactActions phone={v.directory_contact_mobile} whatsappNumber={v.directory_contact_whatsapp} email={v.directory_contact_email} compact name={v.directory_contact_name ?? undefined} /></div>}
                <DirectoryLinkBadge row={v} />
              </> : <span className="text-slate-500">None</span>}
            </Item>
            <div className="sm:col-span-2"><Item label="Areas to inspect"><span className="whitespace-pre-wrap">{v.areas || '—'}</span></Item></div>
            <Item label="Related task">{v.related_task_id ? (v.related_task_name ? <a className="text-sky-700 hover:underline" href={`#/timeline/${project.id}/${v.related_task_id}`} onClick={onClose}>{v.related_task_name}</a> : 'Linked') : '—'}</Item>
            <Item label="Related material line">{v.related_material_id ? (v.related_material_description ? <a className="text-sky-700 hover:underline" href={`#/materials/${project.id}/${v.related_material_id}`} onClick={onClose}>{v.related_material_description}</a> : 'Linked') : '—'}</Item>
            <Item label="Related consultant visit">{v.related_consultant_visit_id ? (v.related_consultant_visit_purpose ? <a className="text-sky-700 hover:underline" href={`#/consultant/${project.id}/${v.related_consultant_visit_id}`} onClick={onClose}>{formatDateTime(v.related_consultant_visit_at, 'No date')} · {v.related_consultant_visit_purpose}</a> : 'Linked') : '—'}</Item>
            {st === 'Cancelled' && <Item label="Cancellation reason">{v.cancel_reason || 'No reason recorded'}</Item>}
            {v.notes && <div className="sm:col-span-2"><Item label="Notes"><span className="whitespace-pre-wrap">{v.notes}</span></Item></div>}
          </dl>
        </section>

        <section aria-labelledby="sv-findings" className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h4 id="sv-findings" className="text-xs font-bold text-slate-700">Findings</h4>
            {writable && <Button size="sm" variant="ghost" onClick={onFindings}><Pencil className="w-3.5 h-3.5" />{v.findings || v.decisions ? 'Edit findings' : 'Record findings'}</Button>}
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <Item label="Observations & issues"><span className="whitespace-pre-wrap" dir="auto">{v.findings || '—'}</span></Item>
            <Item label="Decisions & instructions"><span className="whitespace-pre-wrap" dir="auto">{v.decisions || '—'}</span></Item>
          </dl>
        </section>

        <Attachments projectId={project.id} entityType="site_visit" entityId={v.id} defaultKind="site_photo" title="Photos & documents" canUpload={writable} onChange={() => void onChanged()}
          hint="Site photos, optional reports and supporting files. Uploading never completes the visit." />

        <VisitActions base={base} type="site" visitId={v.id} actions={v.actions ?? []} canEdit={writable} onChange={() => void onChanged()}
          members={manager ? members.map((m) => ({ id: m.id, name: m.name })) : undefined} />
        {st === 'Completed' && openActionsOf(v) > 0 && <p className="-mt-3 text-[11px] text-slate-500">The visit is completed; its follow-up actions stay open until each one is closed.</p>}

        <Comments base={base} type="site" visitId={v.id} canPost={writable} onPosted={onChanged} />
        <VisitHistory base={base} type="site" visitId={v.id} />
      </div>
    </Modal>
  );
}

function SiteWorkflowDialog({ base, flow, onClose, onDone }: { base: string; flow: Flow; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const { v, kind } = flow;
  const cfg = {
    start: { title: 'Start visit', submit: 'Start visit', fields: [] as FieldSpec[], initial: {}, url: 'start', msg: 'Visit started',
      note: 'Marks the visit in progress now. Record findings, photos and follow-up actions as you go.' },
    complete: {
      title: 'Mark visit completed', submit: 'Mark completed',
      fields: [{ name: 'actual_visit_at', label: 'Actual visit date & time', type: 'datetime', required: true, help: 'When the visit actually took place. It cannot be in the future.' }] as FieldSpec[],
      initial: { actual_visit_at: v.started_at || new Date().toISOString() }, url: 'complete', msg: 'Visit marked completed',
      note: `Open follow-up actions stay open. Planned time: ${formatDateTime(v.visit_at, 'not set')}.`,
    },
    reschedule: {
      title: 'Reschedule visit', submit: 'Save new date',
      fields: [{ name: 'visit_at', label: 'New date & time', type: 'datetime', required: true }, { name: 'reason', label: 'Reason (kept in the history)', type: 'textarea' }] as FieldSpec[],
      initial: { visit_at: v.visit_at }, url: 'reschedule', msg: 'Visit rescheduled', note: v.visit_at ? `Currently planned for ${formatDateTime(v.visit_at)}. The old and new times are kept in the history.` : 'The new time is kept in the history.',
    },
    cancel: {
      title: 'Cancel visit', submit: 'Cancel visit',
      fields: [{ name: 'reason', label: 'Cancellation reason', type: 'textarea', required: true }] as FieldSpec[],
      initial: {}, url: 'cancel', msg: 'Visit cancelled', note: 'The visit is kept with its photos, comments and actions. It can be reopened with Reschedule.',
    },
  }[kind];
  return (
    <Modal open title={cfg.title} subtitle={v.purpose} onClose={onClose}>
      <p className="text-xs text-slate-600 mb-3">{cfg.note}</p>
      <RecordForm mode="create" fields={cfg.fields} initial={cfg.initial} submitLabel={cfg.submit} onCancel={onClose}
        onSubmit={async (vals) => { await post(`${base}/site/${v.id}/${cfg.url}`, vals); await onDone(cfg.msg); }} />
    </Modal>
  );
}

