import React from 'react';
import { patch, post } from '../../lib/api';
import type { DirectoryEntry, Specialization } from '../../lib/directory';
import { BUSINESS_ROLE_LABELS, BUSINESS_ROLES, ENTITY_TYPE_LABELS, ENTITY_TYPES } from '../../../shared/directory';
import { RecordForm, type FieldSpec } from '../ui';
import { DuplicateCheck } from './DuplicateCheck';

/**
 * Create / edit a company or independent individual. Only the name, type and at least one role are
 * required. While typing, likely duplicates are shown for review (never merged or blocked).
 */
export function EntryForm({ initial, specializations, assignProject, onSaved, onCancel, onOpenExisting, onUseExisting }: {
  initial: DirectoryEntry | null; specializations: Specialization[];
  /** create-and-assign in one step (from a project record form) */
  assignProject?: { id: string; code: string } | null;
  onSaved: (entry: DirectoryEntry) => void | Promise<void>; onCancel: () => void;
  onOpenExisting?: (id: string) => void; onUseExisting?: (id: string) => void;
}) {
  const specs = specializations.filter((s) => !s.archived_at || initial?.specializations.includes(s.name));
  const fields: FieldSpec[] = [
    { name: 'display_name', label: 'Display name', required: true, wide: true, placeholder: 'e.g. Gulf Gypsum Contracting WLL or Eng. Samir Haddad' },
    { name: 'entity_type', label: 'Entity type', type: 'select', required: true, options: ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_TYPE_LABELS[t] })) },
    { name: 'registration_no', label: 'Registration / reference no.', placeholder: 'e.g. CR number' },
    { name: 'roles', label: 'Business roles', type: 'checklist', required: true, options: BUSINESS_ROLES.map((r) => ({ value: r, label: BUSINESS_ROLE_LABELS[r] })), help: 'Choose all that apply.' },
    { name: 'specializations', label: 'Specializations', type: 'checklist', options: specs.map((s) => ({ value: s.name, label: s.name })) },
    { name: 'phone', label: 'General phone', type: 'phone' },
    { name: 'email', label: 'Email', placeholder: 'name@company.qa' },
    { name: 'website', label: 'Website', type: 'url' },
    { name: 'address', label: 'Address' },
    { name: 'drive_url', label: 'Drive folder link', type: 'url' },
    { name: 'quotations_url', label: 'Quotations folder link', type: 'url' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
    { name: '_dup', label: '', type: 'custom', render: (v) => <DuplicateCheck vals={v} excludeId={initial?.id} onOpen={onOpenExisting} onUse={onUseExisting} useLabel={assignProject ? `Use it and assign to ${assignProject.code}` : 'Use this entry'} /> },
  ];
  return (
    <RecordForm fields={fields} mode={initial ? 'edit' : 'create'} submitLabel={initial ? 'Save' : assignProject ? `Create and assign to ${assignProject.code}` : 'Create entry'}
      initial={initial ?? { entity_type: 'company', roles: [], specializations: [] }} onCancel={onCancel}
      extra={!initial && <p className="text-[11px] text-slate-500">Adding a company, individual or contact person never creates a login or gives anyone access to the application.</p>}
      onSubmit={async (v) => {
        const saved = initial
          ? await patch<DirectoryEntry>(`/api/directory/${initial.id}`, v)
          : await post<DirectoryEntry>('/api/directory', assignProject ? { ...v, assign: { project_id: assignProject.id, roles: v.roles, scope: '' } } : v);
        await onSaved(saved);
      }} />
  );
}
