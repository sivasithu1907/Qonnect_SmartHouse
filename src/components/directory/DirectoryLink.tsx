import React, { useRef, useState } from 'react';
import { BookUser, Plus } from 'lucide-react';
import { post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import type { Project } from '../../lib/types';
import { contactOptions, entryOptions, rolesText, type DirectoryListResponse, type ProjectDirectoryEntry, type Specialization } from '../../lib/directory';
import { BUSINESS_ROLE_LABELS, BUSINESS_ROLES, type BusinessRole } from '../../../shared/directory';
import { Badge, Button, Modal, Notice, RecordForm, Spinner, useUi, type FieldSpec } from '../ui';
import { EntryForm } from './EntryForm';

type Setter = (k: string, v: any) => void;
interface LinkedRow { directory_entry_id?: string | null; directory_contact_id?: string | null; directory_entry_name?: string | null; directory_entry_archived_at?: string | null; directory_contact_name?: string | null }

/**
 * Optional directory link on a project record form (contract, payment milestone, material line, visit,
 * timeline task). Offers active entries assigned to the project; authorized users can assign an existing
 * entry or create a new one in a dialog on top, so the unsaved record form is kept.
 */
export function useDirectoryLink(project: Project) {
  const { can } = useSession();
  const enabled = can('directory.read');
  const { data, reload } = useApi<ProjectDirectoryEntry[]>(enabled ? `/api/projects/${project.id}/directory` : null);
  const canQuickAdd = can('directory.create') && !project.archived_at;
  const [quick, setQuick] = useState(false);
  const setter = useRef<Setter | null>(null);
  const list = data ?? [];

  /** Fields to add to a RecordForm. `row` is the record being edited (for the archived-link fallback label). */
  const fields = (row: LinkedRow | null | undefined, opts: { label?: string; help?: string } = {}): FieldSpec[] => {
    if (!enabled) return [];
    const archivedSuffix = row?.directory_entry_archived_at ? ' (archived)' : '';
    return [
      { name: 'directory_entry_id', label: opts.label ?? 'Directory company / individual', type: 'searchselect', nullable: true, options: entryOptions(list),
        noneLabel: 'Not linked', noMatchLabel: 'No matching entries on this project', searchPlaceholder: 'Search name, reference or role…',
        fallbackLabel: row?.directory_entry_name ? `${row.directory_entry_name}${archivedSuffix}` : undefined,
        help: opts.help ?? 'Optional. Lists entries assigned to this project in Contacts. The name typed above is kept as recorded.' },
      { name: 'directory_contact_id', label: 'Contact person', type: 'searchselect', nullable: true, dependsOn: 'directory_entry_id',
        optionsFn: (v) => contactOptions(list, v.directory_entry_id), noneLabel: 'Not set', noMatchLabel: 'No contact people for this entry',
        fallbackLabel: row?.directory_contact_name ?? undefined, showWhen: (v) => !!v.directory_entry_id },
      ...(canQuickAdd ? [{
        name: '_dir_quick', label: '', type: 'custom' as const,
        render: (_v: Record<string, any>, set: Setter) => (
          <button type="button" className="-mt-1 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:text-sky-900"
            onClick={() => { setter.current = set; setQuick(true); }}>
            <Plus className="w-3.5 h-3.5" />Not listed? Assign an existing entry or add a new one…
          </button>
        ),
      }] : []),
    ];
  };

  const dialog = canQuickAdd ? (
    <QuickAddEntry project={project} open={quick} assignedIds={list.map((e) => e.id)} onClose={() => setQuick(false)}
      onDone={async (id) => { setQuick(false); await reload(); setter.current?.('directory_entry_id', id); }} />
  ) : null;

  return { enabled, list, fields, dialog, reload };
}

/** A small "Linked: …" line for record lists and details; renders nothing when not linked. */
export function DirectoryLinkBadge({ row, className = '' }: { row: LinkedRow; className?: string }) {
  if (!row.directory_entry_name) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 text-[11px] text-slate-600 ${className}`} title="Linked directory entry">
      <BookUser className="w-3 h-3 text-sky-600" aria-hidden="true" />
      <span className="sr-only">Linked directory entry:</span>
      <span className="font-semibold text-slate-700">{row.directory_entry_name}</span>
      {row.directory_contact_name && <span>· {row.directory_contact_name}</span>}
      {row.directory_entry_archived_at && <Badge tone="rose">Archived</Badge>}
    </span>
  );
}

/** Assign an existing visible entry to the project, or create a new one assigned to it. */
export function QuickAddEntry({ project, open, assignedIds, onClose, onDone }: {
  project: Project; open: boolean; assignedIds: string[]; onClose: () => void; onDone: (id: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<'assign' | 'create'>('assign');
  const [preselect, setPreselect] = useState<string | null>(null);
  const { data: dir } = useApi<DirectoryListResponse>(open ? '/api/directory?status=active' : null);
  const { data: specs } = useApi<Specialization[]>(open ? '/api/directory/specializations' : null);
  const { toast } = useUi();
  const close = () => { setMode('assign'); setPreselect(null); onClose(); };
  const available = (dir?.entries ?? []).filter((e) => !assignedIds.includes(e.id) && !e.assignments.some((a) => a.project_id === project.id && !a.archived_at));

  const assignFields: FieldSpec[] = [
    { name: 'entry_id', label: 'Company / individual', type: 'searchselect', required: true, searchPlaceholder: 'Search name or reference…', noMatchLabel: 'No matching entries — add a new one instead',
      options: available.map((e) => ({ value: e.id, label: e.display_name, hint: rolesText(e.roles), group: e.entity_type === 'individual' ? 'Individuals' : 'Companies', keywords: `${e.ref} ${e.email} ${e.specializations.join(' ')}` })) },
    { name: 'roles', label: `Role(s) on ${project.code}`, type: 'checklist', required: true, options: BUSINESS_ROLES.map((r) => ({ value: r, label: BUSINESS_ROLE_LABELS[r] })) },
    { name: 'scope', label: 'Scope on this project', type: 'textarea' },
  ];

  return (
    <Modal portal open={open} onClose={close} wide={mode === 'create'} title={`Contacts — ${project.code}`}
      subtitle="Your record form stays open underneath; nothing in it is lost.">
      <div className="flex gap-1 mb-3" role="tablist" aria-label="Assign or add">
        {(['assign', 'create'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${mode === m ? 'bg-sky-50 border-sky-300 text-sky-800 font-semibold' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
            {m === 'assign' ? 'Assign an existing entry' : 'Add a new company / individual'}
          </button>
        ))}
      </div>
      {!dir || !specs ? <Spinner /> : mode === 'assign' ? (
        available.length === 0 && !preselect ? (
          <Notice tone="sky">There are no other active entries you can assign. <Button size="sm" className="ml-2" onClick={() => setMode('create')}>Add a new one</Button></Notice>
        ) : (
          <RecordForm key={preselect ?? 'none'} mode="create" submitLabel={`Assign to ${project.code}`} onCancel={close}
            initial={{ entry_id: preselect ?? '', roles: (available.find((e) => e.id === preselect)?.roles ?? []).slice(0, 1) as BusinessRole[] }}
            fields={assignFields}
            extra={<p className="text-[11px] text-slate-500">Assigning does not give anyone access and does not change any contract, budget or payment.</p>}
            onSubmit={async (v) => {
              await post(`/api/directory/${v.entry_id}/assignments`, { project_id: project.id, roles: v.roles, scope: v.scope ?? '' });
              toast(`Assigned to ${project.code}`);
              await onDone(String(v.entry_id));
              setPreselect(null);
            }} />
        )
      ) : (
        <EntryForm initial={null} specializations={specs} assignProject={{ id: project.id, code: project.code }} onCancel={close}
          onUseExisting={(id) => {
            const already = assignedIds.includes(id) || (dir.entries.find((e) => e.id === id)?.assignments ?? []).some((a) => a.project_id === project.id && !a.archived_at);
            if (already) void onDone(id); else { setPreselect(id); setMode('assign'); }
          }}
          onSaved={async (e) => { toast(`Added ${e.display_name} and assigned to ${project.code}`); await onDone(e.id); setMode('assign'); }} />
      )}
    </Modal>
  );
}
