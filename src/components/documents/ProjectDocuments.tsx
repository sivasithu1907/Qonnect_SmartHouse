import React, { useEffect, useMemo, useState } from 'react';
import { Archive, Download, ExternalLink, Eye, FileText, FolderOpen, ListChecks, Pencil, Plus, RotateCcw, Search, Wand2 } from 'lucide-react';
import { patch, post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useSession } from '../../lib/session';
import type { Project } from '../../lib/types';
import { formatBytes, formatDate, formatDateTime } from '../../lib/format';
import {
  DOCUMENT_SOURCE_LABELS, PREVIEWABLE_MIME_TYPES, PROJECT_DOCUMENT_CATEGORIES, PROJECT_DOCUMENT_CATEGORY_LABELS,
  type AttachmentEntityType, type ProjectDocumentCategory,
} from '../../../shared/constants';
import { Attachments, FileName, kindLabel } from '../Attachments';
import { Badge, Button, EmptyState, inputCls, Modal, Notice, RecordForm, useUi, type FieldSpec } from '../ui';

export interface ProjectDocument {
  id: string; title: string; category: ProjectDocumentCategory; reference: string; document_date: string | null; drive_url: string; notes: string;
  archived_at: string | null; created_at: string; created_by_name: string | null; file_count: number;
  prerequisites?: Array<{ id: string; title: string; status: string }>;
}
export interface RegisterFile {
  id: string; entity_type: AttachmentEntityType; entity_id: string; kind: string; name: string; original_name: string; description: string;
  mime_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null; source_title: string | null; href: string; category: string | null;
  /** likely original of a name garbled before the Arabic fix (only a suggestion) */
  suggested_name?: string | null;
}
export interface DocumentsResponse { documents: ProjectDocument[]; register: RegisterFile[]; sources: AttachmentEntityType[] }

const catLabel = (c: string) => PROJECT_DOCUMENT_CATEGORY_LABELS[c as ProjectDocumentCategory] ?? c;
const SOURCE_TONE: Partial<Record<AttachmentEntityType, 'sky' | 'indigo' | 'emerald' | 'amber' | 'violet' | 'slate'>> = {
  project_document: 'sky', prerequisite: 'indigo', contract: 'violet', contract_amendment: 'violet', payment_milestone: 'emerald', payment_transaction: 'emerald',
  consultant_visit: 'amber', budget_item: 'slate',
};

