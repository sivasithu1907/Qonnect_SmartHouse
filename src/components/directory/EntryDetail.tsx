import React, { useState } from 'react';
import { Archive, Building2, ExternalLink, Link2, Pencil, Plus, RotateCcw, Star, User } from 'lucide-react';
import { patch, post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { formatDate, formatDateTime, formatQAR } from '../../lib/format';
import { rolesText, type DirectoryContact, type DirectoryDetail, type DirectoryAssignment, type Specialization } from '../../lib/directory';
import { BUSINESS_ROLE_LABELS, BUSINESS_ROLES, ENTITY_TYPE_LABELS, formatPhone } from '../../../shared/directory';
import { Badge, Button, EmptyState, Modal, Notice, RecordForm, Spinner, StatusBadge, Tabs, useUi } from '../ui';
import { ContactActions } from './ContactActions';
import { DirectoryDocuments } from './DirectoryDocuments';
import { EntryForm } from './EntryForm';

type Tab = 'overview' | 'contacts' | 'assignments' | 'documents' | 'related';
type SubForm = { kind: 'edit' } | { kind: 'contact'; row: DirectoryContact | null } | { kind: 'assign'; row: DirectoryAssignment | null };

const RELATED: Array<{ key: keyof DirectoryDetail['related']; label: string; section: string; title: (r: Record<string, any>) => string; meta: (r: Record<string, any>) => string }> = [
  { key: 'contract', label: 'Contracts', section: 'contracts', title: (r) => r.title, meta: (r) => [`Recorded company: ${r.company_name}`, r.status, r.contract_value !== undefined && r.contract_value !== null ? `Value ${formatQAR(r.contract_value)}` : ''].filter(Boolean).join(' · ') },
  { key: 'payment_milestone', label: 'Payment milestones & recorded payments', section: 'payments', title: (r) => r.description, meta: (r) => `Recorded payee: ${r.payee_name} · scheduled ${formatQAR(r.scheduled_amount)} · paid ${formatQAR(r.paid)} (${r.transfer_count} transfer${r.transfer_count === 1 ? '' : 's'})${r.due_date ? ` · due ${formatDate(r.due_date)}` : ''}` },
  { key: 'material', label: 'Material lines', section: 'materials', title: (r) => r.description, meta: (r) => [r.category, r.status, r.vendor ? `Recorded vendor: ${r.vendor}` : ''].filter(Boolean).join(' · ') },
  { key: 'consultant_visit', label: 'Consultant visits', section: 'consultant', title: (r) => r.purpose, meta: (r) => [r.status, r.planned_at ? formatDateTime(r.planned_at) : '', r.consultant_name ? `Recorded consultant: ${r.consultant_name}` : ''].filter(Boolean).join(' · ') },
  { key: 'site_visit', label: 'Site visits', section: 'site', title: (r) => r.purpose, meta: (r) => [r.status, r.visit_at ? formatDateTime(r.visit_at) : ''].filter(Boolean).join(' · ') },
  { key: 'timeline_task', label: 'Timeline tasks', section: 'timeline', title: (r) => r.name, meta: (r) => [r.status, r.planned_end ? `Planned finish ${formatDate(r.planned_end)}` : '', r.responsible ? `Recorded responsible: ${r.responsible}` : ''].filter(Boolean).join(' · ') },
];

const TYPE_LABEL: Record<string, string> = { contract: 'Contract', payment_milestone: 'Payment milestone', material: 'Material line', consultant_visit: 'Consultant visit', site_visit: 'Site visit', timeline_task: 'Timeline task' };

/** Entry details: overview, contact people, project assignments, documents & links, related records. */
export function EntryDetail({ id, specializations, onChanged, onOpenEntry }: { id: string; specializations: Specialization[]; onChanged: () => void; onOpenEntry: (id: string) => void }) {
  const { data, error, reload } = useApi<DirectoryDetail>(`/api/directory/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  const [form, setForm] = useState<SubForm | null>(null);
  const { toast, confirm } = useUi();
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const { entry: e, permissions: perm } = data;
  const refresh = async () => { await reload(); onChanged(); };
  const act = async (url: string, msg: string, q?: React.ReactNode) => {
    if (q && !(await confirm(q, { title: 'Please confirm', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await refresh(); } catch (ex) { toast((ex as Error).message, 'error'); }
  };
  const activeContacts = data.contacts.filter((c) => !c.archived_at);
  const relatedCount = RELATED.reduce((a, r) => a + (data.related[r.key]?.length ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={e.entity_type === 'company' ? 'sky' : 'indigo'}>{e.entity_type === 'company' ? <Building2 className="w-3 h-3" /> : <User className="w-3 h-3" />}{ENTITY_TYPE_LABELS[e.entity_type]}</Badge>
            <span className="font-mono text-xs font-semibold text-slate-600">{e.ref}</span>
            {e.archived_at && <Badge tone="rose">Archived</Badge>}
          </div>
          <div className="text-xs text-slate-600 mt-1">{rolesText(e.roles)}{e.specializations.length > 0 && <span className="text-slate-500"> · {e.specializations.join(', ')}</span>}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {perm.canEdit && !e.archived_at && <Button size="sm" onClick={() => setForm({ kind: 'edit' })}><Pencil className="w-3.5 h-3.5" />Edit</Button>}
          {perm.canAddContact && <Button size="sm" onClick={() => { setTab('contacts'); setForm({ kind: 'contact', row: null }); }}><Plus className="w-3.5 h-3.5" />Contact person</Button>}
          {perm.canAssign && <Button size="sm" onClick={() => { setTab('assignments'); setForm({ kind: 'assign', row: null }); }}><Plus className="w-3.5 h-3.5" />Assign to project</Button>}
          {perm.canEdit && (e.archived_at
            ? <Button size="sm" variant="ghost" onClick={() => act(`/api/directory/${e.id}/restore`, 'Restored')}><RotateCcw className="w-3.5 h-3.5" />Restore</Button>
            : <Button size="sm" variant="ghost" onClick={() => act(`/api/directory/${e.id}/archive`, 'Archived', <>Archive <b>{e.display_name}</b>? Existing links on records stay readable; it can no longer be selected for new records.</>)}><Archive className="w-3.5 h-3.5" />Archive</Button>)}
        </div>
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'contacts', label: 'Contact people', count: activeContacts.length },
          { id: 'assignments', label: 'Project assignments', count: data.assignments.filter((a) => !a.archived_at).length },
          { id: 'documents', label: 'Documents & links', count: data.documents.length },
          { id: 'related', label: 'Related records', count: relatedCount },
        ]} />
      </div>

      {tab === 'overview' && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <Item label="General phone">{e.phone ? <span className="flex flex-wrap items-center gap-2">{formatPhone(e.phone)}<ContactActions phone={e.phone} compact name={e.display_name} /></span> : '—'}</Item>
          <Item label="Email">{e.email ? <span className="flex flex-wrap items-center gap-2 break-all">{e.email}<ContactActions email={e.email} compact name={e.display_name} /></span> : '—'}</Item>
          <Item label="Address">{e.address || '—'}</Item>
          <Item label="Website">{e.website ? <a href={e.website} target="_blank" rel="noopener noreferrer" className="text-sky-700 break-all inline-flex items-center gap-1">{e.website}<ExternalLink className="w-3 h-3" /></a> : '—'}</Item>
          <Item label="Registration / reference no.">{e.registration_no || '—'}</Item>
          <Item label="Primary contact">{activeContacts.find((c) => c.is_primary)?.name ?? activeContacts[0]?.name ?? (e.entity_type === 'individual' ? 'This individual (no separate contact needed)' : '—')}</Item>
          {e.notes && <div className="sm:col-span-2"><dt className="text-[11px] font-semibold text-slate-500">Notes</dt><dd className="whitespace-pre-wrap text-slate-800">{e.notes}</dd></div>}
          <Item label="Added">{formatDateTime(e.created_at)}{e.created_by_name ? ` by ${e.created_by_name}` : ''}</Item>
          <Item label="Last updated">{formatDateTime(e.updated_at)}{e.updated_by_name ? ` by ${e.updated_by_name}` : ''}</Item>
          {!perm.canEdit && <p className="sm:col-span-2 text-[11px] text-slate-500">Shared company details are edited by an admin, so a change never affects other projects unexpectedly.</p>}
        </dl>
      )}

      {tab === 'contacts' && (
        activeContacts.length === 0 && !data.contacts.length ? (
          <EmptyState title="No contact people yet">{e.entity_type === 'individual' ? 'An individual does not need a separate contact person.' : perm.canAddContact ? 'Add the people you deal with at this company.' : ''}</EmptyState>
        ) : (
          <ul className="space-y-2">
            {data.contacts.map((c) => (
              <li key={c.id} className={`border border-slate-200 rounded-lg p-3 bg-white ${c.archived_at ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 flex flex-wrap items-center gap-1.5">{c.name}{c.is_primary && !c.archived_at && <Badge tone="emerald"><Star className="w-3 h-3" />Primary</Badge>}{c.archived_at && <Badge tone="rose">Archived</Badge>}</div>
                    <div className="text-xs text-slate-600">{[c.position, c.mobile && formatPhone(c.mobile), c.email].filter(Boolean).join(' · ') || '—'}</div>
                    {c.notes && <p className="text-xs text-slate-500 mt-1 whitespace-pre-wrap">{c.notes}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!c.archived_at && <ContactActions phone={c.mobile} email={c.email} name={c.name} />}
                    {perm.canEdit && !c.archived_at && <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setForm({ kind: 'contact', row: c })}><Pencil className="w-3.5 h-3.5" /></Button>}
                    {perm.canEdit && (c.archived_at
                      ? <Button size="sm" variant="ghost" aria-label={`Restore ${c.name}`} onClick={() => act(`/api/directory/contacts/${c.id}/restore`, 'Contact restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                      : <Button size="sm" variant="ghost" aria-label={`Archive ${c.name}`} onClick={() => act(`/api/directory/contacts/${c.id}/archive`, 'Contact archived', <>Archive <b>{c.name}</b>? Records that name this contact keep showing it.</>)}><Archive className="w-3.5 h-3.5" /></Button>)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === 'assignments' && (
        data.assignments.length === 0 ? <EmptyState title="Not assigned to any of your projects">{perm.canAssign ? 'Use “Assign to project” to record its role and scope on a project.' : ''}</EmptyState> : (
          <ul className="space-y-2">
            {data.assignments.map((a) => {
              const editable = perm.writableProjects.some((p) => p.id === a.project_id);
              return (
                <li key={a.id} className={`border border-slate-200 rounded-lg p-3 bg-white ${a.archived_at ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 flex flex-wrap items-center gap-1.5"><span className="font-mono text-sky-700">{a.project_code}</span>{a.project_name}{a.archived_at && <Badge tone="rose">Ended / archived</Badge>}</div>
                      <div className="text-xs text-slate-600">{rolesText(a.roles)}{a.responsible_contact_name ? ` · Responsible: ${a.responsible_contact_name}` : ''}{a.start_date || a.end_date ? ` · ${formatDate(a.start_date)} → ${formatDate(a.end_date)}` : ''}</div>
                      {a.scope && <p className="text-xs text-slate-700 mt-1 whitespace-pre-wrap">{a.scope}</p>}
                    </div>
                    {editable && (
                      <div className="flex items-center gap-1">
                        {!a.archived_at && <Button size="sm" variant="ghost" aria-label={`Edit assignment on ${a.project_code}`} onClick={() => setForm({ kind: 'assign', row: a })}><Pencil className="w-3.5 h-3.5" /></Button>}
                        {a.archived_at
                          ? <Button size="sm" variant="ghost" aria-label={`Restore assignment on ${a.project_code}`} onClick={() => act(`/api/directory/assignments/${a.id}/restore`, 'Assignment restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                          : <Button size="sm" variant="ghost" aria-label={`Archive assignment on ${a.project_code}`} onClick={() => act(`/api/directory/assignments/${a.id}/archive`, 'Assignment archived', <>End the assignment on <b>{a.project_code}</b>? Existing record links stay; it can no longer be selected on that project.</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      )}

      {tab === 'documents' && (
        <div className="space-y-3">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Item label="Drive folder">{e.drive_url ? <a href={e.drive_url} target="_blank" rel="noopener noreferrer" className="text-sky-700 inline-flex items-center gap-1">Open folder<ExternalLink className="w-3 h-3" /></a> : '—'}</Item>
            <Item label="Quotations folder">{e.quotations_url ? <a href={e.quotations_url} target="_blank" rel="noopener noreferrer" className="text-sky-700 inline-flex items-center gap-1">Open folder<ExternalLink className="w-3 h-3" /></a> : '—'}</Item>
          </dl>
          <DirectoryDocuments entryId={e.id} documents={data.documents} canUploadShared={perm.canUploadShared} writableProjects={perm.writableProjects}
            assignedProjectIds={data.assignments.filter((a) => !a.archived_at).map((a) => a.project_id)} archived={!!e.archived_at} onChange={() => void reload()} />
        </div>
      )}

      {tab === 'related' && (
        <div className="space-y-4">
          {relatedCount === 0 && <p className="text-xs text-slate-500">No records in your projects are linked to this entry yet.</p>}
          {RELATED.filter((r) => data.related[r.key]?.length).map((r) => (
            <section key={r.key}>
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">{r.label}</h4>
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
                {data.related[r.key]!.map((x) => (
                  <li key={x.id} className={x.archived_at ? 'opacity-60' : ''}>
                    <a href={`#/${r.section}/${x.project_id}/${x.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 no-underline hover:bg-slate-50">
                      <span className="font-mono text-[11px] text-sky-700">{x.project_code}</span>
                      <span className="text-sm font-semibold text-slate-900 min-w-0 break-words">{r.title(x)}</span>
                      {x.archived_at && <Badge tone="rose">Archived</Badge>}
                      <span className="basis-full text-[11px] text-slate-500">{r.meta(x)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {perm.canAssign && <Suggestions entryId={e.id} onLinked={() => void refresh()} />}
          <p className="text-[11px] text-slate-500">Only records in your projects that you are allowed to see are listed. Each record keeps the name it was originally recorded with.</p>
        </div>
      )}

      <Modal portal open={!!form} wide={form?.kind === 'edit'} onClose={() => setForm(null)}
        title={form?.kind === 'edit' ? `Edit ${e.display_name}` : form?.kind === 'contact' ? (form.row ? `Edit ${form.row.name}` : `Add contact person — ${e.display_name}`) : form?.kind === 'assign' ? (form.row ? `Edit assignment — ${form.row.project_code}` : `Assign ${e.display_name} to a project`) : ''}>
        {form?.kind === 'edit' && <EntryForm initial={e} specializations={specializations} onCancel={() => setForm(null)} onOpenExisting={(x) => { setForm(null); onOpenEntry(x); }}
          onSaved={async () => { toast('Saved — records keep their originally recorded names'); setForm(null); await refresh(); }} />}
        {form?.kind === 'contact' && (
          <RecordForm mode={form.row ? 'edit' : 'create'} initial={form.row ?? { is_primary: activeContacts.length === 0 }} onCancel={() => setForm(null)}
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'position', label: 'Position / job title' },
              { name: 'mobile', label: 'Mobile / WhatsApp', type: 'phone' },
              { name: 'email', label: 'Email' },
              { name: 'is_primary', label: 'Primary contact', type: 'checkbox' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            extra={<p className="text-[11px] text-slate-500">This does not create a login or give the person access to the application.</p>}
            onSubmit={async (v) => {
              if (form.row) await patch(`/api/directory/contacts/${form.row.id}`, v); else await post(`/api/directory/${e.id}/contacts`, v);
              toast('Contact saved'); setForm(null); await refresh();
            }} />
        )}
        {form?.kind === 'assign' && (
          <RecordForm mode={form.row ? 'edit' : 'create'} initial={form.row ?? { roles: e.roles.slice(0, 1) }} onCancel={() => setForm(null)}
            fields={[
              { name: 'project_id', label: 'Project', type: 'select', required: true, hidden: !!form.row,
                options: perm.writableProjects.filter((p) => !data.assignments.some((a) => a.project_id === p.id && !a.archived_at)).map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })) },
              { name: 'roles', label: 'Role(s) on this project', type: 'checklist', required: true, options: BUSINESS_ROLES.map((r) => ({ value: r, label: BUSINESS_ROLE_LABELS[r] })) },
              { name: 'responsible_contact_id', label: 'Responsible contact person', type: 'searchselect', nullable: true, noneLabel: 'Not set', noMatchLabel: 'No matching contacts',
                options: activeContacts.map((c) => ({ value: c.id, label: c.name, hint: c.position || undefined })), fallbackLabel: form.row?.responsible_contact_name ?? undefined, hidden: e.entity_type === 'individual' && activeContacts.length === 0 },
              { name: 'start_date', label: 'Start date', type: 'date' },
              { name: 'end_date', label: 'End date', type: 'date' },
              { name: 'scope', label: 'Scope / responsibility on this project', type: 'textarea' },
              { name: 'notes', label: 'Project-specific notes', type: 'textarea' },
            ]}
            extra={<p className="text-[11px] text-slate-500">Assigning does not give anyone access and does not change any contract, budget or payment.</p>}
            onSubmit={async (v) => {
              if (form.row) await patch(`/api/directory/assignments/${form.row.id}`, v); else await post(`/api/directory/${e.id}/assignments`, v);
              toast('Assignment saved'); setForm(null); await refresh();
            }} />
        )}
      </Modal>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11px] font-semibold text-slate-500">{label}</dt><dd className="text-slate-800 break-words">{children}</dd></div>;
}

/** Possible matches among unlinked records — shown with the original name; linked one by one after review. */
function Suggestions({ entryId, onLinked }: { entryId: string; onLinked: () => void }) {
  const { data, reload } = useApi<{ entry: { display_name: string; ref: string }; suggestions: Array<{ type: string; id: string; project_id: string; project_code: string; original_name: string; label: string; assigned: boolean }> }>(`/api/directory/${entryId}/suggestions`);
  const { toast, confirm } = useUi();
  if (!data || data.suggestions.length === 0) return null;
  return (
    <section className="rounded-lg border border-sky-200 bg-sky-50/50 p-3 space-y-2" data-testid="link-suggestions">
      <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5 text-sky-600" />Possible matches to review</h4>
      <p className="text-[11px] text-slate-600">These unlinked records have a similar recorded name. Nothing is linked unless you confirm each one; the recorded name is kept.</p>
      <ul className="divide-y divide-sky-100 border border-sky-100 rounded-lg bg-white">
        {data.suggestions.map((s) => (
          <li key={`${s.type}-${s.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
            <span className="font-mono text-sky-700">{s.project_code}</span>
            <span className="text-slate-500">{TYPE_LABEL[s.type]}</span>
            <span className="font-semibold text-slate-900 min-w-0 break-words">{s.label}</span>
            <span className="basis-full sm:basis-auto text-slate-600">Recorded name “{s.original_name}” → {data.entry.display_name} <span className="font-mono">{data.entry.ref}</span></span>
            <span className="ml-auto">
              {s.assigned
                ? <Button size="sm" onClick={async () => {
                    if (!(await confirm(<>Link <b>{s.label}</b> ({TYPE_LABEL[s.type].toLowerCase()}, recorded as “{s.original_name}”) to <b>{data.entry.display_name}</b>? The recorded name and amounts stay unchanged.</>, { title: 'Confirm link', confirmLabel: 'Link' }))) return;
                    try { await post(`/api/directory/${entryId}/link`, { type: s.type, record_id: s.id }); toast('Linked'); await reload(); onLinked(); } catch (ex) { toast((ex as Error).message, 'error'); }
                  }}>Link</Button>
                : <span className="text-[11px] text-amber-800">Assign to {s.project_code} first</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
