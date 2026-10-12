import React from 'react';
import { Download, ExternalLink, Eye, FileSignature, FolderOpen, Receipt } from 'lucide-react';
import { useApi } from '../lib/hooks';
import type { BudgetItem, Project } from '../lib/types';
import { formatBytes, formatDateTime, formatQAR } from '../lib/format';
import { PREVIEWABLE_MIME_TYPES } from '../../shared/constants';
import { Attachments, FileName, kindLabel } from './Attachments';
import { Modal, NeedsConfirmation } from './ui';

interface Related {
  contracts: Array<{ id: string; title: string; company_name: string; status: string; archived_at: string | null }>;
  milestones: Array<{ id: string; payee_name: string; description: string; status: string; due_date: string | null; archived_at: string | null }>;
  files: Array<{ id: string; entity_type: string; kind: string; name: string; mime_type: string; size_bytes: number; created_at: string; source: string; href: string }>;
}

/**
 * Files of one master budget item (quotations, BOQs, specifications, invoices…) plus documents that belong to
 * records linked to the item (signed contracts, payment slips), shown with a link to their original record.
 * Uploading or archiving a file never changes an amount or a payment.
 */
export function BudgetItemFiles({ project, item, canWrite, onClose, onChanged }: { project: Project; item: BudgetItem; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const { data: rel } = useApi<Related>(`/api/projects/${project.id}/budget/items/${item.id}/related`);
  const base = `/api/projects/${project.id}/attachments`;
  return (
    <Modal open wide title={`Attachments — ${item.name}`} subtitle={item.approved_amount === null ? 'Approved amount needs confirmation' : `Approved / finalized ${formatQAR(item.approved_amount)}`} onClose={onClose}>
      <div className="space-y-4">
        {item.approved_amount === null && <NeedsConfirmation />}
        <Attachments projectId={project.id} entityType="budget_item" entityId={item.id} defaultKind="quotation" title="Files for this item"
          canUpload={canWrite && !item.archived_at} onChange={onChanged}
          hint="Quotations, BOQs, specifications, invoices and supporting documents. Adding or removing a file never changes a budget amount or a payment." />
        {item.drive_url
          ? <a href={item.drive_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700"><FolderOpen className="w-4 h-4" />Open the item’s Drive folder<ExternalLink className="w-3 h-3" /></a>
          : <p className="text-xs text-slate-500">No Drive folder linked{canWrite ? ' — add one with Edit (pencil).' : '.'}</p>}

        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">Related documents on other records</h4>
          {!rel ? <p className="text-xs text-slate-400">Loading…</p> : (
            <>
              {rel.contracts.length === 0 && rel.milestones.length === 0 && <p className="text-xs text-slate-500">No contracts or payment milestones are linked to this item.</p>}
              {rel.contracts.length > 0 && (
                <ul className="mb-2 space-y-1">{rel.contracts.map((k) => (
                  <li key={k.id}><a href={`#/contracts/${project.id}/${k.id}`} onClick={onClose} className="inline-flex items-center gap-2 text-sm text-sky-700 hover:underline"><FileSignature className="w-4 h-4" />Contract: {k.title} — {k.company_name} · {k.status}{k.archived_at ? ' · archived' : ''}</a></li>
                ))}</ul>
              )}
              {rel.milestones.length > 0 && (
                <ul className="mb-2 space-y-1">{rel.milestones.map((m) => (
                  <li key={m.id}><a href={`#/payments/${project.id}/${m.id}`} onClick={onClose} className="inline-flex items-center gap-2 text-sm text-sky-700 hover:underline"><Receipt className="w-4 h-4" />Payment: {m.payee_name} — {m.description}{m.archived_at ? ' · archived' : ''}</a></li>
                ))}</ul>
              )}
              {rel.files.length > 0 && (
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
                  {rel.files.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-800"><FileName name={f.name} /></span>
                        <span className="block text-[10px] text-slate-500">{kindLabel(f.kind)} · {f.source === 'contract' ? 'Contract file' : 'Payment record'} · {formatBytes(f.size_bytes)} · {formatDateTime(f.created_at)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        {PREVIEWABLE_MIME_TYPES.includes(f.mime_type) && <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`${base}/${f.id}/download?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${f.name}`}><Eye className="w-3.5 h-3.5" /></a>}
                        <a className="p-1.5 text-slate-500 hover:text-sky-700" href={`${base}/${f.id}/download`} aria-label={`Download ${f.name}`}><Download className="w-3.5 h-3.5" /></a>
                        <a className="p-1.5 text-slate-500 hover:text-sky-700" href={f.href} onClick={onClose} aria-label="Open the original record" title="Open the original record"><ExternalLink className="w-3.5 h-3.5" /></a>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-slate-500">These files stay on their own contract or payment record (no duplicate copies) and follow that record’s permissions.</p>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
