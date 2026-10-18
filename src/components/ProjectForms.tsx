import React, { useState } from 'react';
import { patch, post } from '../lib/api';
import type { Project } from '../lib/types';
import { useSession } from '../lib/session';
import { Button, Modal, Notice, RecordForm, Tabs, useUi, type FieldSpec } from './ui';
import { formatDateTime, formatQAR } from '../lib/format';

const LINK_FIELDS: FieldSpec[] = [
  { name: 'drive_folder_url', label: 'Project Google Drive folder', type: 'url', wide: true, help: 'Opened by the Drive button in the header.' },
  { name: 'sheets_url', label: 'Google Sheets (project master sheet)', type: 'url', wide: true },
  { name: 'payments_drive_url', label: 'Drive folder — Payments', type: 'url', wide: true },
  { name: 'materials_drive_url', label: 'Drive folder — Materials', type: 'url', wide: true },
  { name: 'consultant_drive_url', label: 'Drive folder — Consultant reports', type: 'url', wide: true },
  { name: 'site_visits_drive_url', label: 'Drive folder — Site visits', type: 'url', wide: true },
];

const DETAIL_FIELDS = (isNew: boolean): FieldSpec[] => [
  { name: 'code', label: 'Project code (unique)', required: true, placeholder: 'e.g. PIN 70153699', help: isNew ? 'Must be unique across all projects.' : undefined },
  { name: 'name', label: 'Project name', required: true, placeholder: 'e.g. Umm Garn' },
  { name: 'location', label: 'Location' },
  { name: 'client', label: 'Client / owner' },
  { name: 'status', label: 'Status label' },
  { name: 'planned_start_date', label: 'Planned start', type: 'date' },
  { name: 'target_completion_date', label: 'Target completion', type: 'date' },
  { name: 'description', label: 'Description', type: 'textarea' },
];

export function CreateProjectModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const [tplBudget, setTplBudget] = useState(true);
  const [tplTimeline, setTplTimeline] = useState(true);
  const { toast } = useUi();
  return (
    <Modal open={open} onClose={onClose} title="Create project" subtitle="Creates a clean workspace. Nothing is copied from other projects." wide>
      {open && (
        <RecordForm
          mode="create"
          fields={[...DETAIL_FIELDS(true), { name: 'misc_percentage', label: 'Miscellaneous allowance %', type: 'number', help: 'Defaults to 10%.' }, ...LINK_FIELDS]}
          initial={{ misc_percentage: 10, status: 'Setup' }}
          submitLabel="Create project"
          extra={
            <div className="border border-slate-200 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-700">Start from standard structure (names only — no prices, quantities, dates, suppliers or statuses)</p>
              <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={tplBudget} onChange={(e) => setTplBudget(e.target.checked)} />Budget categories & items (fixed costs + 16 finishing categories)</label>
              <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={tplTimeline} onChange={(e) => setTplTimeline(e.target.checked)} />20-phase timeline planning template with dependencies</label>
            </div>
          }
          onCancel={onClose}
          onSubmit={async (v) => {
            const p = await post<Project>('/api/projects', { ...v, misc_percentage: v.misc_percentage ?? 10, template: { budget: tplBudget, timeline: tplTimeline } });
            toast(`Created ${p.name} — ${p.code}`);
            onCreated(p);
          }}
        />
      )}
    </Modal>
  );
}

