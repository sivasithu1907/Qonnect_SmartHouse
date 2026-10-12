import React, { useState } from 'react';
import { Plus, Star, Trash2 } from 'lucide-react';
import { patch, post } from '../../lib/api';
import type { DirectoryEntry, Specialization } from '../../lib/directory';
import { BUSINESS_ROLE_LABELS, BUSINESS_ROLES, ENTITY_TYPE_LABELS, ENTITY_TYPES } from '../../../shared/directory';
import { Button, inputCls, PhoneInput, RecordForm, type FieldSpec } from '../ui';
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
  const [people, setPeople] = useState<Person[]>([blankPerson(true)]);
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
    ...(!initial ? [{ name: '_people', label: '', type: 'custom' as const, showWhen: (v: Record<string, any>) => v.entity_type === 'company',
      render: (v: Record<string, any>) => v.entity_type === 'company' ? <InitialContacts people={people} setPeople={setPeople} /> : null }] : []),
    { name: '_dup', label: '', type: 'custom', render: (v) => <DuplicateCheck vals={v} excludeId={initial?.id} onOpen={onOpenExisting} onUse={onUseExisting} useLabel={assignProject ? `Use it and assign to ${assignProject.code}` : 'Use this entry'} /> },
  ];
  return (
    <RecordForm fields={fields} mode={initial ? 'edit' : 'create'} submitLabel={initial ? 'Save' : assignProject ? `Create and assign to ${assignProject.code}` : 'Create entry'}
      initial={initial ?? { entity_type: 'company', roles: [], specializations: [] }} onCancel={onCancel}
      extra={!initial && <p className="text-[11px] text-slate-500">Adding a company, individual or contact person never creates a login or gives anyone access to the application.</p>}
      onSubmit={async (v) => {
        const contacts = !initial && v.entity_type === 'company' ? people.filter((x) => x.name.trim()).map(({ key: _k, ...x }) => ({ ...x, name: x.name.trim() })) : [];
        if (!initial && v.entity_type === 'company' && people.some((x) => !x.name.trim() && (x.position || x.mobile || x.email || x.whatsapp || x.notes))) throw new Error('Each contact person needs a name (or remove the empty row)');
        if (contacts.length) v = { ...v, contacts };
        const saved = initial
          ? await patch<DirectoryEntry>(`/api/directory/${initial.id}`, v)
          : await post<DirectoryEntry>('/api/directory', assignProject ? { ...v, assign: { project_id: assignProject.id, roles: v.roles, scope: '' } } : v);
        await onSaved(saved);
      }} />
  );
}

interface Person { key: number; name: string; position: string; mobile: string; whatsapp: string; email: string; notes: string; is_primary: boolean }
let seq = 0;
const blankPerson = (primary = false): Person => ({ key: ++seq, name: '', position: '', mobile: '', whatsapp: '', email: '', notes: '', is_primary: primary });

/** Contact people entered together with a new company. Optional; exactly one is marked primary. */
function InitialContacts({ people, setPeople }: { people: Person[]; setPeople: React.Dispatch<React.SetStateAction<Person[]>> }) {
  const upd = (key: number, patch: Partial<Person>) => setPeople((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : patch.is_primary ? { ...p, is_primary: false } : p)));
  const remove = (key: number) => setPeople((ps) => {
    const rest = ps.filter((p) => p.key !== key);
    if (rest.length && !rest.some((p) => p.is_primary)) rest[0] = { ...rest[0], is_primary: true };
    return rest;
  });
  const lbl = 'text-[11px] font-semibold text-slate-600';
  return (
    <fieldset className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-3" data-testid="initial-contacts">
      <legend className="px-1 text-xs font-bold text-slate-700">Contact people <span className="font-normal text-slate-500">(optional)</span></legend>
      {people.map((p, i) => (
        <div key={p.key} className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Contact person {i + 1}</span>
            <span className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                <input type="radio" name="initial-primary" checked={p.is_primary} onChange={() => upd(p.key, { is_primary: true })} /><Star className="w-3 h-3 text-emerald-600" />Primary
              </label>
              {people.length > 1 && <button type="button" className="p-1 text-slate-400 hover:text-rose-600" aria-label={`Remove contact person ${i + 1}`} onClick={() => remove(p.key)}><Trash2 className="w-3.5 h-3.5" /></button>}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className={lbl}>Name<input className={`${inputCls} mt-0.5`} dir="auto" value={p.name} onChange={(e) => upd(p.key, { name: e.target.value })} maxLength={200} /></label>
            <label className={lbl}>Position / title<input className={`${inputCls} mt-0.5`} value={p.position} onChange={(e) => upd(p.key, { position: e.target.value })} maxLength={200} /></label>
            <div className={lbl}>Phone<div className="mt-0.5"><PhoneInput id={`ip-m-${p.key}`} value={p.mobile} onChange={(v: string) => upd(p.key, { mobile: v })} /></div></div>
            <div className={lbl}>WhatsApp (if different)<div className="mt-0.5"><PhoneInput id={`ip-w-${p.key}`} value={p.whatsapp} onChange={(v: string) => upd(p.key, { whatsapp: v })} /></div></div>
            <label className={lbl}>Email<input className={`${inputCls} mt-0.5`} type="email" value={p.email} onChange={(e) => upd(p.key, { email: e.target.value })} maxLength={200} /></label>
            <label className={lbl}>Notes<input className={`${inputCls} mt-0.5`} dir="auto" value={p.notes} onChange={(e) => upd(p.key, { notes: e.target.value })} maxLength={2000} /></label>
          </div>
        </div>
      ))}
      <Button size="sm" onClick={() => setPeople((ps) => [...ps, blankPerson(ps.length === 0)])}><Plus className="w-3.5 h-3.5" />Add another contact person</Button>
      <p className="text-[11px] text-slate-500">Contact people do not need user accounts. More can be added later from the company page.</p>
    </fieldset>
  );
}
