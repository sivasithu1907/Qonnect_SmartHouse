import React, { useRef, useState } from 'react';
import { Download, FileText, Paperclip, Pencil, Trash2, Upload, Wand2 } from 'lucide-react';
import { PreviewButton } from './FilePreview';
import { patch, post, upload } from '../lib/api';
import { useApi } from '../lib/hooks';
import { formatBytes, formatDateTime } from '../lib/format';
import { ATTACHMENT_KIND_LABELS, attachmentKindsFor, type AttachmentEntityType, type AttachmentKind } from '../../shared/constants';
import { Button, inputCls, useUi } from './ui';

export interface Att {
  id: string; kind: string; original_name: string; display_name: string | null; name: string; description: string;
  mime_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null; suggested_name: string | null;
}

export const kindLabel = (k: string) => ATTACHMENT_KIND_LABELS[k as AttachmentKind] ?? k;

/**
 * A file name in any language. `dir="auto"` lets Arabic names read right-to-left inside an otherwise
 * left-to-right interface; `bdi` keeps punctuation and extensions in the right place.
 */
export function FileName({ name, className = '' }: { name: string; className?: string }) {
  return <span dir="auto" className={`break-words ${className}`} title={name}><bdi>{name}</bdi></span>;
}

/** Private file list + upload for one record. Downloads go through the authorised API. */
export function Attachments({ projectId, entityType, entityId, defaultKind, canUpload, onChange, canArchive, title = 'Secure files', hint, noUpload }: {
  projectId: string; entityType: AttachmentEntityType; entityId: string; defaultKind: AttachmentKind; canUpload: boolean; onChange?: () => void;
  /** per-file archive permission (defaults to canUpload); the server enforces the same rule */
  canArchive?: (a: { kind: string }) => boolean; title?: string; hint?: React.ReactNode;
  /** manage existing files (rename / archive) but hide the upload control */
  noUpload?: boolean;
}) {
  const kinds = attachmentKindsFor(entityType);
  const base = `/api/projects/${projectId}/attachments`;
  const { data, reload, error } = useApi<Att[]>(`${base}?entity_type=${entityType}&entity_id=${entityId}`);
  const [kind, setKind] = useState<string>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
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
    if (!(await confirm(<>Archive <b><FileName name={a.name} /></b>? It will no longer be listed or downloadable. The stored file is retained for audit.</>, { title: 'Archive file', confirmLabel: 'Archive', danger: true }))) return;
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
        <span className="text-xs font-bold text-slate-700 flex items-center gap-1"><Paperclip className="w-3.5 h-3.5" /> {title}{data && data.length > 0 && <span className="font-normal text-slate-500">· {data.length} file{data.length === 1 ? '' : 's'}</span>}</span>
        {canUpload && !noUpload && (
          <div className="flex items-center gap-2">
            <select className={`${inputCls} !py-1 !text-xs !w-auto`} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type">
              {kinds.map((k) => <option key={k} value={k}>{ATTACHMENT_KIND_LABELS[k]}</option>)}
            </select>
            <input ref={fileRef} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx" onChange={onFile} />
            <Button size="sm" variant="primary" busy={busy} onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5" />Upload</Button>
          </div>
        )}
      </div>
      {hint && <div className="text-[11px] text-slate-500 mb-2">{hint}</div>}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {!data ? <p className="text-xs text-slate-400">Loading…</p> : data.length === 0 ? (
        <p className="text-xs text-slate-500">No files uploaded. Allowed: PDF, JPG, PNG, WEBP, HEIC, DOCX, XLSX.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.map((a) => (
            <li key={a.id} className="py-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800"><FileName name={a.name} /></div>
                    <div className="text-[10px] text-slate-500"><span className="font-semibold text-slate-600">{kindLabel(a.kind)}</span> · {formatBytes(a.size_bytes)} · Uploaded {formatDateTime(a.created_at)}{a.uploaded_by_name ? ` by ${a.uploaded_by_name}` : ''}</div>
                    {a.display_name && <div className="text-[10px] text-slate-400">Original file name: <FileName name={a.original_name} /></div>}
                    {a.description && <p className="text-[11px] text-slate-600 whitespace-pre-wrap break-words mt-0.5">{a.description}</p>}
                    {a.suggested_name && canUpload && editing !== a.id && (
                      <p className="text-[11px] text-amber-800 mt-0.5 flex flex-wrap items-center gap-1">
                        <Wand2 className="w-3 h-3" />This name looks garbled. Likely original: <b><FileName name={a.suggested_name} /></b>
                        <button type="button" className="underline font-semibold" onClick={async () => {
                          try { await patch(`${base}/${a.id}`, { display_name: a.suggested_name }); toast('Display name updated (the original name is kept)'); await reload(); onChange?.(); } catch (e) { toast((e as Error).message, 'error'); }
                        }}>Use it</button>
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <PreviewButton file={{ href: `${base}/${a.id}/download`, name: a.name, mime: a.mime_type }} />
                  <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`${base}/${a.id}/download`} title="Download" aria-label={`Download ${a.name}`}><Download className="w-3.5 h-3.5" /></a>
                  {canUpload && <button type="button" className="p-1.5 text-slate-500 hover:text-sky-700" onClick={() => setEditing(editing === a.id ? null : a.id)} title="Rename / describe" aria-label={`Rename or describe ${a.name}`}><Pencil className="w-3.5 h-3.5" /></button>}
                  {canUpload && (canArchive ? canArchive(a) : true) && <button type="button" className="p-1.5 text-slate-400 hover:text-rose-600" onClick={() => archive(a)} title="Archive" aria-label={`Archive ${a.name}`}><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              </div>
              {editing === a.id && (
                <FileDetailsForm a={a} kinds={kinds} onCancel={() => setEditing(null)} onSave={async (v) => {
                  try { await patch(`${base}/${a.id}`, v); toast('File details saved'); setEditing(null); await reload(); onChange?.(); } catch (e) { toast((e as Error).message, 'error'); }
                }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileDetailsForm({ a, kinds, onSave, onCancel }: { a: Att; kinds: readonly AttachmentKind[]; onSave: (v: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(a.display_name ?? a.suggested_name ?? '');
  const [desc, setDesc] = useState(a.description ?? '');
  const [kind, setKind] = useState(a.kind);
  const [busy, setBusy] = useState(false);
  return (
    <form className="mt-2 ml-6 grid gap-2 sm:grid-cols-2 rounded-lg border border-slate-200 bg-white p-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try { await onSave({ display_name: name.trim() || null, description: desc, ...(kind !== a.kind ? { kind } : {}) }); } finally { setBusy(false); }
    }}>
      <label className="text-[11px] font-semibold text-slate-600">Display name
        <input dir="auto" className={`${inputCls} mt-0.5 !text-xs`} value={name} placeholder={a.original_name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        <span className="block font-normal text-slate-400">Leave blank to use the original name. The stored file and its links never change.</span>
      </label>
      <label className="text-[11px] font-semibold text-slate-600">Document type
        <select className={`${inputCls} mt-0.5 !text-xs`} value={kind} onChange={(e) => setKind(e.target.value)}>
          {(kinds.includes(a.kind as AttachmentKind) ? kinds : [a.kind as AttachmentKind, ...kinds]).map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
      </label>
      <label className="sm:col-span-2 text-[11px] font-semibold text-slate-600">Description / notes
        <textarea dir="auto" rows={2} className={`${inputCls} mt-0.5 !text-xs`} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />
      </label>
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" type="submit" variant="primary" busy={busy}>Save</Button>
      </div>
    </form>
  );
}