export function ProjectSettingsModal({ open, project, onClose, onSaved }: { open: boolean; project: Project | null; onClose: () => void; onSaved: (p: Project | null) => void }) {
  const { can } = useSession();
  const { toast, confirm } = useUi();
  const [tab, setTab] = useState<'links' | 'details' | 'budget' | 'progress' | 'archive'>(can('projects.manage') ? 'details' : 'links');
  if (!project) return null;
  const base = `/api/projects/${project.id}`;
  const tabs = [
    ...(can('projects.manage') ? [{ id: 'details' as const, label: 'Details' }] : []),
    { id: 'links' as const, label: 'Drive & Sheets links' },
    ...(can('projects.manage') ? [{ id: 'budget' as const, label: 'Budget settings' }, { id: 'progress' as const, label: 'Timeline progress' }, { id: 'archive' as const, label: 'Archive' }] : []),
  ];
  return (
    <Modal open={open} onClose={onClose} title="Project settings" subtitle={`${project.name} — ${project.code}`} wide>
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={tabs} /></div>
      {tab === 'details' && (
        <RecordForm key={`d-${project.id}`} fields={DETAIL_FIELDS(false)} initial={project} onCancel={onClose}
          onSubmit={async (v) => { const p = await patch<Project>(base, v); toast('Project updated'); onSaved(p); }} />
      )}
      {tab === 'links' && (
        <>
          <Notice tone="sky">These are external links only. The app does not synchronise with Google Drive — upload files here for secure in-app storage, or keep them in Drive and link the folder.</Notice>
          <div className="mt-3">
            <RecordForm key={`l-${project.id}`} fields={LINK_FIELDS} initial={project} onCancel={onClose}
              onSubmit={async (v) => { const p = await patch<Project>(`${base}/links`, v); toast('Links saved'); onSaved(p); }} />
          </div>
        </>
      )}
      {tab === 'budget' && (
        <>
          <div className="text-xs text-slate-600 mb-3 space-y-1">
            <p>Control budget: {project.control_budget === null ? <b className="text-amber-700">Needs confirmation</b> : <b>{formatQAR(project.control_budget)}</b>}
              {project.control_budget_confirmed ? ` — confirmed ${formatDateTime(project.control_budget_confirmed_at)}` : project.control_budget !== null ? ' — not confirmed' : ''}</p>
            <p>The misc allowance is calculated only on approved / finalized amounts of finishing categories. Budget comparisons are kept in the linked Google Sheet.</p>
          </div>
          <RecordForm key={`b-${project.id}`}
            fields={[
              { name: 'misc_percentage', label: 'Miscellaneous allowance %', type: 'number', required: true },
              { name: 'control_budget', label: 'Control budget (QAR)', type: 'money', help: 'Leave blank until the owner confirms it.' },
              { name: 'control_budget_confirmed', label: 'Owner has confirmed this control budget', type: 'checkbox' },
            ]}
            initial={project} onCancel={onClose}
            onSubmit={async (v) => { const p = await patch<Project>(`${base}/settings`, v); toast('Budget settings saved'); onSaved(p); }} />
        </>
      )}
      {tab === 'progress' && <HistoricalProgressSetting project={project} onSaved={onSaved} />}
      {tab === 'archive' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">Archiving hides the project from non-admin users and makes it read-only. No records are deleted, and it can be restored at any time.</p>
          {project.archived_at ? (
            <Button variant="success" onClick={async () => { const p = await post<Project>(`${base}/restore`); toast('Project restored'); onSaved(p); }}>Restore project</Button>
          ) : (
            <Button variant="danger" onClick={async () => {
              if (!(await confirm(<>Archive <b>{project.name} — {project.code}</b>? Users will lose access until it is restored.</>, { title: 'Archive project', confirmLabel: 'Archive project', danger: true }))) return;
              const p = await post<Project>(`${base}/archive`); toast('Project archived'); onSaved(p);
            }}>Archive project</Button>
          )}
        </div>
      )}
    </Modal>
  );
}

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useUi();
  return (
    <Modal open={open} onClose={onClose} title="Change password">
      {open && (
        <RecordForm mode="create"
          fields={[
            { name: 'currentPassword', label: 'Current password', type: 'password', required: true, wide: true },
            { name: 'newPassword', label: 'New password', type: 'password', required: true, wide: true, help: 'At least 12 characters with letters and numbers. Other sessions will be signed out.' },
          ]}
          onCancel={onClose}
          onSubmit={async (v) => { await post('/api/auth/change-password', v); toast('Password changed'); onClose(); }} />
      )}
    </Modal>
  );
}

/** Admin-only switch for recording work completed before the project was entered into the application. */
function HistoricalProgressSetting({ project, onSaved }: { project: Project; onSaved: (p: Project | null) => void }) {
  const [on, setOn] = useState(!!project.allow_historical_progress);
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1 rounded border-slate-300" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span><b>Allow historical progress entry</b>
          <span className="block text-xs text-slate-600">For a project that started before it was entered here. Authorised users can then mark tasks completed with “Exact completion date unknown” and complete several tasks of a phase in one reviewed step.</span>
        </span>
      </label>
      <ul className="text-xs text-slate-500 list-disc ml-5 space-y-0.5">
        <li>New projects have this off and follow the normal workflow (plan, start, record actual dates).</li>
        <li>Nothing is marked completed automatically. Turning it off later keeps everything already recorded.</li>
        <li>Completion statuses, dates and notes are never copied into other projects or templates.</li>
      </ul>
      <div className="flex justify-end">
        <Button variant="primary" busy={busy} disabled={on === !!project.allow_historical_progress} onClick={async () => {
          setBusy(true);
          try { const p = await patch<Project>(`/api/projects/${project.id}/historical-progress`, { enabled: on }); toast(on ? 'Historical progress entry allowed' : 'Historical progress entry turned off'); onSaved(p); }
          catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
        }}>Save</Button>
      </div>
    </div>
  );
}
