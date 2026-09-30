import React, { useState } from 'react';
import { Archive, FolderOpen, Plus, RotateCcw, UserCheck } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, ConsultantVisit, MaterialItem, Member, Phase, Project, Task } from '../lib/types';
import { formatDate, formatDateTime } from '../lib/format';
import { CONSULTANT_VISIT_STATUSES } from '../../shared/constants';
import { Attachments } from '../components/Attachments';
import { VisitActions } from '../components/VisitActions';
import { Badge, Button, Card, EmptyState, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, StatusBadge, useUi, type FieldSpec, type Option } from '../components/ui';
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

export function ConsultantVisits({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/visits`;
  const { data, error, reload } = useApi<ConsultantVisit[]>(`${base}/consultant`);
  const { user, can } = useSession();
  const manager = can('consultant.write') && !project.archived_at;
  const own = can('consultant.own') && !project.archived_at;
  const { data: members } = useApi<Member[]>(manager ? `/api/projects/${project.id}/members` : null);
  const { taskOptions, materialOptions, label } = useLinkOptions(project.id);
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<{ row: ConsultantVisit | null } | null>(null);
  useFocusRecord(focusId, data, (v) => v.id, (v) => setEdit({ row: v }), onFocusHandled);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const canWrite = (v: ConsultantVisit | null) => manager || (own && (!v || v.consultant_user_id === user.id));

  const fields: FieldSpec[] = [
    { name: 'planned_at', label: 'Planned date & time', type: 'datetime' },
    { name: 'status', label: 'Visit status', type: 'select', options: CONSULTANT_VISIT_STATUSES.map((s) => ({ value: s, label: s })) },
    { name: 'consultant_name', label: 'Consultant name / company' },
    { name: 'consultant_user_id', label: 'Consultant user (can edit this visit)', type: 'select', nullable: true, hidden: !manager, options: (members ?? []).filter((m) => m.role === 'consultant').map((m) => ({ value: m.id, label: m.name })) },
    { name: 'purpose', label: 'Purpose', required: true, wide: true },
    { name: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
    { name: 'observations', label: 'Observations / findings', type: 'textarea' },
    { name: 'instructions', label: 'Instructions issued', type: 'textarea' },
    { name: 'next_visit_date', label: 'Next visit', type: 'date' },
    { name: 'related_task_id', label: 'Related timeline task', type: 'searchselect', nullable: true, options: taskOptions, wide: true, help: 'Ordered by timeline sequence (phase.task). Type to search by task or phase.' },
    { name: 'related_material_id', label: 'Related material line', type: 'searchselect', nullable: true, options: materialOptions, wide: true },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const act = async (url: string, msg: string, q?: React.ReactNode) => {
    if (q && !(await confirm(q, { confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const current = edit?.row ? data.find((v) => v.id === edit.row!.id) ?? edit.row : null;

  return (
    <div className="space-y-6">
      <PageHeader icon={<UserCheck className="w-5 h-5" />} title="Consultant Visits" subtitle={`${project.name} — ${project.code}`}
        actions={<>
          <LinkButton href={project.consultant_drive_url} label="Consultant reports Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          {(manager || own) && <Button variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-4 h-4" />Plan visit</Button>}
        </>} />
      <Notice tone="sky">Consultant fees and payments are tracked in the central Payments register (payee type “Consultant”), not here.</Notice>
      <Card>
        {data.length === 0 ? <EmptyState>No consultant visits recorded.</EmptyState> : (
          <div className="divide-y divide-slate-100 -my-2">
            {data.map((v) => {
              const openActions = v.actions.filter((a) => a.status === 'Open').length;
              return (
                <div key={v.id} id={`rec-${v.id}`} className="py-3 flex flex-col md:flex-row md:items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{v.purpose}</span>
                      <StatusBadge status={v.status} />
                      {openActions > 0 && <Badge tone="amber">{openActions} open action(s)</Badge>}
                      {v.attachment_count > 0 && <Badge tone="sky">{v.attachment_count} file(s)</Badge>}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{formatDateTime(v.planned_at, 'Date not set')} · {v.consultant_name || v.consultant_user_name || 'Consultant not set'}{v.areas_inspected && ` · ${v.areas_inspected}`}</div>
                    {v.observations && <p className="text-xs text-slate-700 mt-1 line-clamp-2">{v.observations}</p>}
                    <div className="text-[11px] text-slate-400 mt-1">
                      {v.next_visit_date && `Next visit ${formatDate(v.next_visit_date)} · `}
                      {v.related_task_id && `Task: ${label(taskOptions, v.related_task_id)} · `}
                      {v.related_material_id && `Material: ${label(materialOptions, v.related_material_id)}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" onClick={() => setEdit({ row: v })}>{canWrite(v) ? 'Open / report' : 'View'}</Button>
                    {canWrite(v) && <Button size="sm" variant="ghost" onClick={() => act(`${base}/consultant/${v.id}/archive`, 'Archived', <>Archive this visit record?</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={current ? 'Consultant visit' : 'Plan consultant visit'} subtitle={current?.purpose}>
        {edit && (
          <div className="space-y-4">
            {canWrite(current) ? (
              <RecordForm key={current?.id ?? 'new'} fields={fields} initial={current ?? { status: 'Planned' }} mode={current ? 'edit' : 'create'} onCancel={() => setEdit(null)}
                onSubmit={async (v) => {
                  if (current) { await patch(`${base}/consultant/${current.id}`, v); toast('Visit saved'); await reload(); }
                  else { const r = await post<ConsultantVisit>(`${base}/consultant`, v); toast('Visit planned — you can now add actions and upload the report'); await reload(); setEdit({ row: { ...r, actions: [] } as ConsultantVisit }); }
                }} />
            ) : current && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {fields.filter((f) => !f.hidden).map((f) => <div key={f.name}><dt className="text-slate-500">{f.label}</dt><dd className="text-slate-800 whitespace-pre-wrap">{
                  f.type === 'datetime' ? formatDateTime((current as any)[f.name]) : f.type === 'date' ? formatDate((current as any)[f.name]) : f.type === 'select' && f.options ? (label(f.options, (current as any)[f.name]) || (current as any)[f.name] || '—') : ((current as any)[f.name] || '—')}</dd></div>)}
              </dl>
            )}
            {current && <VisitActions base={base} type="consultant" visitId={current.id} actions={current.actions ?? []} canEdit={canWrite(current)} onChange={reload} />}
            {current && <Attachments projectId={project.id} entityType="consultant_visit" entityId={current.id} defaultKind="consultant_report" canUpload={canWrite(current)} onChange={reload} />}
          </div>
        )}
      </Modal>
      <RestoreArchived base={`${base}/consultant`} onDone={reload} canRestore={manager} />
    </div>
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
