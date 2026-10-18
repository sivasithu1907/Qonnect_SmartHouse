import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Maximize2, Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Renders a PDF inside the page with PDF.js (no browser plugin, no frame), so the same viewer works on desktop and
 * mobile: vertical scrolling, zoom and page navigation. The file is read from its authorised URL with the session
 * cookie; nothing is cached, nothing is made public, and the PDF's own scripts never run.
 */
export function PdfViewer({ url, title, onError }: { url: string; title: string; onError: (message: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);

  // load the library on demand (keeps it out of the main bundle) and open the document
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(res.status === 401 ? 'Your session has ended. Sign in again to view this file.' : res.status === 403 ? 'Your account does not have access to this file.' : 'The file could not be loaded.');
        const data = new Uint8Array(await res.arrayBuffer());
        loaded = await pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
        const s: Array<{ w: number; h: number }> = [];
        for (let i = 1; i <= loaded.numPages; i++) {
          const v = (await loaded.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: v.width, h: v.height });
        }
        if (cancelled) { void loaded.destroy(); return; }
        setSizes(s);
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) onError((e as Error).message?.includes('Invalid PDF') ? 'This PDF could not be read. Download it to open it in another app.' : (e as Error).message || 'The PDF could not be shown.');
      }
    })();
    return () => { cancelled = true; if (loaded) void loaded.destroy(); };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  // container width for "fit to width"
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const widest = Math.max(1, ...sizes.map((s) => s.w));
  // fit to width, but never larger than 150% by default (wide desktop screens)
  const scale = zoom === 'fit' ? Math.max(0.2, Math.min(1.5, (width - 32) / widest)) : zoom;
  const setZoomStep = (dir: 1 | -1) => setZoom((z) => {
    const cur = z === 'fit' ? scale : z;
    return Math.min(4, Math.max(0.25, Math.round((cur + dir * 0.25) * 4) / 4));
  });

  // current page = the page nearest the top of the scroll area
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const pages = [...el.querySelectorAll<HTMLElement>('[data-page]')];
    const top = el.scrollTop + 40;
    let cur = 1;
    for (const p of pages) if (p.offsetTop <= top) cur = Number(p.dataset.page);
    setPage(cur);
  }, []);
  const goTo = (n: number) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
  };

  const btn = 'p-1.5 rounded-md text-slate-200 hover:bg-white/10 disabled:opacity-40';
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0 flex items-center justify-center gap-1 sm:gap-2 px-2 py-1.5 bg-slate-700 text-slate-100 text-xs" role="toolbar" aria-label="PDF controls">
        <button type="button" className={btn} onClick={() => goTo(page - 1)} disabled={!doc || page <= 1} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
        <span className="tabular-nums min-w-[4.5rem] text-center" aria-live="polite">{doc ? `${page} / ${doc.numPages}` : '…'}</span>
        <button type="button" className={btn} onClick={() => goTo(page + 1)} disabled={!doc || page >= (doc?.numPages ?? 1)} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
        <span className="w-px h-4 bg-white/20 mx-1" aria-hidden="true" />
        <button type="button" className={btn} onClick={() => setZoomStep(-1)} disabled={!doc} aria-label="Zoom out"><Minus className="w-4 h-4" /></button>
        <span className="tabular-nums w-11 text-center">{Math.round(scale * 100)}%</span>
        <button type="button" className={btn} onClick={() => setZoomStep(1)} disabled={!doc} aria-label="Zoom in"><Plus className="w-4 h-4" /></button>
        <button type="button" className={btn} onClick={() => setZoom('fit')} disabled={!doc || zoom === 'fit'} aria-label="Fit to width" title="Fit to width"><Maximize2 className="w-4 h-4" /></button>
      </div>
      <div ref={box} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-auto overscroll-contain bg-slate-500/90 py-3" role="document" aria-label={title} data-testid="pdf-pages">
        {!doc ? (
          <div className="h-full grid place-items-center"><span className="inline-flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2 text-sm text-slate-600 shadow-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading PDF…</span></div>
        ) : sizes.map((s, i) => <PdfPage key={i} doc={doc} n={i + 1} w={s.w} h={s.h} scale={scale} root={box} />)}
      </div>
    </div>
  );
}

/** One page: a placeholder of the right size, rendered to a canvas when it scrolls near the view. */
function PdfPage({ doc, n, w, h, scale, root }: { doc: PDFDocumentProxy; n: number; w: number; h: number; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setVisible(true); }, { root: root.current, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let stop = false;
    (async () => {
      const p = await doc.getPage(n);
      if (stop || !canvas.current) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = p.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      await task.promise.catch(() => undefined);
    })();
    return () => { stop = true; task?.cancel(); };
  }, [visible, scale, doc, n]);
  return (
    <div ref={holder} data-page={n} className="mx-auto mb-3 bg-white shadow-md" style={{ width: Math.floor(w * scale), height: Math.floor(h * scale) }}>
      <canvas ref={canvas} className="block w-full h-full" aria-label={`Page ${n}`} />
    </div>
  );
}
