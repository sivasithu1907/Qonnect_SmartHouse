import React, { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, Link2, Paperclip, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { ApiError, patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, Member, MaterialItem, Phase, Project, Task, WorkUpdate } from '../lib/types';
import { formatDate, todayLocalISO } from '../lib/format';
import { TASK_STATUSES } from '../../shared/constants';
import { Attachments } from '../components/Attachments';
import { labelOf, materialOptions, timelineTaskOptions } from '../lib/options';
import { Badge, Button, Card, EmptyState, Modal, Notice, PageHeader, RecordForm, Spinner, StatusBadge, Tabs, useUi, type FieldSpec } from '../components/ui';
import { GanttChart } from '../components/schedule/GanttChart';
import { MaterialDateSummary } from '../components/schedule/ScheduleMarks';
import { plannedSpan } from '../lib/schedule';

type Detail = { kind: 'task'; row: Task } | { kind: 'phase'; row: Phase } | { kind: 'materials'; rows: MaterialItem[] };
type Edit = { kind: 'task'; row: Task | null; phaseId?: string } | { kind: 'phase'; row: Phase | null } | { kind: 'update'; row: WorkUpdate | null };

export function Timeline({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/timeline`;
  const { data, error, reload } = useApi<{ phases: Phase[]; tasks: Task[] }>(base);
  const { data: updates, reload: reloadUpdates } = useApi<WorkUpdate[]>(`/api/projects/${project.id}/work-updates`);
  const { data: mats } = useApi<{ items: MaterialItem[] }>(`/api/projects/${project.id}/materials`);
  const { user, can } = useSession();
  const { toast, confirm } = useUi();
  const writable = can('timeline.write') && !project.archived_at;
  const { data: members } = useApi<Member[]>(writable ? `/api/projects/${project.id}/members` : null);
  const canPost = can('workupdates.write') && !project.archived_at;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useFocusRecord(focusId, data?.tasks, (t) => t.id, (t) => setOpen((o) => ({ ...o, [t.phase_id]: true })), onFocusHandled);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'gantt'>('list');
  const [detail, setDetail] = useState<Detail | null>(null);

  const taskById = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const anyApproved = data.phases.some((p) => p.schedule_approved);
  const phaseOf = (t: Task) => data.phases.find((p) => p.id === t.phase_id);
  const taskOptions = timelineTaskOptions(data.phases, data.tasks);
  // Gantt clicks: editors get the existing edit form; everyone else a read-only summary.
  const openTask = (t: Task) => (writable ? setEdit({ kind: 'task', row: t }) : setDetail({ kind: 'task', row: t }));
  const openPhase = (p: Phase) => (writable ? setEdit({ kind: 'phase', row: p }) : setDetail({ kind: 'phase', row: p }));
  const goToMaterial = (m: MaterialItem) => { setDetail(null); window.location.hash = `#/materials/${project.id}/${m.id}`; };
  const openMaterials = (rows: MaterialItem[]) => setDetail({ kind: 'materials', rows });

  const taskFields = (row: Task | null): FieldSpec[] => [
    { name: 'phase_id', label: 'Phase', type: 'select', required: true, options: data.phases.map((p) => ({ value: p.id, label: `${p.seq}. ${p.name}` })), wide: true },
    { name: 'name', label: 'Task', required: true, wide: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'is_hold_point', label: 'Inspection / hold point (must pass before follow-on work)', type: 'checkbox', wide: true },
    { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES.filter((s) => row || s !== 'Completed').map((s) => ({ value: s, label: s })) },
    { name: 'responsible', label: 'Responsible (name / company)' },
    { name: 'assigned_user_id', label: 'Assigned user (receives task notifications)', type: 'select', nullable: true, options: (members ?? []).map((m) => ({ value: m.id, label: m.name })) },
    { name: 'planned_start', label: 'Planned start', type: 'date' },
    { name: 'planned_end', label: 'Planned finish', type: 'date' },
    { name: 'actual_start', label: 'Actual start', type: 'date' },
    { name: 'actual_end', label: 'Actual completion', type: 'date', help: 'Required to mark the task completed.' },
    { name: 'depends_on', label: 'Depends on (predecessors) — hold Ctrl/Cmd to select several', type: 'multiselect', options: timelineTaskOptions(data.phases, data.tasks, { excludeId: row?.id }) },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const saveTask = async (row: Task | null, v: Record<string, unknown>, override = false): Promise<void> => {
    try {
      if (row) await patch(`${base}/tasks/${row.id}`, override ? { ...v, override_dependencies: true } : v);
      else await post(`${base}/tasks`, v);
    } catch (e) {
      if (e instanceof ApiError && e.details?.code === 'DEPENDENCIES_OPEN' && !override) {
        const ok = await confirm(<><p>Predecessor tasks are not completed:</p><ul className="list-disc ml-5 my-2">{(e.details.open as string[]).map((n) => <li key={n}>{n}</li>)}</ul><p>Record completion anyway? The override is recorded in the audit history.</p></>, { title: 'Dependencies not complete', confirmLabel: 'Override and complete', danger: true });
        if (ok) return saveTask(row, v, true);
        throw new Error('Not saved — predecessors are still open.');
      }
      throw e;
    }
    toast('Task saved');
    setEdit(null);
    await reload();
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={<CalendarDays className="w-5 h-5" />} title="Project Timeline" subtitle={`${project.name} — ${project.code} · setup to handover`}
        actions={writable && <Button onClick={() => setEdit({ kind: 'phase', row: null })}><Plus className="w-4 h-4" />Phase</Button>} />

      <Tabs value={view} onChange={setView} tabs={[{ id: 'list', label: 'List' }, { id: 'gantt', label: 'Gantt' }]} />

      {!anyApproved && (
        <Notice title="Planning template — not a confirmed construction schedule.">
          Phase names and dependencies are a standard sequence. Dates, responsibilities and statuses stay blank / Not Scheduled until an authorised user enters them. The consultant and contractor should adjust this template to the approved drawings and actual site conditions.
        </Notice>
      )}

      {view === 'gantt' && (
        <Card>
          <GanttChart phases={data.phases} tasks={data.tasks} materials={mats?.items ?? []} today={todayLocalISO()}
            onOpenPhase={openPhase} onOpenTask={openTask} onOpenMaterials={openMaterials} />
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-4 gap-6">
        {view === 'list' && <div className="xl:col-span-2 2xl:col-span-3 space-y-3">
          {data.phases.length === 0 && <EmptyState>No phases yet.</EmptyState>}
          {data.phases.map((p) => {
            const tasks = data.tasks.filter((t) => t.phase_id === p.id);
            const done = tasks.filter((t) => t.status === 'Completed').length;
            const isOpen = open[p.id];
            return (
              <div key={p.id} className="bg-white border border-slate-200 rounded-xl shadow-2xs">
                <div className="flex items-start justify-between gap-2 p-3">
                  <button className="flex items-start gap-2 text-left min-w-0" onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                    {isOpen ? <ChevronDown className="w-4 h-4 mt-0.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 text-slate-500 shrink-0" />}
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900"><span className="font-mono text-sky-700 mr-1">{p.seq}.</span>{p.name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-2">
                        <span>{done}/{tasks.length} tasks completed</span>
                        <span>{p.planned_start || p.planned_end ? `${formatDate(p.planned_start)} → ${formatDate(p.planned_end)}` : 'Not scheduled'}</span>
                        {p.schedule_approved ? <Badge tone="emerald">Schedule approved</Badge> : <Badge>Template</Badge>}
                      </div>
                    </div>
                  </button>
                  {writable && <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'task', row: null, phaseId: p.id })}><Plus className="w-3.5 h-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'phase', row: p })}><Pencil className="w-3.5 h-3.5" /></Button>
                  </div>}
                </div>
                {isOpen && (
                  <div className="border-t border-slate-100 px-3 pb-3">
                    {p.description && <p className="text-[11px] text-slate-500 py-2">{p.description}</p>}
                    {tasks.length === 0 ? <p className="text-xs text-slate-500 py-2">No tasks.</p> : (
                      <ul className="divide-y divide-slate-100">
                        {tasks.map((t) => {
                          const waiting = t.depends_on.map((id) => taskById.get(id)).filter((d) => d && d.status !== 'Completed') as Task[];
                          return (
                            <li key={t.id} id={`rec-${t.id}`} className="py-2 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                  <span className="font-semibold text-slate-800">{t.name}</span>
                                  {t.is_hold_point && <Badge tone="violet"><ShieldCheck className="w-3 h-3" />Hold point</Badge>}
                                  <StatusBadge status={t.status} />
                                </div>
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  {t.planned_start || t.planned_end ? `Planned ${formatDate(t.planned_start)} → ${formatDate(t.planned_end)}` : 'No planned dates'}
                                  {t.actual_end && ` · Completed ${formatDate(t.actual_end)}`}
                                  {t.responsible && ` · ${t.responsible}`}
                                  {t.assigned_user_name && ` · Assigned: ${t.assigned_user_name}`}
                                </div>
                                {t.depends_on.length > 0 && (
                                  <div className="text-[11px] mt-0.5 flex items-start gap-1 text-slate-500">
                                    <Link2 className="w-3 h-3 mt-0.5 shrink-0" />
                                    <span>After: {t.depends_on.map((id) => taskById.get(id)?.name).filter(Boolean).join('; ')}
                                      {waiting.length > 0 && t.status !== 'Completed' && <span className="text-amber-700"> — waiting on {waiting.length}</span>}</span>
                                  </div>
                                )}
                              </div>
                              {writable && <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'task', row: t })}><Pencil className="w-3.5 h-3.5" /></Button>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>}

        <Card className={view === 'gantt' ? 'xl:col-span-3 2xl:col-span-4' : ''} title="Contractor work updates" subtitle="Progress notes with supporting photos/documents"
          actions={canPost && <Button size="sm" variant="primary" onClick={() => setEdit({ kind: 'update', row: null })}><Plus className="w-3.5 h-3.5" />Update</Button>}>
          {!updates ? <Spinner /> : updates.length === 0 ? <EmptyState /> : (
            <ul className={view === 'gantt' ? 'grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3' : 'space-y-3'}>
              {updates.map((u) => (
                <li key={u.id} className="border border-slate-200 rounded-lg p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-900">{u.title}</div>
                      <div className="text-[11px] text-slate-500">{formatDate(u.update_date)} · {u.author_name ?? '—'}{u.related_task_id && ` · ${labelOf(taskOptions, u.related_task_id)}`}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setFilesFor(filesFor === u.id ? null : u.id)}><Paperclip className="w-3.5 h-3.5" />{u.attachment_count}</Button>
                      {(writable || (canPost && u.author_id === user.id)) && <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'update', row: u })}><Pencil className="w-3.5 h-3.5" /></Button>}
                    </div>
                  </div>
                  {u.description && <p className="text-xs text-slate-700 mt-1 whitespace-pre-wrap">{u.description}</p>}
                  {filesFor === u.id && <div className="mt-2"><Attachments projectId={project.id} entityType="work_update" entityId={u.id} defaultKind="site_photo" canUpload={writable || (canPost && u.author_id === user.id)} onChange={reloadUpdates} /></div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide={edit?.kind === 'task'}
        title={edit?.kind === 'task' ? (edit.row ? 'Edit task' : 'Add task') : edit?.kind === 'phase' ? (edit.row ? 'Edit phase' : 'Add phase') : edit?.row ? 'Edit work update' : 'Post work update'}>
        {edit?.kind === 'task' && (
          <RecordForm fields={taskFields(edit.row)} initial={edit.row ?? { phase_id: edit.phaseId, status: 'Not Scheduled', depends_on: [] }} mode={edit.row ? 'edit' : 'create'}
            onCancel={() => setEdit(null)} onSubmit={(v) => saveTask(edit.row, v)} />
        )}
        {edit?.kind === 'phase' && (
          <RecordForm initial={edit.row} mode={edit.row ? 'edit' : 'create'}
            fields={[
              { name: 'name', label: 'Phase name', required: true, wide: true },
              { name: 'description', label: 'Description', type: 'textarea' },
              { name: 'planned_start', label: 'Planned start', type: 'date' },
              { name: 'planned_end', label: 'Planned finish', type: 'date' },
              { name: 'actual_start', label: 'Actual start', type: 'date' },
              { name: 'actual_end', label: 'Actual finish', type: 'date' },
              { name: 'schedule_approved', label: 'Dates and sequencing for this phase are approved', type: 'checkbox', wide: true },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onCancel={() => setEdit(null)}
            onSubmit={async (v) => {
              if (edit.row) await patch(`${base}/phases/${edit.row.id}`, v); else await post(`${base}/phases`, v);
              toast('Phase saved'); setEdit(null); await reload();
            }} />
        )}
        {edit?.kind === 'update' && (
          <RecordForm initial={edit.row ?? { update_date: todayLocalISO() }} mode={edit.row ? 'edit' : 'create'}
            fields={[
              { name: 'update_date', label: 'Date', type: 'date', required: true },
              { name: 'title', label: 'Title', required: true },
              { name: 'description', label: 'Details', type: 'textarea' },
              { name: 'related_task_id', label: 'Related timeline task', type: 'searchselect', nullable: true, options: taskOptions, wide: true, help: 'Ordered by timeline sequence (phase.task). Type to search by task or phase.' },
              { name: 'related_material_id', label: 'Related material line', type: 'searchselect', nullable: true, options: materialOptions(mats?.items ?? []), wide: true },
            ]}
            onCancel={() => setEdit(null)}
            onSubmit={async (v) => {
              const url = `/api/projects/${project.id}/work-updates`;
              if (edit.row) await patch(`${url}/${edit.row.id}`, v); else await post(url, v);
              toast('Work update saved'); setEdit(null); await reloadUpdates();
            }} />
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)}
        title={detail?.kind === 'task' ? detail.row.name : detail?.kind === 'phase' ? `${detail.row.seq}. ${detail.row.name}` : 'Material deliveries'}
        subtitle={detail?.kind === 'materials' ? 'Open a line in Material Supply to see or update it.' : 'Read-only'}>
        {detail?.kind === 'task' && <TaskDetail t={detail.row} phase={phaseOf(detail.row)} taskById={taskById} />}
        {detail?.kind === 'phase' && <PhaseDetail p={detail.row} tasks={data.tasks.filter((t) => t.phase_id === detail.row.id)} />}
        {detail?.kind === 'materials' && (
          <ul className="divide-y divide-slate-100">
            {detail.rows.map((m) => (
              <li key={m.id} className="py-2 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="text-xs font-semibold text-slate-900">{m.description}</div><div className="text-[11px] text-slate-500">{m.category} · {m.status}</div></div>
                  <Button size="sm" onClick={() => goToMaterial(m)}>Open in Material Supply</Button>
                </div>
                <MaterialDateSummary m={m} />
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="text-xs"><span className="text-slate-500">{label}: </span><span className="text-slate-800">{children}</span></div>;
}

function TaskDetail({ t, phase, taskById }: { t: Task; phase?: Phase; taskById: Map<string, Task> }) {
  const span = plannedSpan(t);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={t.status} />{t.is_hold_point && <Badge tone="violet"><ShieldCheck className="w-3 h-3" />Hold point</Badge>}</div>
      {phase && <Field label="Phase">{phase.seq}. {phase.name}</Field>}
      <Field label="Planned">{formatDate(t.planned_start)} → {formatDate(t.planned_end)}{span.kind === 'range' && ` (${span.days} day${span.days === 1 ? '' : 's'})`}</Field>
      <Field label="Actual">{formatDate(t.actual_start)} → {formatDate(t.actual_end)}</Field>
      <Field label="Assigned user">{t.assigned_user_name ?? '—'}</Field>
      <Field label="Responsible">{t.responsible || '—'}</Field>
      {t.depends_on.length > 0 && <Field label="After">{t.depends_on.map((id) => taskById.get(id)?.name ?? '—').join('; ')}</Field>}
      {t.description && <p className="text-xs text-slate-600 whitespace-pre-wrap">{t.description}</p>}
      {t.notes && <p className="text-xs text-slate-600 whitespace-pre-wrap">{t.notes}</p>}
    </div>
  );
}

function PhaseDetail({ p, tasks }: { p: Phase; tasks: Task[] }) {
  return (
    <div className="space-y-2">
      <div>{p.schedule_approved ? <Badge tone="emerald">Schedule approved</Badge> : <Badge>Template</Badge>}</div>
      <Field label="Planned">{formatDate(p.planned_start)} → {formatDate(p.planned_end)}</Field>
      <Field label="Actual">{formatDate(p.actual_start)} → {formatDate(p.actual_end)}</Field>
      <Field label="Tasks completed">{tasks.filter((t) => t.status === 'Completed').length}/{tasks.length}</Field>
      {p.description && <p className="text-xs text-slate-600 whitespace-pre-wrap">{p.description}</p>}
    </div>
  );
}
