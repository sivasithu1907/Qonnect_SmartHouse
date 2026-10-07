import React, { useRef, useState } from 'react';
import { Download, Eye, FileText, Lock, Share2, Trash2, Upload } from 'lucide-react';
import { post, upload } from '../../lib/api';
import { formatBytes, formatDateTime } from '../../lib/format';
import type { DirectoryDocument } from '../../lib/directory';
import { DIRECTORY_DOCUMENT_KIND_LABELS, DIRECTORY_DOCUMENT_KINDS } from '../../../shared/directory';
import { PREVIEWABLE_MIME_TYPES } from '../../../shared/constants';
import { Button, inputCls, useUi } from '../ui';

/**
 * Directory documents through the scoped /api/directory routes: shared company documents (admin) and
 * project-specific documents (visible only to that project). Signed project contracts stay in
 * Contracts & Documents.
 */
export function DirectoryDocuments({ entryId, documents, canUploadShared, writableProjects, assignedProjectIds, archived, onChange }: {
  entryId: string; documents: DirectoryDocument[]; canUploadShared: boolean;
  writableProjects: Array<{ id: string; code: string; name: string }>; assignedProjectIds: string[]; archived: boolean; onChange: () => void;
}) {
  const projectChoices = writableProjects.filter((p) => assignedProjectIds.includes(p.id));
  const [visibility, setVisibility] = useState<string>(canUploadShared ? 'shared' : projectChoices[0]?.id ?? '');
  const [kind, setKind] = useState<string>('company_profile');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast, confirm } = useUi();
  const base = `/api/directory/${entryId}/documents`;
  const canUpload = !archived && (canUploadShared || projectChoices.length > 0);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !visibility) return;
    setBusy(true);
    try { await upload(base, { kind, visibility }, f); toast(`Uploaded ${f.name}`); onChange(); } catch (ex) { toast((ex as Error).message, 'error'); } finally { setBusy(false); }
  };
  const canArchive = (d: DirectoryDocument) => !archived && (d.project_id ? writableProjects.some((p) => p.id === d.project_id) : canUploadShared);
  const groups: Array<[string, DirectoryDocument[]]> = [
    ['Shared company documents', documents.filter((d) => !d.project_id)],
    ...[...new Set(documents.filter((d) => d.project_id).map((d) => d.project_code ?? ''))].map((code) => [`Project documents — ${code}`, documents.filter((d) => d.project_code === code)] as [string, DirectoryDocument[]]),
  ];
  return (
    <div className="space-y-3">
      {canUpload && (
        <div className="flex flex-wrap items-center gap-2 border border-slate-200 rounded-lg p-2 bg-slate-50/60">
          <select aria-label="Who can see the document" className={`${inputCls} !w-auto !py-1 !text-xs`} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            {canUploadShared && <option value="shared">Shared (all projects that use this entry)</option>}
            {projectChoices.map((p) => <option key={p.id} value={p.id}>Only project {p.code}</option>)}
          </select>
          <select aria-label="Document type" className={`${inputCls} !w-auto !py-1 !text-xs`} value={kind} onChange={(e) => setKind(e.target.value)}>
            {DIRECTORY_DOCUMENT_KINDS.map((k) => <option key={k} value={k}>{DIRECTORY_DOCUMENT_KIND_LABELS[k]}</option>)}
          </select>
          <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx" onChange={onFile} />
          <Button size="sm" variant="primary" busy={busy} disabled={!visibility} onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5" />Upload</Button>
        </div>
      )}
      {!canUploadShared && canUpload && <p className="text-[11px] text-slate-500">Only an admin adds shared company documents. Project documents are visible only to that project.</p>}
      {groups.map(([title, list]) => (
        <section key={title}>
          <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1">{title.startsWith('Shared') ? <Share2 className="w-3 h-3" /> : <Lock className="w-3 h-3" />}{title}</h4>
          {list.length === 0 ? <p className="text-xs text-slate-500">None.</p> : (
            <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
              {list.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">{d.original_name}</div>
                      <div className="text-[10px] text-slate-500">{DIRECTORY_DOCUMENT_KIND_LABELS[d.kind as keyof typeof DIRECTORY_DOCUMENT_KIND_LABELS] ?? d.kind} · {formatBytes(d.size_bytes)} · {formatDateTime(d.created_at)}{d.uploaded_by_name ? ` by ${d.uploaded_by_name}` : ''}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {PREVIEWABLE_MIME_TYPES.includes(d.mime_type) && <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`${base}/${d.id}/download?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`View ${d.original_name}`} title="View in a new tab"><Eye className="w-3.5 h-3.5" /></a>}
                    <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`${base}/${d.id}/download`} aria-label={`Download ${d.original_name}`} title="Download"><Download className="w-3.5 h-3.5" /></a>
                    {canArchive(d) && <button type="button" className="p-1.5 text-slate-400 hover:text-rose-600" aria-label={`Archive ${d.original_name}`} title="Archive"
                      onClick={async () => { if (await confirm(<>Archive <b>{d.original_name}</b>? It is kept for audit.</>, { title: 'Archive document', confirmLabel: 'Archive', danger: true })) { try { await post(`${base}/${d.id}/archive`); onChange(); } catch (ex) { toast((ex as Error).message, 'error'); } } }}><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className="text-[11px] text-slate-500">Signed project contracts stay in Contracts &amp; Documents — see Related records.</p>
    </div>
  );
}
