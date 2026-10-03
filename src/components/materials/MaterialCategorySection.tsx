import React, { useEffect, useState } from 'react';
import { AlertTriangle, Archive, CalendarX2, ChevronDown, ChevronRight, Clock3, FileText, Package, Pencil, RotateCcw } from 'lucide-react';
import type { MaterialCategory, MaterialItem, ScopeNote } from '../../lib/types';
import { formatDate, formatQAR } from '../../lib/format';
import { SUPPLY_RESPONSIBILITY_LABELS } from '../../../shared/constants';
import { qtyRemaining } from '../../../shared/calc';
import { categorySummary, isOverdueLine } from '../../lib/materialFilters';
import { Badge, Button, NeedsConfirmation, StatusBadge, Table, Td, Th } from '../ui';

/** true from 768 px (tablet portrait and up): table layout; below it: one card per line. */
export function useWideLayout(defaultWide = true) {
  const [wide, setWide] = useState(defaultWide);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 768px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export interface RowPermissions { full: boolean; canEditRow: (m: MaterialItem) => boolean }

interface Props {
  category: MaterialCategory;
  /** visible (already filtered) lines of this category */
  items: MaterialItem[];
  note?: ScopeNote;
  today: string;
  open: boolean;
  onToggle: () => void;
  wide: boolean;
  perms: RowPermissions;
  onOpenLine: (m: MaterialItem) => void;
  onArchive: (m: MaterialItem) => void;
  onRestore: (m: MaterialItem) => void;
  onEditScope?: () => void;
}

function Responsibility({ m }: { m: MaterialItem }) {
  return (
    <>
      {m.supply_responsibility === 'needs_confirmation' ? <NeedsConfirmation /> : <Badge tone={m.supply_responsibility === 'owner' ? 'sky' : 'indigo'}>{SUPPLY_RESPONSIBILITY_LABELS[m.supply_responsibility]}</Badge>}
      {m.responsibility_note && <div className="text-[11px] text-slate-500 mt-0.5">{m.responsibility_note}</div>}
    </>
  );
}

function DeliveryDates({ m, late }: { m: MaterialItem; late: boolean }) {
  const none = !m.planned_delivery_date && !m.confirmed_delivery_date && !m.revised_delivery_date && !m.actual_delivery_date && !m.delivery_date_note;
  return (
    <div className="text-[11px] space-y-0.5">
      {m.planned_delivery_date && <div>Planned {formatDate(m.planned_delivery_date)}</div>}
      {m.confirmed_delivery_date && <div>Confirmed {formatDate(m.confirmed_delivery_date)}</div>}
      {m.revised_delivery_date && <div>Revised {formatDate(m.revised_delivery_date)}</div>}
      {m.actual_delivery_date && <div className="text-emerald-700 font-semibold">Actual {formatDate(m.actual_delivery_date)}</div>}
      {m.delivery_date_note && <Badge tone="amber">{m.delivery_date_note}</Badge>}
      {none && <span className="text-slate-400">—</span>}
      {late && <div><Badge tone="rose">Overdue</Badge></div>}
    </div>
  );
}

const dash = <span className="text-slate-400">—</span>;
const qtys = (m: MaterialItem) => `${m.qty_ordered ?? '—'} / ${m.qty_delivered ?? '—'} / ${qtyRemaining(m.qty_ordered, m.qty_delivered) ?? '—'}`;

function LineActions({ m, perms, onOpenLine, onArchive, onRestore, labelled }: { m: MaterialItem; perms: RowPermissions; onOpenLine: (m: MaterialItem) => void; onArchive: (m: MaterialItem) => void; onRestore: (m: MaterialItem) => void; labelled?: boolean }) {
  const editable = perms.canEditRow(m);
  const label = `${editable ? 'Edit' : 'View'} ${m.description}${m.attachment_count ? ` (${m.attachment_count} file${m.attachment_count === 1 ? '' : 's'})` : ''}`;
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" variant={labelled ? 'secondary' : 'ghost'} onClick={() => onOpenLine(m)} aria-label={label} title={editable ? 'Edit / files' : 'View / files'} className={labelled ? 'min-h-10' : ''}>
        <Pencil className="w-3.5 h-3.5" />{labelled && <span>{editable ? 'Edit' : 'View'}</span>}{m.attachment_count > 0 && <span className="text-[10px]">{m.attachment_count}</span>}
      </Button>
      {perms.full && (m.archived_at
        ? <Button size="sm" variant="ghost" onClick={() => onRestore(m)} aria-label={`Restore ${m.description}`} title="Restore" className={labelled ? 'min-h-10' : ''}><RotateCcw className="w-3.5 h-3.5" /></Button>
        : <Button size="sm" variant="ghost" onClick={() => onArchive(m)} aria-label={`Archive ${m.description}`} title="Archive" className={labelled ? 'min-h-10' : ''}><Archive className="w-3.5 h-3.5" /></Button>)}
    </div>
  );
}

