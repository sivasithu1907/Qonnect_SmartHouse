import React, { useState } from 'react';
import { Archive, FolderOpen, MapPin, Plus } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { ConsultantVisit, Member, Project, SiteVisit } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { SITE_VISIT_STATUSES } from '../../shared/constants';
import { Attachments } from '../components/Attachments';
import { VisitActions } from '../components/VisitActions';
import { Badge, Button, Card, EmptyState, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, StatusBadge, useUi, type FieldSpec } from '../components/ui';
import { RestoreArchived, useLinkOptions } from './ConsultantVisits';

export function SiteVisits({ project }: { project: Project }) {
  const base = `/api/projects/${project.id}/visits`;
  const { data, error, reload } = useApi<SiteVisit[]>(`${base}/site`);
  const { user, can } = useSession();
  const manager = can('site.write') && !project.archived_at;
  const assignee = can('site.assigned') && !project.archived_at;
  const { data: members } = useApi<Member[]>(manager ? `/api/projects/${project.id}/members` : null);
  const { data: cvs } = useApi<ConsultantVisit[]>(`${base}/consultant`);
  const { taskOptions, materialOptions, label } = useLinkOptions(project.id);
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<{ row: SiteVisit | null } | null>(null);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const isAssignee = (v: SiteVisit | null) => !!v && assignee && v.assigned_user_id === user.id;
  const canWrite = (v: SiteVisit | null) => manager || isAssignee(v);
  const cvOptions = (cvs ?? []).map((c) => ({ value: c.id, label: `${formatDateTime(c.planned_at, 'No date')} · ${c.purpose}` }));

  const fields = (v: SiteVisit | null): FieldSpec[] => {
    const lockAll = !manager; // assignees may only change status / findings / notes
    const f: FieldSpec[] = [
      { name: 'visit_at', label: 'Date & time', type: 'datetime' },
      { name: 'status', label: 'Status', type: 'select', options: SITE_VISIT_STATUSES.map((s) => ({ value: s, label: s })) },
      { name: 'assigned_user_id', label: 'Assigned team member (user)', type: 'select', nullable: true, options: (members ?? []).map((m) => ({ value: m.id, label: m.name })), hidden: !manager },
      { name: 'assigned_name', label: 'Assigned person (if not a user)' },
      { name: 'purpose', label: 'Purpose', required: true, wide: true },
      { name: 'areas', label: 'Areas / items to inspect', type: 'textarea' },
      { name: 'findings', label: 'Findings', type: 'textarea' },
      { name: 'related_task_id', label: 'Related timeline task', type: 'select', nullable: true, options: taskOptions },
      { name: 'related_material_id', label: 'Related material line', type: 'select', nullable: true, options: materialOptions },
      { name: 'related_consultant_visit_id', label: 'Related consultant visit', type: 'select', nullable: true, options: cvOptions, wide: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ];
    return f.map((x) => ({ ...x, disabled: v && lockAll ? !['status', 'findings', 'notes'].includes(x.name) : false }));
  };
  const current = edit?.row ? data.find((v) => v.id === edit.row!.id) ?? edit.row : null;

  return (
    <div className="space-y-6">
      <PageHeader icon={<MapPin className="w-5 h-5" />} title="Site Visits" subtitle={`${project.name} — ${project.code} · Qonnect / project team visits`}
        actions={<>
          <LinkButton href={project.site_visits_drive_url} label="Site visits Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          {manager && <Button variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-4 h-4" />Assign visit</Button>}
        </>} />
      <Card>
        {data.length === 0 ? <EmptyState>No site visits assigned.</EmptyState> : (
          <div className="divide-y divide-slate-100 -my-2">
            {data.map((v) => (
              <div key={v.id} className="py-3 flex flex-col md:flex-row md:items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{v.purpose}</span>
                    <StatusBadge status={v.status} />
                    {v.actions.some((a) => a.status === 'Open') && <Badge tone="amber">{v.actions.filter((a) => a.status === 'Open').length} open action(s)</Badge>}
                    {v.attachment_count > 0 && <Badge tone="sky">{v.attachment_count} file(s)</Badge>}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">{formatDateTime(v.visit_at, 'Date not set')} · {v.assigned_user_name || v.assigned_name || 'Unassigned'}{v.areas && ` · ${v.areas}`}</div>
                  {v.findings && <p className="text-xs text-slate-700 mt-1 line-clamp-2">{v.findings}</p>}
                  <div className="text-[11px] text-slate-400 mt-1">
                    {v.related_task_id && `Task: ${label(taskOptions, v.related_task_id)} · `}
                    {v.related_material_id && `Material: ${label(materialOptions, v.related_material_id)}`}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" onClick={() => setEdit({ row: v })}>{canWrite(v) ? 'Open / update' : 'View'}</Button>
                  {manager && <Button size="sm" variant="ghost" onClick={async () => {
                    if (!(await confirm('Archive this site visit record?', { confirmLabel: 'Archive', danger: true }))) return;
                    await post(`${base}/site/${v.id}/archive`); toast('Archived'); await reload();
                  }}><Archive className="w-3.5 h-3.5" /></Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={current ? 'Site visit' : 'Assign site visit'} subtitle={current?.purpose}>
        {edit && (
          <div className="space-y-4">
            {canWrite(current) || !current ? (
              <RecordForm key={current?.id ?? 'new'} fields={fields(current)} initial={current ?? { status: 'Planned' }} mode={current ? 'edit' : 'create'} onCancel={() => setEdit(null)}
                onSubmit={async (v) => {
                  if (current) { await patch(`${base}/site/${current.id}`, v); toast('Visit saved'); await reload(); }
                  else { const r = await post<SiteVisit>(`${base}/site`, v); toast('Visit assigned'); await reload(); setEdit({ row: { ...r, actions: [] } as SiteVisit }); }
                }} />
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div><dt className="text-slate-500">Date</dt><dd>{formatDateTime(current.visit_at)}</dd></div>
                <div><dt className="text-slate-500">Assigned</dt><dd>{current.assigned_user_name || current.assigned_name || '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-slate-500">Areas</dt><dd className="whitespace-pre-wrap">{current.areas || '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-slate-500">Findings</dt><dd className="whitespace-pre-wrap">{current.findings || '—'}</dd></div>
              </dl>
            )}
            {current && <VisitActions base={base} type="site" visitId={current.id} actions={current.actions ?? []} canEdit={canWrite(current)} onChange={reload} />}
            {current && <Attachments projectId={project.id} entityType="site_visit" entityId={current.id} defaultKind="site_photo" canUpload={canWrite(current)} onChange={reload} />}
          </div>
        )}
      </Modal>
      <RestoreArchived base={`${base}/site`} onDone={reload} canRestore={manager} />
    </div>
  );
}
