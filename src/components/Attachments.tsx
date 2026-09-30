import React, { useRef, useState } from 'react';
import { Download, Eye, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { post, upload } from '../lib/api';
import { useApi } from '../lib/hooks';
import { formatBytes, formatDateTime } from '../lib/format';
import { ATTACHMENT_KIND_LABELS, ATTACHMENT_KINDS, type AttachmentEntityType } from '../../shared/constants';
import { Button, inputCls, useUi } from './ui';

interface Att { id: string; kind: string; original_name: string; mime_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null }

/** Private file list + upload for one record. Downloads go through the authorised API. */
export function Attachments({ projectId, entityType, entityId, defaultKind, canUpload, onChange }: {
  projectId: string; entityType: AttachmentEntityType; entityId: string; defaultKind: (typeof ATTACHMENT_KINDS)[number]; canUpload: boolean; onChange?: () => void;
}) {
  const base = `/api/projects/${projectId}/attachments`;
  const { data, reload, error } = useApi<Att[]>(`${base}?entity_type=${entityType}&entity_id=${entityId}`);
  const [kind, setKind] = useState<string>(defaultKind);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast, confirm } = useUi();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      await upload(base, { entity_type: entityType, entity_id: entityId, kind }, f);
      toast(`Uploaded ${f.name}`);
      await reload();
      onChange?.();
    } catch (ex) {
      toast((ex as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (a: Att) => {
    if (!(await confirm(<>Archive <b>{a.original_name}</b>? It will no longer be listed or downloadable. The stored file is retained for audit.</>, { title: 'Archive file', confirmLabel: 'Archive', danger: true }))) return;
    try {
      await post(`${base}/${a.id}/archive`);
      await reload();
      onChange?.();
    } catch (ex) {
      toast((ex as Error).message, 'error');
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-xs font-bold text-slate-700 flex items-center gap-1"><Paperclip className="w-3.5 h-3.5" /> Secure files</span>
        {canUpload && (
          <div className="flex items-center gap-2">
            <select className={`${inputCls} !py-1 !text-xs !w-auto`} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="File type">
              {ATTACHMENT_KINDS.map((k) => <option key={k} value={k}>{ATTACHMENT_KIND_LABELS[k]}</option>)}
            </select>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx" onChange={onFile} />
            <Button size="sm" variant="primary" busy={busy} onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5" />Upload</Button>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {!data ? <p className="text-xs text-slate-400">Loading…</p> : data.length === 0 ? (
        <p className="text-xs text-slate-500">No files uploaded. Allowed: PDF, JPG, PNG, WEBP, HEIC, DOCX, XLSX.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-800 truncate">{a.original_name}</div>
                  <div className="text-[10px] text-slate-500">{ATTACHMENT_KIND_LABELS[a.kind as keyof typeof ATTACHMENT_KIND_LABELS]} · {formatBytes(a.size_bytes)} · {formatDateTime(a.created_at)}{a.uploaded_by_name ? ` · ${a.uploaded_by_name}` : ''}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(a.mime_type) && (
                  <a className="p-1 text-slate-500 hover:text-sky-700" href={`${base}/${a.id}/download?inline=1`} target="_blank" rel="noopener noreferrer" title="View"><Eye className="w-3.5 h-3.5" /></a>
                )}
                <a className="p-1 text-slate-500 hover:text-sky-700" href={`${base}/${a.id}/download`} title="Download"><Download className="w-3.5 h-3.5" /></a>
                {canUpload && <button className="p-1 text-slate-400 hover:text-rose-600" onClick={() => archive(a)} title="Archive"><Trash2 className="w-3.5 h-3.5" /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