export const documentFields: FieldSpec[] = [
  { name: 'title', label: 'Title', required: true, wide: true, placeholder: 'e.g. Building permit, Architectural drawings rev C' },
  { name: 'category', label: 'Category', type: 'select', required: true, options: PROJECT_DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: PROJECT_DOCUMENT_CATEGORY_LABELS[c] })) },
  { name: 'reference', label: 'Reference / number', placeholder: 'Optional' },
  { name: 'document_date', label: 'Document date', type: 'date' },
  { name: 'drive_url', label: 'Google Drive link (optional)', type: 'url' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

/**
 * Contracts & Documents → Project documents. Permits, drawings, surveys, approvals and reports live here once;
 * prerequisites on the dashboard link to these records. "All project files" also lists files kept on other
 * records (contract files, payment slips, consultant reports, budget item files) with a link to the original.
 */
export function ProjectDocuments({ project, data, reload, focusId, onFocusHandled }: {
  project: Project; data: DocumentsResponse | null; reload: () => Promise<void>; focusId?: string | null; onFocusHandled?: () => void;
}) {
  const { can } = useSession();
  const writable = can('documents.write') && !project.archived_at;
  const [view, setView] = useState<'documents' | 'files'>('documents');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [source, setSource] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: ProjectDocument | null } | null>(null);
  const { toast } = useUi();

  useEffect(() => {
    if (focusId && data?.documents.some((d) => d.id === focusId)) { setOpenId(focusId); onFocusHandled?.(); }
  }, [focusId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = q.trim().toLowerCase();
  const docs = useMemo(() => (data?.documents ?? []).filter((d) => (showArchived || !d.archived_at) && (!cat || d.category === cat)
    && (!s || `${d.title} ${d.reference} ${d.notes} ${catLabel(d.category)}`.toLowerCase().includes(s))), [data, showArchived, cat, s]);
  const files = useMemo(() => (data?.register ?? []).filter((f) => (!source || f.entity_type === source)
    && (!s || `${f.name} ${f.original_name} ${f.source_title ?? ''} ${f.description} ${kindLabel(f.kind)}`.toLowerCase().includes(s))), [data, source, s]);
  const open = data?.documents.find((d) => d.id === openId) ?? null;

  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  const save = async (row: ProjectDocument | null, v: Record<string, unknown>) => {
    if (row) await patch(`/api/projects/${project.id}/documents/${row.id}`, v);
    else { const d = await post<ProjectDocument>(`/api/projects/${project.id}/documents`, v); setOpenId(d.id); }
    toast(row ? 'Document updated' : 'Document added — upload its files below');
    setEdit(null);
    await reload();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Document view" className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          {([['documents', `Documents (${data.documents.filter((d) => !d.archived_at).length})`], ['files', `All project files (${data.register.length})`]] as const).map(([id, label]) => (
            <button key={id} role="tab" type="button" aria-selected={view === id} onClick={() => setView(id)}
              className={`px-3 py-1.5 text-sm font-semibold min-h-9 border-l first:border-l-0 border-slate-200 ${view === id ? 'bg-sky-50 text-sky-800' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
          ))}
        </div>
        <label className="relative flex-1 min-w-[180px] max-w-xs">
          <span className="sr-only">Search documents</span>
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={view === 'documents' ? 'Search title, reference…' : 'Search file, record…'} className={`${inputCls} pl-8`} />
        </label>
        {view === 'documents' ? (
          <select className={`${inputCls} !w-auto`} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {PROJECT_DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{PROJECT_DOCUMENT_CATEGORY_LABELS[c]}</option>)}
          </select>
        ) : (
          <select className={`${inputCls} !w-auto`} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source">
            <option value="">All sources</option>
            {data.sources.map((t) => <option key={t} value={t}>{DOCUMENT_SOURCE_LABELS[t]}</option>)}
          </select>
        )}
        {view === 'documents' && <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}
        {writable && view === 'documents' && <Button variant="primary" size="sm" className="ml-auto" onClick={() => setEdit({ row: null })}><Plus className="w-3.5 h-3.5" />Add document</Button>}
      </div>

      {view === 'documents' ? (
        docs.length === 0 ? (
          <EmptyState title={data.documents.length ? 'No documents match' : 'No project documents yet'}>
            {data.documents.length ? 'Clear the search or filter.' : 'Add permits, drawings, surveys, approvals and reports here. Dashboard prerequisites link to these records instead of keeping separate copies.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white" data-testid="document-list">
            {docs.map((d) => (
              <li key={d.id} id={`rec-${d.id}`}>
                <button type="button" onClick={() => setOpenId(d.id)} className={`w-full text-left px-4 py-3 hover:bg-slate-50 grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${d.archived_at ? 'opacity-60' : ''}`}>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 break-words" dir="auto">{d.title}</span>
                      <Badge tone="sky">{catLabel(d.category)}</Badge>
                      {d.archived_at && <Badge tone="rose">Archived</Badge>}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      {d.reference && <span>Ref {d.reference}</span>}
                      {d.document_date && <span>{formatDate(d.document_date)}</span>}
                      <span>{d.file_count} file{d.file_count === 1 ? '' : 's'}</span>
                      {(d.prerequisites ?? []).length > 0 && <span className="inline-flex items-center gap-1 text-indigo-700"><ListChecks className="w-3 h-3" />Supports {d.prerequisites!.map((p) => p.title).join(', ')}</span>}
                    </span>
                  </span>
                  <span className="text-xs font-semibold text-sky-700">Open →</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {view === 'files' && <NameRepairs projectId={project.id} count={data.register.filter((f) => f.suggested_name).length} onDone={reload} />}
      {view === 'documents' ? null : files.length === 0 ? (
        <EmptyState title="No files">No files match. Files are listed here from every record type you can open.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white" data-testid="register-list">
          {files.map((f) => (
            <li key={f.id} className="px-4 py-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0 flex items-start gap-2">
                <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900"><FileName name={f.name} /></div>
                  {f.suggested_name && <div className="text-[11px] text-amber-800 flex items-center gap-1"><Wand2 className="w-3 h-3 shrink-0" />Likely original: <FileName name={f.suggested_name} /></div>}
                  <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Badge tone={SOURCE_TONE[f.entity_type] ?? 'slate'}>{DOCUMENT_SOURCE_LABELS[f.entity_type]}</Badge>
                    <a href={f.href} className="text-sky-700 hover:underline break-words" dir="auto">{f.source_title || 'Open record'}</a>
                    <span>{kindLabel(f.kind)} · {formatBytes(f.size_bytes)} · {formatDateTime(f.created_at)}{f.uploaded_by_name ? ` by ${f.uploaded_by_name}` : ''}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 sm:justify-end">
                {PREVIEWABLE_MIME_TYPES.includes(f.mime_type) && <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`/api/projects/${project.id}/attachments/${f.id}/download?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${f.name}`} title="Preview"><Eye className="w-4 h-4" /></a>}
                <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`/api/projects/${project.id}/attachments/${f.id}/download`} aria-label={`Download ${f.name}`} title="Download"><Download className="w-4 h-4" /></a>
                <a className="p-1.5 text-slate-500 hover:text-sky-700" href={f.href} aria-label={`Open the ${DOCUMENT_SOURCE_LABELS[f.entity_type].toLowerCase()} this file belongs to`} title="Open the original record"><ExternalLink className="w-4 h-4" /></a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {view === 'files' && <p className="text-[11px] text-slate-500">Files stay with their original record and keep its permissions; nothing is copied. Only record types your role can open are listed.</p>}

      <Modal open={!!edit} title={edit?.row ? 'Edit project document' : 'Add project document'} onClose={() => setEdit(null)} wide>
        {edit && <RecordForm fields={documentFields} initial={edit.row ?? { category: 'permit' }} mode={edit.row ? 'edit' : 'create'} onCancel={() => setEdit(null)} onSubmit={(v) => save(edit.row, v)} />}
      </Modal>
      {open && !edit && (
        <DocumentDetails project={project} d={open} writable={writable} onClose={() => setOpenId(null)} onEdit={() => setEdit({ row: open })} onChanged={reload} />
      )}
    </div>
  );
}

function DocumentDetails({ project, d, writable, onClose, onEdit, onChanged }: {
  project: Project; d: ProjectDocument; writable: boolean; onClose: () => void; onEdit: () => void; onChanged: () => Promise<void>;
}) {
  const { toast, confirm } = useUi();
  const editable = writable && !d.archived_at;
  const act = async (action: 'archive' | 'restore') => {
    if (action === 'archive' && !(await confirm(<>Archive <b dir="auto">{d.title}</b>? Its files are kept and links from prerequisites remain visible as archived.</>, { title: 'Archive document', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(`/api/projects/${project.id}/documents/${d.id}/${action}`); toast(action === 'archive' ? 'Document archived' : 'Document restored'); await onChanged(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open title={d.title} subtitle={`${catLabel(d.category)}${d.reference ? ` · Ref ${d.reference}` : ''}`} onClose={onClose} wide>
      <div className="space-y-4">
        {d.archived_at && <Notice tone="amber">This document is archived (read-only).</Notice>}
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Category</dt><dd className="mt-1"><Badge tone="sky">{catLabel(d.category)}</Badge></dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Document date</dt><dd className="mt-1 font-semibold text-slate-800">{d.document_date ? formatDate(d.document_date) : 'Not set'}</dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Added</dt><dd className="mt-1 text-slate-800">{formatDateTime(d.created_at)}{d.created_by_name ? ` by ${d.created_by_name}` : ''}</dd></div>
          {d.notes && <div className="sm:col-span-3"><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes</dt><dd className="mt-1 whitespace-pre-wrap break-words text-slate-800" dir="auto">{d.notes}</dd></div>}
        </dl>
        {d.drive_url && (
          <a href={d.drive_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700"><FolderOpen className="w-4 h-4" />Open Drive link<ExternalLink className="w-3 h-3" /></a>
        )}
        <Attachments projectId={project.id} entityType="project_document" entityId={d.id} defaultKind="supporting_document" title="Files" canUpload={editable} onChange={() => void onChanged()} />
        {d.prerequisites !== undefined && (
          <section>
            <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">Supports these prerequisites</h4>
            {d.prerequisites.length === 0 ? <p className="text-xs text-slate-500">Not linked to a prerequisite. Link it from the prerequisite on the dashboard.</p> : (
              <ul className="space-y-1">
                {d.prerequisites.map((p) => (
                  <li key={p.id}><a href={`#/dashboard/${project.id}/${p.id}`} onClick={onClose} className="inline-flex items-center gap-2 text-sm text-sky-700 hover:underline"><ListChecks className="w-4 h-4" /><span dir="auto">{p.title}</span><Badge tone={p.status === 'Completed' ? 'emerald' : 'slate'}>{p.status}</Badge></a></li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-slate-500 mt-1">A prerequisite’s status is recorded on the prerequisite itself; uploading files here never approves it.</p>
          </section>
        )}
        {writable && (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {editable && <Button onClick={onEdit}><Pencil className="w-4 h-4" />Edit details</Button>}
            {d.archived_at ? <Button variant="ghost" onClick={() => act('restore')}><RotateCcw className="w-4 h-4" />Restore</Button> : <Button variant="ghost" onClick={() => act('archive')}><Archive className="w-4 h-4" />Archive</Button>}
          </div>
        )}
      </div>
    </Modal>
  );
}

interface RepairRow { id: string; entity_type: AttachmentEntityType; source_title: string | null; href: string; current_name: string; suggested_name: string; can_fix: boolean }

/**
 * Files uploaded before the Arabic file-name fix may show garbled names. This lists the reliable repairs for review;
 * applying them sets each file's display name only — the stored file, its id, links and original name never change.
 */
function NameRepairs({ projectId, count, onDone }: { projectId: string; count: number; onDone: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<RepairRow[]>(open ? `/api/projects/${projectId}/documents/name-repairs` : null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  if (!count) return null;
  const fixable = (data ?? []).filter((r) => r.can_fix);
  const chosen = fixable.filter((r) => pick[r.id] !== false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-900" role="note" data-testid="name-repair-banner">
        <Wand2 className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0"><b>{count} file name{count === 1 ? '' : 's'}</b> look{count === 1 ? 's' : ''} garbled (uploaded before the Arabic file-name fix). The likely original can be restored for review.</span>
        <Button size="sm" onClick={() => setOpen(true)}>Review names</Button>
      </div>
      <Modal open={open} wide title="Repair garbled file names" onClose={() => setOpen(false)}>
        {!data ? <p className="text-sm text-slate-500">Loading…</p> : (
          <div className="space-y-3">
            <p className="text-xs text-slate-600">Each file keeps its stored copy, id, links and original name; only the name shown and used for downloads changes. You can rename any file again later.</p>
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg" data-testid="name-repair-list">
              {data.map((r) => (
                <li key={r.id} className="px-3 py-2 flex items-start gap-3">
                  <input type="checkbox" className="mt-1 rounded border-slate-300" disabled={!r.can_fix} checked={r.can_fix && pick[r.id] !== false}
                    onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.checked }))} aria-label={`Repair ${r.suggested_name}`} />
                  <div className="min-w-0 text-xs">
                    <div className="text-slate-400 line-through break-all">{r.current_name}</div>
                    <div className="text-sm font-semibold text-slate-900"><FileName name={r.suggested_name} /></div>
                    <div className="text-slate-500">{DOCUMENT_SOURCE_LABELS[r.entity_type]} · <a href={r.href} className="text-sky-700 hover:underline" dir="auto" onClick={() => setOpen(false)}>{r.source_title || 'Open record'}</a>{!r.can_fix && <span className="text-amber-800"> · you can’t rename files on this record</span>}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={async () => {
                setBusy(true);
                try {
                  const r = await post<{ fixed: number }>(`/api/projects/${projectId}/documents/repair-names`, { ids: chosen.map((x) => x.id) });
                  toast(`${r.fixed} file name${r.fixed === 1 ? '' : 's'} repaired (original names kept)`);
                  setOpen(false); setPick({}); await reload(); await onDone();
                } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
              }}>Apply {chosen.length} repair{chosen.length === 1 ? '' : 's'}</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
