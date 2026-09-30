import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, X } from 'lucide-react';
import { fromLocalInput, toLocalInput } from '../lib/format';

// ------------------------------------------------------------------ primitives
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-700 border border-sky-600 shadow-xs',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 shadow-2xs',
  danger: 'bg-white text-rose-700 hover:bg-rose-50 border border-rose-200',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border border-transparent',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-600',
};

export function Button({ variant = 'secondary', size = 'md', className = '', busy, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-xs sm:text-sm'
      } ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className = '', children, title, actions, subtitle }: { className?: string; children: React.ReactNode; title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className={`bg-white rounded-xl border border-slate-200 shadow-2xs ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-4 pb-3 border-b border-slate-100">
          <div>
            {title && <h3 className="text-sm font-bold text-slate-900">{title}</h3>}
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-6">
      <div className="flex items-start gap-3">
        {icon && <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600 shrink-0">{icon}</div>}
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
          {subtitle && <div className="text-xs sm:text-sm text-slate-500 mt-1">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'slate' | 'sky' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'violet';
const TONES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  sky: 'bg-sky-50 text-sky-800 border-sky-200',
  emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  amber: 'bg-amber-50 text-amber-800 border-amber-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
};
export function Badge({ tone = 'slate', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}
export const NeedsConfirmation = ({ label = 'Needs confirmation' }: { label?: string }) => <Badge tone="amber">{label}</Badge>;

export function statusTone(s: string): Tone {
  if (/overdue|delayed|rejected|blocked|overpaid|cancel/i.test(s)) return 'rose';
  if (/paid$|^paid|completed|delivered|accepted|passed|closed|approved|reviewed/i.test(s)) return 'emerald';
  if (/partial|progress|dispatched|production|ordered|scheduled|inspection/i.test(s)) return 'sky';
  if (/not confirmed|needs|awaiting|quotation|pending|planned|hold|unpaid|open/i.test(s)) return 'amber';
  return 'slate';
}
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={statusTone(status)}>{status}</Badge>;

export function Kpi({ label, value, hint, icon, tone = 'slate', onClick }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'slate' | 'emerald' | 'sky' | 'amber' | 'rose'; onClick?: () => void }) {
  const color = { slate: 'text-slate-900', emerald: 'text-emerald-700', sky: 'text-sky-700', amber: 'text-amber-800', rose: 'text-rose-700' }[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={`text-left bg-white rounded-xl border border-slate-200 p-4 shadow-2xs flex flex-col gap-1 ${onClick ? 'hover:border-sky-300 transition-colors' : ''}`}>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-medium">{label}</span>
        {icon}
      </div>
      <div className={`text-lg sm:text-xl font-bold font-mono ${color}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </Tag>
  );
}

export function EmptyState({ title = 'No records yet', children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="text-center py-10 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/60">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children && <div className="text-xs text-slate-500 mt-1">{children}</div>}
    </div>
  );
}

