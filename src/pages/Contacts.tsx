import React, { useEffect, useState } from 'react';
import { Archive, BookUser, Building2, ChevronRight, Plus, RotateCcw, Settings2, User } from 'lucide-react';
import { post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, Project } from '../lib/types';
import { rolesText, type DirectoryListItem, type DirectoryListResponse, type Specialization } from '../lib/directory';
import { BUSINESS_ROLE_LABELS, BUSINESS_ROLES, formatPhone } from '../../shared/directory';
import { useWideLayout } from '../components/materials/MaterialCategorySection';
import { ContactActions } from '../components/directory/ContactActions';
import { EntryDetail } from '../components/directory/EntryDetail';
import { EntryForm } from '../components/directory/EntryForm';
import { Badge, Button, Card, EmptyState, inputCls, Modal, Notice, PageHeader, Spinner, Table, Td, Th, useUi } from '../components/ui';

type Scope = 'project' | 'all';
const UUID = /^[0-9a-f-]{36}$/i;

/** Companies and independent individuals used across projects, their contact people and project assignments. */
export function Contacts({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const { can } = useSession();
  const [scope, setScope] = useState<Scope>('project');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState('');
  const [spec, setSpec] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [specsOpen, setSpecsOpen] = useState(false);
  const wide = useWideLayout();
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (focusId && UUID.test(focusId)) { setOpenId(focusId); onFocusHandled?.(); } }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pid = scope === 'project' ? project.id : projectFilter;
  const params = new URLSearchParams({ status, ...(debounced && { q: debounced }), ...(role && { role }), ...(spec && { spec }), ...(pid && { project: pid }) });
  const { data, error, reload } = useApi<DirectoryListResponse>(`/api/directory?${params}`);
  const { data: specs, reload: reloadSpecs } = useApi<Specialization[]>('/api/directory/specializations');
  if (error) return <Notice tone="rose">{error}</Notice>;
  const assignHere = data?.canCreate && scope === 'project' && !project.archived_at;
  const filtered = !!(debounced || role || spec || status !== 'active' || (scope === 'all' && projectFilter));

  return (
    <div className="space-y-6">
      <PageHeader icon={<BookUser className="w-5 h-5" />} title="Contacts"
        subtitle="Companies and individuals you work with — consultants, suppliers and contractors — with their contact people and project roles"
        actions={<>
          {data?.canManage && <Button onClick={() => setSpecsOpen(true)}><Settings2 className="w-4 h-4" />Specializations</Button>}
          {data?.canCreate && <Button variant="primary" onClick={() => setAdding(true)}><Plus className="w-4 h-4" />Add company / individual</Button>}
        </>} />

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50" role="tablist" aria-label="Which contacts">
            {([['project', `This project (${project.code})`], ['all', 'All accessible']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={scope === id} onClick={() => setScope(id)}
                className={`px-3 py-1.5 text-xs rounded-md ${scope === id ? 'bg-white shadow-2xs font-semibold text-sky-800' : 'text-slate-600 hover:text-slate-900'}`}>{label}</button>
            ))}
          </div>
          <input type="search" className={`${inputCls} sm:max-w-xs`} placeholder="Search name, phone, email, reference…" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <select className={`${inputCls} !w-auto`} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
            <option value="">All roles</option>
            {BUSINESS_ROLES.map((r) => <option key={r} value={r}>{BUSINESS_ROLE_LABELS[r]}</option>)}
          </select>
          <select className={`${inputCls} !w-auto`} value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="Filter by specialization">
            <option value="">All specializations</option>
            {(specs ?? []).map((s) => <option key={s.id} value={s.name}>{s.name}{s.archived_at ? ' (archived)' : ''}</option>)}
          </select>
          {scope === 'all' && (
            <select className={`${inputCls} !w-auto max-w-[16rem]`} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Filter by project">
              <option value="">Any project</option>
              {(data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          )}
          <select className={`${inputCls} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">Active and archived</option>
          </select>
        </div>

        {!data ? <Spinner /> : (
          <>
            <p className="text-xs text-slate-500 mb-2" aria-live="polite">{data.entries.length} entr{data.entries.length === 1 ? 'y' : 'ies'}{data.entries.length >= 500 ? ' (first 500 — refine the search)' : ''}</p>
            {data.entries.length === 0 ? (
              <EmptyState title={filtered ? 'No entries match' : scope === 'project' ? `No companies or individuals assigned to ${project.code} yet` : 'No entries yet'}>
                {filtered ? 'Clear the search or filters.' : scope === 'project' && data.canCreate ? 'Add one, or open “All accessible” and assign an existing entry to this project.' : ''}
              </EmptyState>
            ) : wide ? (
              <Table>
                <thead><tr>
                  <Th>Name / ref</Th><Th>Roles</Th><Th className="hidden lg:table-cell">Specialization</Th><Th>Primary contact</Th><Th>Phone / email</Th><Th>Projects</Th><Th><span className="sr-only">Actions</span></Th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.entries.map((e) => (
                    <tr key={e.id} id={`rec-${e.id}`} className={`hover:bg-slate-50/60 cursor-pointer ${e.archived_at ? 'opacity-60' : ''}`} onClick={() => setOpenId(e.id)}>
                      <Td>
                        <button type="button" className="text-left font-semibold text-slate-900 hover:text-sky-700 inline-flex items-center gap-1.5" onClick={(x) => { x.stopPropagation(); setOpenId(e.id); }}>
                          <EntityIcon e={e} />{e.display_name}
                        </button>
                        <div className="text-[11px] font-mono text-slate-500">{e.ref}{e.archived_at && <Badge tone="rose">Archived</Badge>}</div>
                      </Td>
                      <Td>{rolesText(e.roles)}</Td>
                      <Td className="hidden lg:table-cell">{e.specializations.join(', ') || '—'}</Td>
                      <Td>{e.primary_contact ? <><div className="font-semibold text-slate-800">{e.primary_contact.name}</div>{e.primary_contact.position && <div className="text-[11px] text-slate-500">{e.primary_contact.position}</div>}</> : <span className="text-slate-400">{e.entity_type === 'individual' ? 'Self' : '—'}</span>}</Td>
                      <Td><PhoneEmail e={e} /></Td>
                      <Td><Assignments e={e} /></Td>
                      <Td className="text-right whitespace-nowrap" ><span onClick={(x) => x.stopPropagation()}><Quick e={e} /></span><ChevronRight className="inline w-4 h-4 text-slate-300 ml-1" /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <ul className="space-y-2">
                {data.entries.map((e) => (
                  <li key={e.id} id={`rec-${e.id}`} className={`border border-slate-200 rounded-xl bg-white p-3 ${e.archived_at ? 'opacity-60' : ''}`}>
                    <button type="button" className="w-full text-left" onClick={() => setOpenId(e.id)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5 break-words"><EntityIcon e={e} />{e.display_name}</div>
                          <div className="text-[11px] text-slate-500"><span className="font-mono">{e.ref}</span> · {rolesText(e.roles)}{e.archived_at ? ' · Archived' : ''}</div>
                          {e.specializations.length > 0 && <div className="text-[11px] text-slate-500">{e.specializations.join(', ')}</div>}
                          {e.primary_contact && <div className="text-xs text-slate-700 mt-1">{e.primary_contact.name}{e.primary_contact.position ? ` · ${e.primary_contact.position}` : ''}</div>}
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1" />
                      </div>
                    </button>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <Assignments e={e} />
                      <Quick e={e} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <p className="mt-3 text-[11px] text-slate-500">Entries are not user accounts: adding one never creates a login or gives access. Only projects you can open are shown.</p>
      </Card>

      <Modal open={adding} wide onClose={() => setAdding(false)} title={assignHere ? `Add company / individual — assigned to ${project.code}` : 'Add company / individual'}>
        {adding && specs && (
          <EntryForm initial={null} specializations={specs} assignProject={assignHere ? { id: project.id, code: project.code } : null}
            onCancel={() => setAdding(false)} onOpenExisting={(id) => { setAdding(false); setOpenId(id); }}
            onSaved={async (e) => { setAdding(false); await reload(); setOpenId(e.id); }} />
        )}
      </Modal>
      <Modal open={!!openId} wide onClose={() => setOpenId(null)} title={data?.entries.find((e) => e.id === openId)?.display_name ?? 'Contact details'}>
        {openId && <EntryDetail key={openId} id={openId} specializations={specs ?? []} onChanged={() => void reload()} onOpenEntry={(id) => setOpenId(id)} />}
      </Modal>
      {data?.canManage && <Modal open={specsOpen} onClose={() => setSpecsOpen(false)} title="Specializations">
        <ManageSpecializations specs={specs ?? []} onChange={() => void reloadSpecs()} />
      </Modal>}
    </div>
  );
}

function Quick({ e }: { e: DirectoryListItem }) {
  if (e.archived_at) return null;
  const phone = e.primary_contact?.mobile || e.phone;
  const email = e.primary_contact?.email || e.email;
  return <ContactActions phone={phone} email={email} compact name={e.primary_contact?.name ?? e.display_name} />;
}


const EntityIcon = ({ e }: { e: DirectoryListItem }) => e.entity_type === 'individual'
  ? <User className="w-3.5 h-3.5 text-indigo-500 shrink-0" aria-label="Individual" />
  : <Building2 className="w-3.5 h-3.5 text-sky-600 shrink-0" aria-label="Company" />;

function PhoneEmail({ e }: { e: DirectoryListItem }) {
  const phone = e.primary_contact?.mobile || e.phone;
  const email = e.primary_contact?.email || e.email;
  if (!phone && !email) return <span className="text-slate-400">—</span>;
  return <div className="space-y-0.5">{phone && <div className="whitespace-nowrap">{formatPhone(phone)}</div>}{email && <div className="break-all text-slate-600">{email}</div>}</div>;
}

function Assignments({ e }: { e: DirectoryListItem }) {
  const active = e.assignments.filter((a) => !a.archived_at);
  if (active.length === 0) return <span className="text-[11px] text-slate-400">Not assigned to your projects</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {active.map((a) => <span key={a.id} title={`${a.project_name} · ${rolesText(a.roles)}`} className="font-mono text-[10px] font-semibold text-sky-800 bg-sky-50 border border-sky-100 rounded px-1.5 py-0.5">{a.project_code}</span>)}
    </span>
  );
}

function ManageSpecializations({ specs, onChange }: { specs: Specialization[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast(msg); onChange(); } catch (ex) { toast((ex as Error).message, 'error'); } finally { setBusy(false); } };
  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => post('/api/directory/specializations', { name: name.trim() }), 'Added').then(() => setName('')); }}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="New specialization, e.g. Waterproofing" aria-label="New specialization" />
        <Button type="submit" variant="primary" busy={busy}><Plus className="w-4 h-4" />Add</Button>
      </form>
      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
        {specs.map((s) => (
          <li key={s.id} className={`flex items-center justify-between px-3 py-1.5 text-sm ${s.archived_at ? 'text-slate-400' : 'text-slate-800'}`}>
            <span>{s.name}{s.archived_at && ' (archived)'}</span>
            {s.archived_at
              ? <Button size="sm" variant="ghost" aria-label={`Restore ${s.name}`} onClick={() => run(() => post(`/api/directory/specializations/${s.id}/restore`), 'Restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
              : <Button size="sm" variant="ghost" aria-label={`Archive ${s.name}`} onClick={() => run(() => post(`/api/directory/specializations/${s.id}/archive`), 'Archived')}><Archive className="w-3.5 h-3.5" /></Button>}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500">Archiving hides a specialization from new selections; entries that already use it keep it.</p>
    </div>
  );
}
