import React, { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

/**
 * Keyboard-accessible explanation: a button that toggles a small panel (click / Enter / Space),
 * closed with Escape or by clicking elsewhere. The text is never only in a hover tooltip.
 */
export function InfoPopover({ label, children, align = 'left' }: { label: string; children: React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex align-middle">
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        className="inline-grid place-items-center w-6 h-6 rounded-full text-slate-400 hover:text-sky-700 hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-sky-500">
        <Info className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span id={id} role="note"
          className={`absolute z-30 top-full mt-1 w-72 max-w-[80vw] rounded-lg border border-slate-200 bg-white p-3 text-xs font-normal normal-case tracking-normal leading-relaxed text-slate-700 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children}
        </span>
      )}
    </span>
  );
}
