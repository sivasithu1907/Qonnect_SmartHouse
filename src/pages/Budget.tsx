import React, { useMemo, useState } from 'react';
import { Archive, Coins, Download, Pencil, Plus, RotateCcw } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { BudgetCategory, BudgetItem, BudgetResponse, Project, SourceReference } from '../lib/types';
import { formatQAR } from '../lib/format';
import { MISC_BASIS_LABELS } from '../../shared/constants';
import { sumMoney } from '../../shared/calc';
import { Badge, Button, Card, EmptyState, Modal, NeedsConfirmation, Notice, PageHeader, RecordForm, Spinner, Table, Td, Th, useUi, type FieldSpec } from '../components/ui';

type Editing =
  | { kind: 'category'; row: BudgetCategory | null }
  | { kind: 'item'; row: BudgetItem | null; categoryId?: string }
  | { kind: 'reference'; row: SourceReference };

export function Budget({ project, onSettings }: { project: Project; onSettings: () => void }) {
  const base = `/api/projects/${project.id}/budget`;
  const { data, error, reload } = useApi<BudgetResponse>(base);
  const { can } = useSession();
  const { confirm, toast } = useUi();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const admin = can('budget.write') && !project.archived_at;

  const cats = useMemo(() => (data?.categories ?? []).filter((c) => showArchived || !c.archived_at), [data, showArchived]);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;

  const itemsOf = (cid: string) => data.items.filter((i) => i.category_id === cid && (showArchived || !i.archived_at));
  const liveCatIds = new Set(data.categories.filter((c) => !c.archived_at).map((c) => c.id));
  const finishingIds = new Set(data.categories.filter((c) => c.kind === 'finishing' && !c.archived_at).map((c) => c.id));
  const liveItems = data.items.filter((i) => !i.archived_at && liveCatIds.has(i.category_id));
  const sumA = sumMoney(liveItems.filter((i) => finishingIds.has(i.category_id)).map((i) => i.source_variant_a));
  const sumB = sumMoney(liveItems.filter((i) => finishingIds.has(i.category_id)).map((i) => i.source_variant_b));
  const misc = data.summary.misc;

  const act = async (url: string, msg: string, question?: React.ReactNode) => {
    if (question && !(await confirm(question, { title: 'Please confirm', confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const itemFields = (catKind: string): FieldSpec[] => [
    { name: 'category_id', label: 'Category', type: 'select', options: data.categories.filter((c) => !c.archived_at).map((c) => ({ value: c.id, label: c.name })), required: true },
    { name: 'name', label: 'Item name', required: true },
    { name: 'description', label: 'Description / specification', type: 'textarea' },
    { name: 'quantity', label: 'Quantity', type: 'number' },
    { name: 'unit', label: 'Unit' },
    ...(catKind === 'fixed'
      ? [{ name: 'source_amount', label: 'Source amount (QAR)', type: 'money' as const, help: 'Original source value. Editing it never creates a payment.' }]
      : [
          { name: 'source_variant_a', label: 'Variant A – Individual (reference, QAR)', type: 'money' as const },
          { name: 'source_variant_b', label: 'Variant B – Al Wathab (reference, QAR)', type: 'money' as const },
        ]),
    { name: 'source_status', label: 'Source status note', placeholder: 'e.g. Variant B: Not priced' },
    { name: 'source_label', label: 'Source label (traceability)' },
    { name: 'approved_amount', label: 'Approved / selected project amount (QAR)', type: 'money', help: 'Leave blank until the owner approves. This is separate from the source values and is not a payment.' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader icon={<Coins className="w-5 h-5" />} title="Master Items & Budget" subtitle={`${project.name} — ${project.code}`}
        actions={<>
          <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
          <a href={`/api/projects/${project.id}/reports/budget.csv`}><Button><Download className="w-4 h-4" />CSV</Button></a>
          {admin && <Button onClick={() => setEditing({ kind: 'category', row: null })}><Plus className="w-4 h-4" />Category</Button>}
          {admin && <Button variant="primary" onClick={() => setEditing({ kind: 'item', row: null })}><Plus className="w-4 h-4" />Item</Button>}
        </>} />

      <Notice>
        Variant A and Variant B are <b>reference estimates</b>, not approved commitments or payments. The approved amount stays blank until the owner enters or approves it.
        {project.control_budget === null || !project.control_budget_confirmed ? <> The project control budget is <b>Needs confirmation</b>.</> : <> Control budget confirmed: <b>{formatQAR(project.control_budget)}</b>.</>}
      </Notice>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Miscellaneous allowance" actions={can('projects.manage') && <Button size="sm" onClick={onSettings}><Pencil className="w-3.5 h-3.5" />Edit</Button>}>
          <div className="text-2xl font-bold font-mono text-slate-900">{formatQAR(misc.allowance)}</div>
          <p className="text-xs text-slate-600 mt-1">{misc.percentage}% × {formatQAR(misc.basisAmount)}</p>
          <p className="text-[11px] text-slate-500 mt-2">Basis: {MISC_BASIS_LABELS[misc.basis as keyof typeof MISC_BASIS_LABELS]}. {misc.itemsCounted} item(s) counted{misc.itemsMissingValue ? `, ${misc.itemsMissingValue} without a value` : ''}. Fixed costs are excluded.</p>
        </Card>
        <Card title="Approved commitments">
          <div className="text-2xl font-bold font-mono text-emerald-700">{formatQAR(data.summary.approvedCommitments)}</div>
          <p className="text-xs text-slate-600 mt-1">{data.summary.approvedItemCount} of {data.summary.itemCount} items have an approved amount.</p>
        </Card>
        <Card title="Source reference check">
          <p className="text-xs text-slate-600">Sum of category estimates — Variant A: <b className="font-mono">{formatQAR(sumA)}</b>; Variant B: <b className="font-mono">{formatQAR(sumB)}</b>.</p>
          <p className="text-xs text-slate-600 mt-1">Fixed costs (source): <b className="font-mono">{formatQAR(data.summary.fixedSourceSubtotal)}</b>.</p>
          <p className="text-[11px] text-slate-500 mt-2">Shown for traceability against the source dashboard. Not a budget.</p>
        </Card>
      </div>

      {cats.length === 0 ? <EmptyState title="No budget categories yet">{admin ? 'Add a category to start.' : ''}</EmptyState> : (['fixed', 'finishing', 'other'] as const).map((kind) => {
        const group = cats.filter((c) => c.kind === kind);
        if (!group.length) return null;
        const fixed = kind === 'fixed';
        const groupItems = group.flatMap((c) => itemsOf(c.id)).filter((i) => !i.archived_at && !data.categories.find((c) => c.id === i.category_id)?.archived_at);
        return (
          <Card key={kind}
            title={fixed ? 'Fixed costs' : kind === 'finishing' ? 'Finishing categories — reference estimates' : 'Other categories'}
            subtitle={fixed ? 'Source amounts from the source dashboard. Editing an amount never creates a payment or marks it paid.' : kind === 'finishing' ? 'Variant A – Individual and Variant B – Al Wathab are reference estimates only.' : undefined}>
            <Table>
              <thead><tr>
                <Th>Category / item</Th>
                {fixed ? <Th className="text-right">Source amount</Th> : <><Th className="text-right">Variant A – Individual</Th><Th className="text-right">Variant B – Al Wathab</Th></>}
                <Th className="text-right">Approved amount</Th><Th className="text-right">Scheduled</Th><Th className="text-right">Paid</Th><Th>Notes / source</Th>{admin && <Th />}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {group.map((c) => (
                  <React.Fragment key={c.id}>
                    <tr className={`bg-slate-50/80 ${c.archived_at ? 'opacity-60' : ''}`}>
                      <td colSpan={fixed ? 6 : 7} className="px-3 py-1.5 text-xs font-bold text-slate-800">
                        <span className="flex flex-wrap items-center gap-2">{c.name}
                          {c.archived_at && <Badge tone="rose">Archived</Badge>}
                          {c.kind === 'finishing' && !c.include_in_misc_basis && <Badge>Excluded from misc basis</Badge>}
                          {c.notes && <span className="font-normal text-[11px] text-slate-500">{c.notes}</span>}
                        </span>
                      </td>
                      {admin && <td className="px-3 py-1 whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" title="Add item" onClick={() => setEditing({ kind: 'item', row: null, categoryId: c.id })}><Plus className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" title="Edit category" onClick={() => setEditing({ kind: 'category', row: c })}><Pencil className="w-3.5 h-3.5" /></Button>
                        {c.archived_at
                          ? <Button size="sm" variant="ghost" title="Restore" onClick={() => act(`${base}/categories/${c.id}/restore`, 'Category restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                          : <Button size="sm" variant="ghost" title="Archive" onClick={() => act(`${base}/categories/${c.id}/archive`, 'Category archived', <>Archive category <b>{c.name}</b>? Its items will be hidden from totals. You can restore it later.</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                      </td>}
                    </tr>
                    {itemsOf(c.id).length === 0 && <tr><td colSpan={8} className="px-3 py-2 text-[11px] text-slate-400">No items</td></tr>}
                    {itemsOf(c.id).map((i) => (
                      <tr key={i.id} className={i.archived_at ? 'opacity-60' : ''}>
                        <Td className="pl-6 text-slate-900">{i.name}{i.quantity !== null && <div className="text-[11px] text-slate-500">{i.quantity} {i.unit}</div>}{i.archived_at && <Badge tone="rose">Archived</Badge>}</Td>
                        {fixed ? <Td className="text-right font-mono whitespace-nowrap">{formatQAR(i.source_amount)}</Td> : <>
                          <Td className="text-right font-mono whitespace-nowrap">{formatQAR(i.source_variant_a)}</Td>
                          <Td className="text-right font-mono whitespace-nowrap">{i.source_variant_b === null ? <span className="text-slate-400">{/not priced/i.test(i.source_status) ? 'Not priced' : '—'}</span> : formatQAR(i.source_variant_b)}</Td>
                        </>}
                        <Td className="text-right font-mono whitespace-nowrap">{i.approved_amount === null ? <NeedsConfirmation /> : <span className="text-emerald-700 font-semibold">{formatQAR(i.approved_amount)}</span>}</Td>
                        <Td className="text-right font-mono whitespace-nowrap">{formatQAR(i.scheduled_amount)}</Td>
                        <Td className="text-right font-mono whitespace-nowrap text-sky-700">{formatQAR(i.paid_amount)}</Td>
                        <Td className="max-w-xs"><div className="text-[11px] text-slate-600">{i.notes}</div>{i.source_label && <div className="text-[10px] text-slate-400">Source: {i.source_label}</div>}</Td>
                        {admin && <Td className="whitespace-nowrap text-right">
                          <Button size="sm" variant="ghost" title="Edit" onClick={() => setEditing({ kind: 'item', row: i })}><Pencil className="w-3.5 h-3.5" /></Button>
                          {i.archived_at
                            ? <Button size="sm" variant="ghost" title="Restore" onClick={() => act(`${base}/items/${i.id}/restore`, 'Item restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                            : <Button size="sm" variant="ghost" title="Archive" onClick={() => act(`${base}/items/${i.id}/archive`, 'Item archived', <>Archive <b>{i.name}</b>? Source values and history are kept; it can be restored.</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                        </Td>}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                <tr className="bg-slate-50 font-semibold">
                  <Td className="text-slate-900">Total (active items)</Td>
                  {fixed ? <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.source_amount)))}</Td> : <>
                    <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.source_variant_a)))}</Td>
                    <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.source_variant_b)))}</Td>
                  </>}
                  <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.approved_amount)))}</Td>
                  <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.scheduled_amount)))}</Td>
                  <Td className="text-right font-mono whitespace-nowrap">{formatQAR(sumMoney(groupItems.map((i) => i.paid_amount)))}</Td>
                  <Td className="text-[11px] font-normal text-slate-500">{fixed ? 'Source fixed cost subtotal' : 'Reference sums — not a budget'}</Td>{admin && <Td />}
                </tr>
              </tbody>
            </Table>
          </Card>
        );
      })}
      {data.references.length > 0 && (
        <Card title="Source dashboard summary figures" subtitle="Preserved exactly as shown in the source. Flagged for review — not an approved budget or a payment commitment. Not recalculated or combined.">
          <Table>
            <thead><tr><Th>Figure</Th><Th className="text-right">Variant A – Individual</Th><Th className="text-right">Variant B – Al Wathab</Th><Th>Review</Th><Th>Note</Th>{admin && <Th />}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.references.map((r) => (
                <tr key={r.id}>
                  <Td className="font-semibold">{r.label}</Td>
                  <Td className="text-right font-mono">{r.variant_a_value === null ? <span className="text-slate-400">Not shown</span> : formatQAR(r.variant_a_value)}</Td>
                  <Td className="text-right font-mono">{r.variant_b_value === null ? <span className="text-slate-400">Not shown</span> : formatQAR(r.variant_b_value)}</Td>
                  <Td><Badge tone={r.review_status === 'Needs review' ? 'amber' : 'slate'}>{r.review_status}</Badge></Td>
                  <Td className="max-w-sm text-[11px]">{r.note}</Td>
                  {admin && <Td><Button size="sm" variant="ghost" onClick={() => setEditing({ kind: 'reference', row: r })}><Pencil className="w-3.5 h-3.5" /></Button></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} wide={editing?.kind === 'item'}
        title={editing?.kind === 'category' ? (editing.row ? 'Edit category' : 'Add category') : editing?.kind === 'item' ? (editing.row ? 'Edit budget item' : 'Add budget item') : 'Source reference'}>
        {editing?.kind === 'category' && (
          <RecordForm initial={editing.row ?? { kind: 'finishing', include_in_misc_basis: true }} mode={editing.row ? 'edit' : 'create'}
            fields={[
              { name: 'name', label: 'Category name', required: true },
              { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'finishing', label: 'Finishing' }, { value: 'fixed', label: 'Fixed cost' }, { value: 'other', label: 'Other' }] },
              { name: 'include_in_misc_basis', label: 'Include in miscellaneous allowance basis (finishing only)', type: 'checkbox', wide: true },
              { name: 'source_label', label: 'Source label' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              if (editing.row) await patch(`${base}/categories/${editing.row.id}`, v); else await post(`${base}/categories`, v);
              toast('Category saved'); setEditing(null); await reload();
            }} />
        )}
        {editing?.kind === 'item' && (() => {
          const catId = editing.row?.category_id ?? editing.categoryId ?? data.categories.find((c) => !c.archived_at)?.id;
          const kind = data.categories.find((c) => c.id === catId)?.kind ?? 'finishing';
          return (
            <RecordForm initial={editing.row ?? { category_id: catId }} mode={editing.row ? 'edit' : 'create'} fields={itemFields(kind)}
              onCancel={() => setEditing(null)}
              onSubmit={async (v) => {
                if (editing.row) await patch(`${base}/items/${editing.row.id}`, v); else await post(`${base}/items`, v);
                toast('Budget item saved'); setEditing(null); await reload();
              }} />
          );
        })()}
        {editing?.kind === 'reference' && (
          <RecordForm initial={editing.row}
            fields={[
              { name: 'review_status', label: 'Review status', type: 'select', options: ['Needs review', 'Reviewed', 'Superseded'].map((x) => ({ value: x, label: x })) },
              { name: 'note', label: 'Review note', type: 'textarea' },
            ]}
            onCancel={() => setEditing(null)}
            onSubmit={async (v) => { await patch(`${base}/references/${editing.row.id}`, v); toast('Saved'); setEditing(null); await reload(); }} />
        )}
      </Modal>
    </div>
  );
}