export function Notice({ tone = 'amber', children, title }: { tone?: 'amber' | 'sky' | 'rose' | 'emerald'; title?: string; children: React.ReactNode }) {
  const styles = {
    amber: 'bg-amber-50/70 border-amber-200 text-amber-900',
    sky: 'bg-sky-50/70 border-sky-200 text-sky-900',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  }[tone];
  const Icon = tone === 'rose' ? AlertTriangle : tone === 'emerald' ? CheckCircle2 : tone === 'sky' ? Info : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 text-xs border rounded-lg p-3 ${styles}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div>{title && <span className="font-semibold">{title} </span>}{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" />{label}</div>;
}

export function LinkButton({ href, label, icon, emptyLabel = 'Link not set', tone = 'sky' }: { href: string; label: string; icon?: React.ReactNode; emptyLabel?: string; tone?: 'sky' | 'emerald' }) {
  if (!href) {
    return <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-md" title={emptyLabel}>{icon}{label}<span className="text-[10px]">· {emptyLabel}</span></span>;
  }
  const t = tone === 'emerald' ? 'text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-200' : 'text-sky-800 bg-sky-50 hover:bg-sky-100 border-sky-200';
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border rounded-md transition-colors ${t}`}>
      {icon}<span>{label}</span><ExternalLink className="w-3 h-3 opacity-60" />
    </a>
  );
}

// ------------------------------------------------------------------ modal & confirm
// Body scroll lock shared by nested dialogs (e.g. a confirm dialog over a form).
let bodyLocks = 0;
function lockBodyScroll() {
  if (bodyLocks++ === 0) {
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  }
}
function unlockBodyScroll() {
  if (bodyLocks > 0 && --bodyLocks === 0) {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

/**
 * Dialog that always fits the viewport: the title bar stays fixed, the content scrolls inside
 * the dialog, and the page behind it cannot scroll while it is open. Forms rendered with
 * RecordForm keep their Save / Cancel bar pinned to the bottom of the dialog.
 */
export function Modal({ open, title, onClose, children, wide, subtitle }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    lockBodyScroll();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[data-autofocus],input:not([type=hidden]),select,textarea,button:not([aria-label=Close])')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      unlockBodyScroll();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-6 bg-slate-900/40 backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} max-h-full flex flex-col bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden`}>
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-4 pb-4" data-modal-body>{children}</div>
      </div>
    </div>
  );
}

interface ConfirmOpts { title?: string; confirmLabel?: string; danger?: boolean }
interface UiCtx {
  confirm: (message: React.ReactNode, opts?: ConfirmOpts) => Promise<boolean>;
  toast: (message: string, tone?: 'success' | 'error') => void;
}
const Ctx = createContext<UiCtx | null>(null);
export const useUi = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('UiProvider missing');
  return c;
};

