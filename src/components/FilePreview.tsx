import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Download, ExternalLink, Eye, Loader2, X } from 'lucide-react';
import { PREVIEWABLE_MIME_TYPES } from '../../shared/constants';
import { useDialogLayer } from './ui';
import { PdfViewer } from './PdfViewer';

export interface PreviewFile {
  /** authorised download URL of the file (same origin; the session cookie is the only credential) */
  href: string;
  name: string;
  mime: string;
}
const inlineUrl = (href: string) => `${href}${href.includes('?') ? '&' : '?'}inline=1`;
export const canPreview = (mime: string) => PREVIEWABLE_MIME_TYPES.includes(mime);

/**
 * In-app preview of a PDF or image, shared by every attachment list. PDFs are drawn by PDF.js inside the page
 * (no frame, no browser plugin), so desktop and mobile behave the same. Files come from their existing authorised
 * URL (no token in the URL, nothing made public, nothing cached by the service worker). The page,
 * filters, scroll position and any open form underneath stay as they are; closing returns focus to View.
 */
export function FilePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogLayer(true, ref, onClose, '[data-autofocus]');
  const url = inlineUrl(file.href);
  const isPdf = file.mime === 'application/pdf';
  const [state, setState] = useState<'checking' | 'loading' | 'ready' | 'error'>('checking');
  const [error, setError] = useState('');

  // Check access and availability first, so a clear message is shown instead of a blank frame.
  useEffect(() => {
    const ctl = new AbortController();
    fetch(url, { credentials: 'same-origin', signal: ctl.signal, headers: { Accept: '*/*' } })
      .then((r) => {
        ctl.abort(); // headers are enough; the viewer loads the file itself
        if (r.status === 401) throw new Error('Your session has ended. Sign in again to view this file.');
        if (r.status === 403) throw new Error('Your account does not have access to this file.');
        if (r.status === 404) throw new Error('This file is not available. It may have been archived or is missing from storage.');
        if (!r.ok) throw new Error('The file could not be loaded.');
        if (!(r.headers.get('content-disposition') ?? '').startsWith('inline')) throw new Error('This file cannot be shown in the browser. Download it to open it.');
        setState('loading');
      })
      .catch((e: Error) => { if (e.name === 'AbortError') return; setError(e.message); setState('error'); });
    return () => ctl.abort();
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const btn = 'inline-flex items-center gap-1.5 min-h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 no-underline';
  const fallback = (msg: React.ReactNode) => (
    <div className="h-full grid place-items-center p-6 text-center" role="status">
      <div className="max-w-sm space-y-3">
        <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" aria-hidden="true" />
        <p className="text-sm text-slate-700">{msg}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <a className={btn} href={file.href}><Download className="w-4 h-4" />Download</a>
          <a className={btn} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4" />Open in new tab</a>
        </div>
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center sm:p-4 bg-slate-900/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`Preview: ${file.name}`} tabIndex={-1} data-testid="file-preview"
        className="w-full h-full sm:h-[92vh] sm:max-w-6xl flex flex-col bg-white sm:rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-slate-100">
          <h2 className="flex-1 min-w-0 text-sm font-bold text-slate-900 truncate" title={file.name}><span dir="auto"><bdi>{file.name}</bdi></span></h2>
          <a className={btn} href={file.href} aria-label={`Download ${file.name}`}><Download className="w-4 h-4" /><span className="hidden sm:inline">Download</span></a>
          <a className={btn} href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${file.name} in a new tab`}><ExternalLink className="w-4 h-4" /><span className="hidden sm:inline">Open in new tab</span></a>
          <button type="button" data-autofocus onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100" aria-label="Close preview"><X className="w-5 h-5" /></button>
        </div>
        <div className="relative flex-1 min-h-0 bg-slate-100 overscroll-contain">
          {state === 'error' ? fallback(error)
            : state === 'checking' ? null
            : isPdf ? (
              <PdfViewer url={url} title={`PDF: ${file.name}`} onError={(m) => { setError(m); setState('error'); }} />
            ) : (
              <div className="absolute inset-0 overflow-auto overscroll-contain grid place-items-center p-3">
                <img src={url} alt={file.name} className="max-w-full h-auto shadow" onLoad={() => setState('ready')} onError={() => { setError('The image could not be shown.'); setState('error'); }} />
              </div>
            )}
          {(state === 'checking' || (state === 'loading' && !isPdf)) && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none" role="status" aria-live="polite">
              <span className="inline-flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2 text-sm text-slate-600 shadow-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading preview…</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "View" button that opens the shared in-app preview. Only rendered for previewable types. */
export function PreviewButton({ file, className = 'p-1.5 text-slate-500 hover:text-sky-700', iconClass = 'w-3.5 h-3.5' }: { file: PreviewFile; className?: string; iconClass?: string }) {
  const [open, setOpen] = useState(false);
  if (!canPreview(file.mime)) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="View" aria-label={`View ${file.name}`} aria-haspopup="dialog"><Eye className={iconClass} /></button>
      {open && <FilePreview file={file} onClose={() => setOpen(false)} />}
    </>
  );
}
