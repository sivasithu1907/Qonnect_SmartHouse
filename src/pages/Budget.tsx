import React, { useMemo, useState } from 'react';
import { AlertTriangle, Archive, Coins, Download, Info, Pencil, Plus, RotateCcw, Table as TableIcon } from 'lucide-react';
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
  // a budget category that looks like a miscellaneous line would be counted on top of the allowance
  const miscLikeCategories = data.categories.filter((c) => !c.archived_at && /\bmisc/i.test(c.name)).map((c) => c.name);

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
    <div className="space-y-4">
      <PageHeader icon={<Coins className="w-5 h-5" />} title="Master Items & Budget" subtitle={`${project.name} — ${project.code}`}
        actions={<>
          <LinkButton href={project.sheets_url} label="Budget comparison sheet" tone="emerald" icon={<TableIcon className="w-3.5 h-3.5" />} />
          <a href={`/api/projects/${project.id}/reports/budget.csv`}><Button><Download className="w-4 h-4" />CSV</Button></a>
          {admin && <Button variant="primary" onClick={() => { setTab('items'); setEditing({ row: null }); }}><Plus className="w-4 h-4" />Item</Button>}
        </>} />

      <p className="-mt-3 flex items-center gap-1.5 text-sm text-slate-500"><Info className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />Amounts are managed here. Quote comparisons are available in the linked Google Sheet.</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <Card className="lg:col-span-2" title="Budget summary" subtitle="Finalized amounts of active items plus the miscellaneous allowance. Contract values and payments are not included.">
          <BudgetSummary s={s} canConfirmBudget={can('projects.manage') && !project.archived_at} onSettings={onSettings} miscCategoryNames={miscLikeCategories} />
        </Card>
        <div className="space-y-4">
          <Card title="Miscellaneous allowance" actions={can('projects.manage') && !project.archived_at && <Button size="sm" onClick={onSettings}><Pencil className="w-3.5 h-3.5" />Edit %</Button>}>
            <dl className="text-sm space-y-1.5">
              <div className="flex justify-between gap-3"><dt className="text-slate-600">Percentage</dt><dd className="font-mono tabular-nums font-semibold text-slate-900">{misc.percentage}%</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-600">Eligible basis</dt><dd className="font-mono tabular-nums text-slate-900">{formatQAR(misc.basisAmount)}</dd></div>
              <div className="flex justify-between gap-3 border-t border-slate-100 pt-1.5"><dt className="font-semibold text-slate-800">Allowance</dt><dd className="font-mono tabular-nums font-bold text-slate-900">{formatQAR(misc.allowance)}</dd></div>
            </dl>
            <p className="text-xs text-slate-500 mt-2">Eligible basis: finalized amounts of finishing categories included in the misc basis ({misc.itemsCounted} item{misc.itemsCounted === 1 ? '' : 's'}{misc.itemsMissingValue ? `; ${misc.itemsMissingValue} without an amount` : ''}). Fixed costs are excluded.</p>
          </Card>
          <Card title="Scheduled vs paid">
            <dl className="text-sm space-y-1.5">
              <div className="flex justify-between gap-3"><dt className="text-slate-600">Scheduled payments</dt><dd className="font-mono tabular-nums font-semibold text-slate-900">{formatQAR(s.scheduled)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-600">Recorded payments</dt><dd className="font-mono tabular-nums font-semibold text-sky-700">{formatQAR(s.paid)}</dd></div>
            </dl>
            <p className="text-xs text-slate-500 mt-2">Payment milestones linked to budget items.</p>
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {tabs.length > 1 ? <Tabs value={tab} onChange={setTab} tabs={tabs} /> : <span />}
        {tab === 'items' && <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>}
      </div>

      {tab === 'categories' && manageCats ? (
        <Card title="Manage categories" subtitle="Add, rename, reorder and archive this project's budget and material categories.">
          <ManageCategories projectId={project.id} onChanged={reload} />
        </Card>
      ) : (
        <>
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

const KIND_SUBTOTAL_LABEL: Record<string, string> = { fixed: 'Fixed costs', finishing: 'Finishing items', other: 'Other items' };

/**
 * Subtotals by kind → finalized items subtotal → miscellaneous allowance → grand total (strongest emphasis) →
 * confirmed control budget → above budget / not allocated. Contextual warnings appear once, at the end.
 */
export function BudgetSummary({ s, canConfirmBudget, onSettings, miscCategoryNames }: { s: BudgetResponse['summary']; canConfirmBudget: boolean; onSettings: () => void; miscCategoryNames: string[] }) {
  const it = s.itemized;
  const row = 'flex items-baseline justify-between gap-4 py-1.5';
  const amt = 'font-mono tabular-nums text-right whitespace-nowrap';
  return (
    <div className="text-sm">
      <dl>
        <div className="pb-1">
          {s.byKind.filter((k) => k.itemCount > 0).map((k) => (
            <div key={k.kind} className={`${row} text-slate-600`}>
              <dt>{KIND_SUBTOTAL_LABEL[k.kind]}{k.missingCount > 0 && <span className="ml-1.5 text-xs text-amber-800">{k.missingCount} without an amount</span>}</dt>
              <dd className={amt}>{formatQAR(k.subtotal)}</dd>
            </div>
          ))}
        </div>
        <div className="border-t border-slate-100 pt-1">
          <div className={`${row} font-semibold text-slate-900`}><dt>Finalized items subtotal</dt><dd className={amt}>{formatQAR(it.finalizedSubtotal)}</dd></div>
          <div className={`${row} text-slate-600`}><dt>Miscellaneous allowance <span className="text-xs text-slate-500">({s.misc.percentage}% of eligible finishing items)</span></dt><dd className={amt}>{formatQAR(it.miscAllowance)}</dd></div>
        </div>
        <div className="my-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3">
          <dt className="text-base font-bold text-slate-900">Grand total including miscellaneous{!it.complete && <span className="ml-2 align-middle"><Badge tone="amber">Incomplete</Badge></span>}</dt>
          <dd className={`${amt} text-2xl font-bold text-slate-900`}>{formatQAR(it.grandTotal)}</dd>
        </div>
        <div className="pt-1">
          <div className={`${row} text-slate-700`}>
            <dt>Confirmed control budget</dt>
            <dd className={amt}>{it.controlBudgetConfirmed ? formatQAR(it.controlBudget) : <NeedsConfirmation />}</dd>
          </div>
          {it.difference !== null && (
            it.aboveControl > 0 ? (
              <div className={`${row} font-semibold text-rose-700`}><dt>Above budget{!it.complete ? ' (at least)' : ''}</dt><dd className={amt}>{formatQAR(it.aboveControl)}</dd></div>
            ) : it.complete ? (
              <div className={`${row} font-semibold text-slate-900`}><dt>Budget not allocated to items</dt><dd className={amt}>{formatQAR(it.notAllocated)}</dd></div>
            ) : (
              <div className={`${row} text-slate-600`}><dt>Difference against budget</dt><dd className="text-xs text-right">Shown when every item has an amount</dd></div>
            )
          )}
        </div>
      </dl>
      {(!it.complete || !it.controlBudgetConfirmed || miscCategoryNames.length > 0) && (
        <ul className="mt-3 space-y-1.5">
          {!it.complete && (
            <li className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{it.missingCount} active item{it.missingCount === 1 ? ' has' : 's have'} no finalized amount, so this is not the complete project cost.</span>
            </li>
          )}
          {!it.controlBudgetConfirmed && (
            <li className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>The control budget is not confirmed, so no difference is shown.</span>
              {canConfirmBudget && <button type="button" onClick={onSettings} className="font-semibold text-sky-700 hover:text-sky-900">Open settings</button>}
            </li>
          )}
          {miscCategoryNames.length > 0 && (
            <li className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>Check category {miscCategoryNames.map((n) => `“${n}”`).join(', ')}: its items are in the subtotal and the miscellaneous allowance is added separately.</span>
            </li>
          )}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500">The control budget is the approved spending limit and does not change when item amounts or the miscellaneous percentage change.</p>
    </div>
  );
}