export function UiProvider({ children }: { children: React.ReactNode }) {
  const [dlg, setDlg] = useState<{ message: React.ReactNode; opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: 'success' | 'error' }>>([]);
  const confirm = useCallback((message: React.ReactNode, opts: ConfirmOpts = {}) => new Promise<boolean>((resolve) => setDlg({ message, opts, resolve })), []);
  const toast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const value = useMemo(() => ({ confirm, toast }), [confirm, toast]);
  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal open={!!dlg} title={dlg?.opts.title ?? 'Please confirm'} onClose={() => close(false)}>
        <div className="text-sm text-slate-700">{dlg?.message}</div>
        <div className="flex justify-end gap-2 mt-5">
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={dlg?.opts.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{dlg?.opts.confirmLabel ?? 'Confirm'}</Button>
        </div>
      </Modal>
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium border ${t.tone === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-white border-emerald-200 text-emerald-800'}`}>{t.message}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

// ------------------------------------------------------------------ generic record form
export interface Option { value: string; label: string; group?: string }
export type FieldType = 'searchselect' | 'password' | 'text' | 'textarea' | 'number' | 'money' | 'date' | 'datetime' | 'select' | 'checkbox' | 'url' | 'multiselect';
export interface FieldSpec {
  name: string;
  label: string;
  type?: FieldType;
  options?: Option[];
  required?: boolean;
  help?: string;
  placeholder?: string;
  wide?: boolean;
  disabled?: boolean;
  nullable?: boolean; // select: '' → null
  hidden?: boolean;
}

type Values = Record<string, any>;
function toInput(f: FieldSpec, v: any): any {
  const t = f.type ?? 'text';
  if (t === 'checkbox') return !!v;
  if (t === 'multiselect') return Array.isArray(v) ? v : [];
  if (t === 'datetime') return toLocalInput(v);
  if (v === null || v === undefined) return '';
  return String(v);
}
function fromInput(f: FieldSpec, v: any): any {
  const t = f.type ?? 'text';
  if (t === 'checkbox') return !!v;
  if (t === 'multiselect') return v;
  if (t === 'number' || t === 'money') return v === '' ? null : Number(v);
  if (t === 'date') return v === '' ? null : v;
  if (t === 'datetime') return fromLocalInput(v);
  if ((t === 'select' || t === 'searchselect') && f.nullable) return v === '' ? null : v;
  return typeof v === 'string' ? v.trim() : v;
}

/** Renders <option>s, grouped in <optgroup>s when options carry a group. */
export function OptionList({ options }: { options: Option[] }) {
  if (!options.some((o) => o.group)) return <>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</>;
  const groups: Array<[string, Option[]]> = [];
  for (const o of options) {
    const g = o.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(o); else groups.push([g, [o]]);
  }
  return <>{groups.map(([g, os]) => <optgroup key={g} label={g}>{os.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>)}</>;
}

/**
 * Searchable single-select. The list opens inline (inside scrolling dialogs it is never
 * clipped); type to filter by label or group, arrow keys + Enter to choose, Escape to close.
 */
export function SearchSelect({ id, value, onChange, options, disabled, nullable, noneLabel = '— None —', searchPlaceholder = 'Type to search…' }: {
  id?: string; value: string; onChange: (v: string) => void; options: Option[]; disabled?: boolean; nullable?: boolean; noneLabel?: string; searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = options.filter((o) => {
    const hay = `${o.label} ${o.group ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const list: Option[] = nullable && !q ? [{ value: '', label: noneLabel }, ...matches] : matches;
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => { setActive(0); }, [q, open]);
  const choose = (v: string) => { onChange(v); setOpen(false); setQ(''); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[active]) choose(list[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  let lastGroup: string | undefined;
  return (
    <div ref={boxRef}>
      <button id={id} type="button" disabled={disabled} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}
        className={`${inputCls} text-left flex items-center justify-between gap-2`}>
        <span className={`truncate ${selected ? '' : 'text-slate-400'}`}>{selected ? selected.label : noneLabel}</span>
        <span className="text-slate-400 text-xs shrink-0">▾</span>
      </button>
      {open && (
        <div className="mt-1 border border-slate-200 rounded-lg bg-white shadow-sm">
          <input autoFocus className={`${inputCls} !border-0 !border-b !rounded-b-none !ring-0`} placeholder={searchPlaceholder}
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search options" />
          <ul role="listbox" className="max-h-56 overflow-y-auto py-1 text-sm">
            {list.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">No matches</li>}
            {list.map((o, i) => {
              const header = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <React.Fragment key={o.value || '__none'}>
                  {header && <li className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">{header}</li>}
                  <li role="option" aria-selected={o.value === value}
                    onMouseDown={(e) => { e.preventDefault(); choose(o.value); }} onMouseEnter={() => setActive(i)}
                    className={`px-3 py-1.5 cursor-pointer ${i === active ? 'bg-sky-50 text-sky-900' : 'text-slate-800'} ${o.value === value ? 'font-semibold' : ''} ${o.value === '' ? 'text-slate-400' : ''}`}>
                    {o.label}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export const inputCls = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500/30 focus:border-sky-400 disabled:bg-slate-50 disabled:text-slate-500';

/**
 * Renders a form from field specs. In edit mode (initial provided) only changed
 * fields are submitted, so role-restricted fields are never sent unintentionally.
 */
export function RecordForm({ fields, initial, onSubmit, onCancel, submitLabel = 'Save', mode = initial ? 'edit' : 'create', extra }: {
  fields: FieldSpec[]; initial?: Values | null; onSubmit: (v: Values) => Promise<void>; onCancel: () => void; submitLabel?: string; mode?: 'create' | 'edit'; extra?: React.ReactNode;
}) {
  const visible = fields.filter((f) => !f.hidden);
  const start = useMemo(() => Object.fromEntries(visible.map((f) => [f.name, toInput(f, initial?.[f.name])])), [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const [vals, setVals] = useState<Values>(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setVals((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    for (const f of visible) {
      if (f.required && !f.disabled && (vals[f.name] === '' || vals[f.name] === null)) { setErr(`${f.label} is required`); return; }
      if (f.type === 'url' && vals[f.name] && !/^https?:\/\//i.test(vals[f.name])) { setErr(`${f.label} must start with https://`); return; }
    }
    const out: Values = {};
    for (const f of visible) {
      if (f.disabled) continue;
      const nv = fromInput(f, vals[f.name]);
      if (mode === 'edit') {
        const ov = fromInput(f, start[f.name]);
        if (JSON.stringify(nv) === JSON.stringify(ov)) continue;
      }
      out[f.name] = nv;
    }
    setBusy(true);
    try {
      await onSubmit(out);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {visible.map((f) => {
          const t = f.type ?? 'text';
          const id = `f-${f.name}`;
          const wide = f.wide || t === 'textarea' || t === 'multiselect';
          return (
            <div key={f.name} className={wide ? 'sm:col-span-2' : ''}>
              {t === 'checkbox' ? (
                <label className="flex items-center gap-2 text-sm text-slate-700 mt-5">
                  <input type="checkbox" checked={!!vals[f.name]} disabled={f.disabled} onChange={(e) => set(f.name, e.target.checked)} className="rounded border-slate-300" />
                  {f.label}
                </label>
              ) : (
                <>
                  <label htmlFor={id} className="block text-xs font-semibold text-slate-600 mb-1">{f.label}{f.required && <span className="text-rose-500"> *</span>}</label>
                  {t === 'textarea' ? (
                    <textarea id={id} rows={3} className={inputCls} value={vals[f.name]} disabled={f.disabled} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
                  ) : t === 'select' ? (
                    <select id={id} className={inputCls} data-empty={vals[f.name] === ''} value={vals[f.name]} disabled={f.disabled} onChange={(e) => set(f.name, e.target.value)}>
                      {f.nullable && <option value="">— None —</option>}
                      <OptionList options={f.options ?? []} />
                    </select>
                  ) : t === 'searchselect' ? (
                    <SearchSelect id={id} value={vals[f.name]} disabled={f.disabled} nullable={f.nullable} options={f.options ?? []} onChange={(v) => set(f.name, v)} />
                  ) : t === 'multiselect' ? (
                    <select id={id} multiple className={`${inputCls} h-32`} value={vals[f.name]} disabled={f.disabled}
                      onChange={(e) => set(f.name, Array.from(e.target.selectedOptions).map((o) => o.value))}>
                      <OptionList options={f.options ?? []} />
                    </select>
                  ) : (
                    <input
                      id={id}
                      className={inputCls}
                      type={t === 'money' || t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'datetime' ? 'datetime-local' : t === 'url' ? 'url' : t === 'password' ? 'password' : 'text'}
                      step={t === 'money' ? '0.01' : t === 'number' ? 'any' : undefined}
                      min={t === 'money' || t === 'number' ? 0 : undefined}
                      value={vals[f.name]}
                      data-empty={vals[f.name] === ''}
                      disabled={f.disabled}
                      placeholder={f.placeholder ?? (t === 'url' ? 'https://' : undefined)}
                      onChange={(e) => set(f.name, e.target.value)}
                    />
                  )}
                </>
              )}
              {f.help && <p className="text-[11px] text-slate-500 mt-1">{f.help}</p>}
            </div>
          );
        })}
      </div>
      {extra}
      {err && <Notice tone="rose">{err}</Notice>}
      <div className="sticky bottom-0 z-10 -mx-5 px-5 py-3 -mb-4 flex justify-end gap-2 bg-white/95 backdrop-blur-sm border-t border-slate-100" data-form-actions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}

export function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 whitespace-nowrap ${className}`}>{children}</th>;
}
export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-xs text-slate-700 align-top ${className}`}>{children}</td>;
}
export function Table({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto -mx-4"><table className="min-w-full divide-y divide-slate-100">{children}</table></div>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: string; count?: number }> }) {
  return (
    <div className="flex flex-wrap gap-1 bg-slate-100 border border-slate-200 rounded-xl p-1 w-fit">
      {tabs.map((t) => (
        <button key={t.id} type="button" onClick={() => onChange(t.id)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${value === t.id ? 'bg-white text-sky-700 shadow-2xs' : 'text-slate-600 hover:text-slate-900'}`}>
          {t.label}{t.count !== undefined && <span className="ml-1 text-slate-400">({t.count})</span>}
        </button>
      ))}
    </div>
  );
}