/** One material category as a collapsible section: header with counts, scope notes on demand, then the lines. */
export function MaterialCategorySection({ category: c, items, note, today, open, onToggle, wide, perms, onOpenLine, onArchive, onRestore, onEditScope }: Props) {
  const s = categorySummary(items, today);
  const bodyId = `matcat-${c.id}`;
  const hasNotes = !!(note && (note.owner_supply || note.contractor_scope));
  return (
    <section aria-labelledby={`${bodyId}-h`} className="relative border border-slate-200 rounded-xl bg-white shadow-2xs overflow-hidden">
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 pr-2 ${open ? 'bg-slate-50 border-b border-slate-200' : ''}`}>
        <button type="button" id={`${bodyId}-h`} aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
          className="flex-1 min-w-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-slate-50 rounded-none">
          <span className="flex items-center gap-2 min-w-0">
            {open ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />}
            <Package className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />
            <span className="text-sm font-bold text-slate-900">{c.name}</span>
            <span className="text-[11px] font-semibold text-slate-600 bg-white border border-slate-200 rounded-md px-1.5 whitespace-nowrap">{s.total} item{s.total === 1 ? '' : 's'}</span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {c.archived_at && <Badge tone="rose">Archived category</Badge>}
            {s.overdue > 0 && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{s.overdue} overdue</span>}
            {s.noDate > 0 && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600"><CalendarX2 className="w-3.5 h-3.5" aria-hidden="true" />{s.noDate} no dates</span>}
            {s.awaiting > 0 && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800"><Clock3 className="w-3.5 h-3.5" aria-hidden="true" />{s.awaiting} awaiting confirmation</span>}
          </span>
        </button>
        {onEditScope && <Button size="sm" variant="ghost" onClick={onEditScope} aria-label={`Edit scope notes for ${c.name}`} className="min-h-10"><Pencil className="w-3.5 h-3.5" /><span className="hidden sm:inline">Scope notes</span></Button>}
      </div>

      {open && (
        <div id={bodyId} className="px-3 py-3 space-y-3">
          {hasNotes && (
            <details className="group rounded-lg border border-slate-200 bg-slate-50/60">
              <summary className="cursor-pointer select-none list-none flex items-center gap-2 px-3 py-2 min-h-10 text-xs font-semibold text-slate-700 rounded-lg [&::-webkit-details-marker]:hidden">
                <ChevronRight className="w-3.5 h-3.5 text-slate-500 transition-transform group-open:rotate-90" aria-hidden="true" />
                <FileText className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                Scope notes
                <span className="font-normal text-slate-500">— {[note!.owner_supply && 'Owner supply', note!.contractor_scope && 'Contractor scope'].filter(Boolean).join(' · ')}</span>
              </summary>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 px-3 pb-3 text-xs text-slate-700">
                {note!.owner_supply && <div className="bg-white border border-slate-200 rounded-lg p-2.5"><div className="text-[11px] font-bold uppercase tracking-wide text-sky-800 mb-0.5">Owner supply</div><p className="max-w-[90ch] whitespace-pre-wrap">{note!.owner_supply}</p></div>}
                {note!.contractor_scope && <div className="bg-white border border-slate-200 rounded-lg p-2.5"><div className="text-[11px] font-bold uppercase tracking-wide text-indigo-800 mb-0.5">Contractor scope</div><p className="max-w-[90ch] whitespace-pre-wrap">{note!.contractor_scope}</p></div>}
                {note!.source_label && <div className="text-[11px] text-slate-500 lg:col-span-2">Source: {note!.source_label}</div>}
              </div>
            </details>
          )}

          {wide ? (
            <Table>
              <thead><tr><Th className="w-[200px]">Item</Th><Th>Qty</Th><Th>Responsibility</Th><Th>Vendor / assigned</Th><Th>Status</Th><Th>Required on site</Th><Th>Delivery</Th><Th>Ordered / delivered / remaining</Th><Th>Inspection</Th><Th>Follow-up</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((m) => (
                  <tr key={m.id} id={`rec-${m.id}`} className={m.archived_at ? 'opacity-60' : ''}>
                    <Td className="font-semibold text-slate-900 min-w-[170px]">{m.description}{m.is_package && <> <Badge tone="violet">Package</Badge></>}{m.amount !== null && <div className="text-[11px] font-normal text-slate-500">{formatQAR(m.amount)}</div>}{m.archived_at && <> <Badge tone="rose">Archived</Badge></>}</Td>
                    <Td>{m.quantity !== null ? `${m.quantity} ${m.unit}` : dash}</Td>
                    <Td><Responsibility m={m} /></Td>
                    <Td>{m.vendor || dash}{m.assigned_contractor_name && <div className="text-[11px] text-slate-500">Assigned: {m.assigned_contractor_name}</div>}</Td>
                    <Td><StatusBadge status={m.status} /></Td>
                    <Td className="whitespace-nowrap">{formatDate(m.required_on_site_date)}</Td>
                    <Td className="whitespace-nowrap"><DeliveryDates m={m} late={isOverdueLine(m, today)} /></Td>
                    <Td className="font-mono text-[11px]">{qtys(m)}</Td>
                    <Td>{m.inspection_status || dash}</Td>
                    <Td className="whitespace-nowrap">{formatDate(m.next_follow_up_date)}</Td>
                    <Td className="whitespace-nowrap text-right"><LineActions m={m} perms={perms} onOpenLine={onOpenLine} onArchive={onArchive} onRestore={onRestore} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <ul className="space-y-2" aria-label={`${c.name} material lines`}>
              {items.map((m) => (
                <li key={m.id} id={`rec-${m.id}`} className={`border border-slate-200 rounded-lg bg-white p-3 ${m.archived_at ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 break-words">{m.description}</div>
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        <StatusBadge status={m.status} />
                        {m.is_package && <Badge tone="violet">Package</Badge>}
                        {m.archived_at && <Badge tone="rose">Archived</Badge>}
                        {isOverdueLine(m, today) && <Badge tone="rose">Overdue</Badge>}
                      </div>
                    </div>
                    <LineActions m={m} perms={perms} onOpenLine={onOpenLine} onArchive={onArchive} onRestore={onRestore} labelled />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 mt-3 text-xs">
                    <div className="col-span-2"><dt className="text-[11px] text-slate-500">Responsibility</dt><dd className="mt-0.5"><Responsibility m={m} /></dd></div>
                    <div><dt className="text-[11px] text-slate-500">Required on site</dt><dd className="mt-0.5 font-medium text-slate-800">{formatDate(m.required_on_site_date)}</dd></div>
                    <div><dt className="text-[11px] text-slate-500">Delivery</dt><dd className="mt-0.5 text-slate-800"><DeliveryDates m={m} late={false} /></dd></div>
                    <div><dt className="text-[11px] text-slate-500">Quantity</dt><dd className="mt-0.5 text-slate-800">{m.quantity !== null ? `${m.quantity} ${m.unit}` : dash}</dd></div>
                    <div><dt className="text-[11px] text-slate-500">Ordered / delivered / remaining</dt><dd className="mt-0.5 font-mono text-[11px] text-slate-800">{qtys(m)}</dd></div>
                    <div><dt className="text-[11px] text-slate-500">Vendor / assigned</dt><dd className="mt-0.5 text-slate-800">{m.vendor || dash}{m.assigned_contractor_name && <div className="text-[11px] text-slate-500">Assigned: {m.assigned_contractor_name}</div>}</dd></div>
                    <div><dt className="text-[11px] text-slate-500">Inspection</dt><dd className="mt-0.5 text-slate-800">{m.inspection_status || dash}</dd></div>
                    <div><dt className="text-[11px] text-slate-500">Follow-up</dt><dd className="mt-0.5 text-slate-800">{formatDate(m.next_follow_up_date)}</dd></div>
                    {m.amount !== null && <div><dt className="text-[11px] text-slate-500">Amount</dt><dd className="mt-0.5 text-slate-800">{formatQAR(m.amount)}</dd></div>}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
