import React from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import type { BudgetItem, Project } from '../lib/types';
import { formatQAR } from '../lib/format';
import { Attachments } from './Attachments';
import { Modal, NeedsConfirmation } from './ui';

/**
 * Files attached directly to one master budget item (quotations, BOQs, specifications, invoices…).
 * Contract and payment documents stay on their own records and are not listed here.
 * Uploading or archiving a file never changes an amount or a payment.
 */
export function BudgetItemFiles({ project, item, canWrite, onClose, onChanged }: { project: Project; item: BudgetItem; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
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

      </div>
    </Modal>
  );
}
