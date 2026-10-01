import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { inputCls } from '../ui';

export interface UnscheduledItem {
  id: string;
  name: string;
  /** extra searchable text (status, responsibility, assignee …) */
  searchText?: string;
  /** right-hand details: badges / small text */
  meta?: React.ReactNode;
  onOpen: () => void;
}
export interface UnscheduledGroup { key: string; label: React.ReactNode; searchLabel: string; items: UnscheduledItem[] }

/** Groups collapse by default once the list is longer than this. */
export const COLLAPSE_THRESHOLD = 12;

/** Case-insensitive filter on item name/details and group name; empty groups are dropped. */
export function filterUnscheduled(groups: UnscheduledGroup[], query: string): UnscheduledGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.filter((g) => g.items.length);
  return groups
    .map((g) => (g.searchLabel.toLowerCase().includes(q)
      ? g
      : { ...g, items: g.items.filter((i) => `${i.name} ${i.searchText ?? ''}`.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length);
}

/**
 * "Not scheduled" list shared by the Material schedule and the Gantt: total count, search,
 * and one expandable section per category / phase with readable rows. Clicking a row opens the
 * record's existing edit (or read-only) dialog — nothing here sets or suggests dates.
 */
export function UnscheduledPanel({ groups, noun, description, emptyText, searchPlaceholder, footer }: {
  groups: UnscheduledGroup[];
  noun: [singular: string, plural: string];
  description: React.ReactNode;
  emptyText: string;
  searchPlaceholder: string;
  footer?: React.ReactNode;
}) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const collapsedByDefault = total > COLLAPSE_THRESHOLD;
  const shown = useMemo(() => filterUnscheduled(groups, query), [groups, query]);
  const searching = query.trim() !== '';
  const matchCount = shown.reduce((n, g) => n + g.items.length, 0);
  const isOpen = (key: string) => searching || (open[key] ?? !collapsedByDefault);
  const setAll = (v: boolean) => setOpen(Object.fromEntries(groups.map((g) => [g.key, v])));
  const label = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`;

  return (
    <section aria-label="Not scheduled" className="border border-slate-200 rounded-xl bg-white">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 border-b border-slate-100">
        <div className="min-w-0 mr-auto">
          <h3 className="text-sm font-bold text-slate-900">Not scheduled <span className="font-semibold text-slate-500">— {label(total)}</span></h3>
          <p className="text-[11px] text-slate-500">{description}</p>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
                className={`${inputCls} !py-1.5 !pl-8 !pr-7 !text-xs placeholder:text-slate-400`} />
              {searching && <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700"><X className="w-3.5 h-3.5" /></button>}
            </div>
            {!searching && groups.length > 1 && (
              <div className="flex gap-1 text-[11px]">
                <button type="button" onClick={() => setAll(true)} className="font-semibold text-sky-700 hover:underline">Expand all</button>
                <span className="text-slate-300">·</span>
                <button type="button" onClick={() => setAll(false)} className="font-semibold text-sky-700 hover:underline">Collapse all</button>
              </div>
            )}
          </div>
        )}
      </div>

      {total === 0 ? <p className="px-3 py-2.5 text-xs text-slate-500">{emptyText}</p>
        : shown.length === 0 ? <p className="px-3 py-2.5 text-xs text-slate-500">No match for “{query.trim()}”.</p> : (
          <>
            {searching && <p className="px-3 pt-2 text-[11px] text-slate-500">{label(matchCount)} found.</p>}
            <ul className="divide-y divide-slate-100">
              {shown.map((g) => {
                const expanded = isOpen(g.key);
                const original = groups.find((x) => x.key === g.key)?.items.length ?? g.items.length;
                return (
                  <li key={g.key}>
                    <button type="button" aria-expanded={expanded} onClick={() => !searching && setOpen((o) => ({ ...o, [g.key]: !expanded }))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
                      {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                      <span className="text-xs font-semibold text-slate-800 min-w-0 truncate">{g.label}</span>
                      <span className="ml-auto shrink-0 text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-md px-1.5">
                        {searching && g.items.length !== original ? `${g.items.length} / ${original}` : g.items.length}
                      </span>
                    </button>
                    {expanded && (
                      <ul className="pb-1.5" data-testid="unscheduled-rows">
                        {g.items.map((i) => (
                          <li key={i.id}>
                            <button type="button" onClick={i.onOpen}
                              className="w-full grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 pl-9 pr-3 py-1.5 text-left hover:bg-sky-50/60 focus:bg-sky-50/60 focus:outline-none">
                              <span className="text-xs text-slate-800 min-w-0">{i.name}</span>
                              {i.meta && <span className="flex flex-wrap items-center gap-1 sm:justify-end">{i.meta}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      {footer && <div className="px-3 py-2 border-t border-slate-100 text-[11px] text-slate-500">{footer}</div>}
    </section>
  );
}
