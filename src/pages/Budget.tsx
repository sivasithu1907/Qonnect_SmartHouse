import React, { useMemo, useState } from 'react';
import { Archive, Coins, Download, Pencil, Plus, RotateCcw, Table as TableIcon } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { BudgetItem, BudgetResponse, Project } from '../lib/types';
import { formatQAR } from '../lib/format';
import { sumMoney } from '../../shared/calc';
import { ManageCategories } from '../components/ManageCategories';
import { Badge, Button, Card, EmptyState, LinkButton, Modal, NeedsConfirmation, Notice, PageHeader, RecordForm, Spinner, Table, Tabs, Td, Th, useUi, type FieldSpec } from '../components/ui';

const KIND_TITLE: Record<string, string> = { fixed: 'Fixed costs', finishing: 'Finishing categories', other: 'Other categories' };
const KIND_LABEL: Record<string, string> = { fixed: 'Fixed cost', finishing: 'Finishing', other: 'Other' };

export function Budget({ project, onSettings }: { project: Project; onSettings: () => void }) {
  const base = `/api/projects/${project.id}/budget`;
  const { data, error, reload } = useApi<BudgetResponse>(base);
  const { can } = useSession();
  const { confirm, toast } = useUi();
  const [editing, setEditing] = useState<{ row: BudgetItem | null; categoryId?: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<'items' | 'categories'>('items');
  const admin = can('budget.write') && !project.archived_at;
  const manageCats = can('categories.manage') && !project.archived_at;

  const cats = useMemo(() => (data?.categories ?? []).filter((c) => showArchived || !c.archived_at), [data, showArchived]);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;

  const itemsOf = (cid: string) => data.items.filter((i) => i.category_id === cid && (showArchived || !i.archived_at));
  const misc = data.summary.misc;
  const s = data.summary;

  const act = async (url: string, msg: string, question?: React.ReactNode) => {
    if (question && !(await confirm(question, { title: 'Please confirm', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const categoryOptions = (currentId?: string) => [...data.categories]
    .filter((c) => !c.archived_at || c.id === currentId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((c) => ({ value: c.id, label: c.archived_at ? `${c.name} (archived)` : c.name, group: KIND_TITLE[c.kind] }));

  const itemFields = (row: BudgetItem | null): FieldSpec[] => [
    { name: 'category_id', label: 'Category', type: 'select', options: categoryOptions(row?.category_id), required: true, help: 'Categories are maintained in Manage Categories.' },
    { name: 'name', label: 'Item name', required: true },
    { name: 'description', label: 'Description / specification', type: 'textarea' },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'unit', label: 'Unit' },
    { name: 'approved_amount', label: 'Approved / Finalized Amount (QAR)', type: 'money', wide: true, placeholder: 'Needs confirmation — leave blank until finalized',
      help: 'Enter only the final approved amount. Leave blank until it is confirmed. Entering an amount never creates or marks a payment.' },
    { name: 'source_label', label: 'Reference / source label', placeholder: 'e.g. contract, quotation or sheet reference' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const tabs = [{ id: 'items' as const, label: 'Budget items' }, ...(manageCats ? [{ id: 'categories' as const, label: 'Manage categories' }] : [])];

  return (
    <div className="space-y-6">
      <PageHeader icon={<Coins className="w-5 h-5" />} title="Master Items & Budget" subtitle={`${project.name} — ${project.code}`}
        actions={<>
          <LinkButton href={project.sheets_url} label="Budget comparison sheet" tone="emerald" icon={<TableIcon className="w-3.5 h-3.5" />} />
          <a href={`/api/projects/${project.id}/reports/budget.csv`}><Button><Download className="w-4 h-4" />CSV</Button></a>
          {admin && <Button variant="primary" onClick={() => { setTab('items'); setEditing({ row: null }); }}><Plus className="w-4 h-4" />Item</Button>}
        </>} />

      <Notice>
        Each item has one amount: the <b>Approved / Finalized Amount (QAR)</b>. It stays blank and marked <b>Needs confirmation</b> until an authorised admin enters the final amount.
        Budget comparisons are kept in the linked Google Sheet.
        {project.control_budget === null || !project.control_budget_confirmed ? <> The project control budget is <b>Needs confirmation</b>.</> : <> Control budget confirmed: <b>{formatQAR(project.control_budget)}</b>.</>}
      </Notice>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Approved / finalized total">
          <div className="text-2xl font-bold font-mono text-emerald-700">{formatQAR(s.approvedCommitments)}</div>
          <p className="text-xs text-slate-600 mt-1">{s.approvedItemCount} of {s.itemCount} active items have a finalized amount{s.itemCount - s.approvedItemCount > 0 ? `; ${s.itemCount - s.approvedItemCount} need confirmation` : ''}.</p>
        </Card>
        <Card title="Scheduled vs paid">
          <div className="text-sm text-slate-700 space-y-1">
            <div className="flex justify-between gap-2"><span>Scheduled payment commitments</span><b className="font-mono">{formatQAR(s.scheduled)}</b></div>
            <div className="flex justify-between gap-2"><span>Actual recorded payments</span><b className="font-mono text-sky-700">{formatQAR(s.paid)}</b></div>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">For payment milestones linked to budget items.</p>
        </Card>
        <Card title="Miscellaneous allowance" actions={can('projects.manage') && <Button size="sm" onClick={onSettings}><Pencil className="w-3.5 h-3.5" />Edit %</Button>}>
          <div className="text-2xl font-bold font-mono text-slate-900">{formatQAR(misc.allowance)}</div>
          <p className="text-xs text-slate-600 mt-1">{misc.percentage}% × {formatQAR(misc.basisAmount)}</p>
          <p className="text-[11px] text-slate-500 mt-2">Basis: finalized amounts of finishing categories included in the misc basis ({misc.itemsCounted} item(s){misc.itemsMissingValue ? `; ${misc.itemsMissingValue} still need confirmation` : ''}). Fixed costs are excluded.</p>
        </Card>
      </div>

      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}

      {tab === 'categories' && manageCats ? (
        <Card title="Manage categories" subtitle="Add, rename, reorder and archive this project's budget and material categories.">
          <ManageCategories projectId={project.id} onChanged={reload} />
        </Card>
      ) : (
        <>
          <div className="flex justify-end">
            <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
          </div>
          {cats.length === 0 ? <EmptyState title="No budget categories yet">{manageCats ? 'Add categories in Manage categories.' : ''}</EmptyState> : (['fixed', 'finishing', 'other'] as const).map((kind) => {
            const group = cats.filter((c) => c.kind === kind);
            if (!group.length) return null;
            const liveItems = group.filter((c) => !c.archived_at).flatMap((c) => data.items.filter((i) => i.category_id === c.id && !i.archived_at));
            const approvedVals = liveItems.map((i) => i.approved_amount).filter((v) => v !== null);
            return (
              <Card key={kind} title={KIND_TITLE[kind]}
                subtitle={kind === 'fixed' ? 'Editing an amount never creates a payment or marks it paid.' : undefined}>
                <Table>
                  <thead><tr>
                    <Th>Category / item</Th>
                    <Th className="text-right">Approved / Finalized Amount (QAR)</Th>
                    <Th className="text-right">Scheduled</Th><Th className="text-right">Paid</Th><Th>Notes</Th>{admin && <Th />}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.map((c) => (
                      <React.Fragment key={c.id}>
                        <tr className={`bg-slate-50/80 ${c.archived_at ? 'opacity-60' : ''}`}>
                          <td colSpan={5} className="px-3 py-1.5 text-xs font-bold text-slate-800">
                            <span className="flex flex-wrap items-center gap-2">{c.name}
                              <Badge tone={c.kind === 'fixed' ? 'indigo' : 'slate'}>{KIND_LABEL[c.kind]}</Badge>
                              {c.archived_at && <Badge tone="rose">Archived</Badge>}
                              {c.kind === 'finishing' && !c.include_in_misc_basis && <Badge>Excluded from misc basis</Badge>}
                              {c.notes && <span className="font-normal text-[11px] text-slate-500">{c.notes}</span>}
                            </span>
                          </td>
                          {admin && <td className="px-3 py-1 whitespace-nowrap text-right">
                            {!c.archived_at && <Button size="sm" variant="ghost" title="Add item to this category" onClick={() => setEditing({ row: null, categoryId: c.id })}><Plus className="w-3.5 h-3.5" /></Button>}
                          </td>}
                        </tr>
                        {itemsOf(c.id).length === 0 && <tr><td colSpan={6} className="px-3 py-2 text-[11px] text-slate-400">No items</td></tr>}
                        {itemsOf(c.id).map((i) => (
                          <tr key={i.id} className={i.archived_at ? 'opacity-60' : ''}>
                            <Td className="pl-6 text-slate-900">{i.name}{i.quantity !== null && <div className="text-[11px] text-slate-500">{i.quantity} {i.unit}</div>}{i.archived_at && <Badge tone="rose">Archived</Badge>}</Td>
                            <Td className="text-right font-mono whitespace-nowrap">{i.approved_amount === null ? <NeedsConfirmation /> : <span className="text-emerald-700 font-semibold">{formatQAR(i.approved_amount)}</span>}</Td>
                            <Td className="text-right font-mono whitespace-nowrap">{formatQAR(i.scheduled_amount)}</Td>
                            <Td className="text-right font-mono whitespace-nowrap text-sky-700">{formatQAR(i.paid_amount)}</Td>
                            <Td className="max-w-xs"><div className="text-[11px] text-slate-600">{i.notes}</div>{i.source_label && <div className="text-[10px] text-slate-400">Ref: {i.source_label}</div>}</Td>
                            {admin && <Td className="whitespace-nowrap text-right">
                              <Button size="sm" variant="ghost" title="Edit" onClick={() => setEditing({ row: i })}><Pencil className="w-3.5 h-3.5" /></Button>
                              {i.archived_at
                                ? <Button size="sm" variant="ghost" title="Restore" onClick={() => act(`${base}/items/${i.id}/restore`, 'Item restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                                : <Button size="sm" variant="ghost" title="Archive" onClick={() => act(`${base}/items/${i.id}/archive`, 'Item archived', <>Archive <b>{i.name}</b>? Its history is kept and it can be restored.</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                            </Td>}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                    <tr className="bg-slate-50 font-semibold">
                      <Td className="text-slate-900">Total (active items)</Td>
                      <Td className="text-right font-mono whitespace-nowrap">
                        {formatQAR(sumMoney(approvedVals))}
                        {approvedVals.length < liveItems.length && <div className="text-[10px] font-normal text-amber-700">{liveItems.length - approvedVals.length} item(s) need confirmation</div>}
                      </Td>
                      <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(liveItems.map((i) => i.scheduled_amount)))}</Td>
                      <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(liveItems.map((i) => i.paid_amount)))}</Td>
                      <Td />{admin && <Td />}
                    </tr>
                  </tbody>
                </Table>
              </Card>
            );
          })}
        </>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} wide title={editing?.row ? 'Edit budget item' : 'Add budget item'}>
        {editing && (
          <RecordForm initial={editing.row ?? { category_id: editing.categoryId ?? categoryOptions()[0]?.value }} mode={editing.row ? 'edit' : 'create'} fields={itemFields(editing.row)}
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              if (editing.row) await patch(`${base}/items/${editing.row.id}`, v); else await post(`${base}/items`, v);
              toast('Budget item saved'); setEditing(null); await reload();
            }} />
        )}
      </Modal>
    </div>
  );
}
