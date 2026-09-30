import React, { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, CreditCard, Download, FolderOpen, Paperclip, Pencil, Plus, RotateCcw } from 'lucide-react';
import { ApiError, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { BudgetResponse, PaymentMilestone, PaymentsResponse, PaymentTransaction, Project } from '../lib/types';
import { formatDate, formatQAR, todayLocalISO } from '../lib/format';
import { PAYEE_TYPE_LABELS, PAYEE_TYPES, PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '../../shared/constants';
import { Attachments } from '../components/Attachments';
import { Badge, Button, Card, EmptyState, inputCls, Kpi, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, StatusBadge, Table, Td, Th, useUi, type FieldSpec } from '../components/ui';

type Edit = { kind: 'milestone'; row: PaymentMilestone | null } | { kind: 'tx'; milestone: PaymentMilestone; row: PaymentTransaction | null };

export function Payments({ project }: { project: Project }) {
  const base = `/api/projects/${project.id}/payments`;
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<PaymentsResponse>(`${base}${showArchived ? '?includeArchived=1' : ''}`);
  const { data: budget } = useApi<BudgetResponse>(`/api/projects/${project.id}/budget`);
  const { can } = useSession();
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [payee, setPayee] = useState('');
  const [status, setStatus] = useState('');
  const writable = can('payments.write') && !project.archived_at;

  const rows = useMemo(() => (data?.milestones ?? []).filter((m) => {
    const s = q.toLowerCase();
    const txt = [m.payee_name, m.description, m.po_contract_ref, m.invoice_ref, m.cost_category, ...m.transactions.map((t) => t.reference)].join(' ').toLowerCase();
    return (!s || txt.includes(s)) && (!payee || m.payee_type === payee) && (!status || m.balance.derivedStatus === status);
  }), [data, q, payee, status]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const t = data.totals;
  const budgetOptions = (budget?.items ?? []).filter((i) => !i.archived_at).map((i) => ({
    value: i.id, label: `${budget!.categories.find((c) => c.id === i.category_id)?.name ?? ''} · ${i.name}`,
  }));

  const milestoneFields: FieldSpec[] = [
    { name: 'payee_type', label: 'Payee type', type: 'select', options: PAYEE_TYPES.map((p) => ({ value: p, label: PAYEE_TYPE_LABELS[p] })), required: true },
    { name: 'payee_name', label: 'Payee name', required: true },
    { name: 'cost_category', label: 'Cost category' },
    { name: 'budget_item_id', label: 'Related master budget item', type: 'select', nullable: true, options: budgetOptions },
    { name: 'po_contract_ref', label: 'PO / contract reference' },
    { name: 'invoice_ref', label: 'Invoice reference' },
    { name: 'description', label: 'Milestone / description', required: true, wide: true },
    { name: 'due_date', label: 'Scheduled due date', type: 'date' },
    { name: 'scheduled_amount', label: 'Scheduled amount (QAR)', type: 'money', required: true },
    { name: 'status', label: 'Schedule status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'on_hold', label: 'On hold' }, { value: 'cancelled', label: 'Cancelled' }] },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  const txFields: FieldSpec[] = [
    { name: 'amount', label: 'Amount transferred (QAR)', type: 'money', required: true },
    { name: 'paid_date', label: 'Actual transfer date', type: 'date', required: true, help: 'Only record money that has actually been paid.' },
    { name: 'method', label: 'Method', type: 'select', options: PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] })), required: true },
    { name: 'reference', label: 'Bank / cheque reference', help: 'Duplicate references within this project are blocked.' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const saveTx = async (e: Extract<Edit, { kind: 'tx' }>, v: Record<string, unknown>, allow = false): Promise<void> => {
    const body = allow ? { ...v, allow_overpayment: true } : v;
    try {
      if (e.row) await patch(`${base}/transactions/${e.row.id}`, body);
      else await post(`${base}/milestones/${e.milestone.id}/transactions`, body);
    } catch (ex) {
      if (ex instanceof ApiError && ex.details?.code === 'OVERPAYMENT' && !allow) {
        if (await confirm(<>This transfer exceeds the scheduled amount for <b>{e.milestone.description}</b>. Record it anyway? It will be flagged as an overpayment.</>, { title: 'Overpayment', confirmLabel: 'Record overpayment', danger: true })) {
          return saveTx(e, v, true);
        }
        throw new Error('Not recorded — overpayment was not confirmed.');
      }
      throw ex;
    }
    toast('Transfer recorded');
    setEdit(null);
    setOpen((o) => ({ ...o, [e.milestone.id]: true }));
    await reload();
  };

  const act = async (url: string, msg: string, question?: React.ReactNode) => {
    if (question && !(await confirm(question, { confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await reload(); } catch (ex) { toast((ex as Error).message, 'error'); }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={<CreditCard className="w-5 h-5" />} title="Payments" subtitle={`${project.name} — ${project.code} · scheduled milestones and actual transfers`}
        actions={<>
          <LinkButton href={project.payments_drive_url} label="Payments Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          <a href={`/api/projects/${project.id}/reports/payments.csv`}><Button><Download className="w-4 h-4" />CSV</Button></a>
          {writable && <Button variant="primary" onClick={() => setEdit({ kind: 'milestone', row: null })}><Plus className="w-4 h-4" />Schedule payment</Button>}
        </>} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Kpi label="Scheduled" value={formatQAR(t.scheduled)} hint={`${t.milestoneCount} milestone(s)`} />
        <Kpi label="Paid (actual transfers)" tone="sky" value={formatQAR(t.paid)} hint={`${t.transactionCount} transfer(s)`} />
        <Kpi label="Pending balance" tone="amber" value={formatQAR(t.pending)} hint="Scheduled minus transfers" />
        <Kpi label="Overdue" tone={t.overdue ? 'rose' : 'slate'} value={formatQAR(t.overdue)} hint={`${t.overdueCount} milestone(s)`} />
        <Kpi label="Overpaid" tone={t.overpaid ? 'rose' : 'slate'} value={formatQAR(t.overpaid)} hint={`${t.overpaidCount} milestone(s)`} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input className={`${inputCls} max-w-xs`} placeholder="Search payee, reference, PO…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={`${inputCls} !w-auto`} value={payee} onChange={(e) => setPayee(e.target.value)}>
            <option value="">All payees</option>{PAYEE_TYPES.map((p) => <option key={p} value={p}>{PAYEE_TYPE_LABELS[p]}</option>)}
          </select>
          <select className={`${inputCls} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{['Unpaid', 'Partially paid', 'Paid', 'Overpaid', 'Overdue', 'On hold', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 ml-auto"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        </div>
        {rows.length === 0 ? (
          <EmptyState>{data.milestones.length === 0 ? 'No payments recorded. Paid is QAR 0.00 until real transfers are entered.' : 'No payments match the filters.'}</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th /><Th>Payee</Th><Th>Milestone</Th><Th>Refs</Th><Th>Due</Th><Th className="text-right">Scheduled</Th><Th className="text-right">Paid</Th><Th className="text-right">Pending</Th><Th>Status</Th>{writable && <Th />}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m) => (
                <React.Fragment key={m.id}>
                  <tr className={`${m.archived_at ? 'opacity-60' : ''} hover:bg-slate-50/60`}>
                    <Td><button onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))} className="p-0.5 text-slate-500" aria-label="Toggle transfers">{open[m.id] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                    <Td><div className="font-semibold text-slate-900">{m.payee_name}</div><div className="text-[11px] text-slate-500">{PAYEE_TYPE_LABELS[m.payee_type as keyof typeof PAYEE_TYPE_LABELS]}{m.cost_category ? ` · ${m.cost_category}` : ''}</div></Td>
                    <Td><div>{m.description}</div>{m.budget_item_name && <div className="text-[11px] text-slate-500">Budget: {m.budget_item_name}</div>}</Td>
                    <Td className="text-[11px]">{m.po_contract_ref && <div>PO/Contract: {m.po_contract_ref}</div>}{m.invoice_ref && <div>Invoice: {m.invoice_ref}</div>}</Td>
                    <Td className="whitespace-nowrap">{formatDate(m.due_date)}</Td>
                    <Td className="text-right font-mono">{formatQAR(m.scheduled_amount)}</Td>
                    <Td className="text-right font-mono text-sky-700">{formatQAR(m.balance.paid)}</Td>
                    <Td className="text-right font-mono text-amber-800">{formatQAR(m.balance.pending)}{m.balance.overpaid > 0 && <div className="text-rose-700 text-[10px]">+{formatQAR(m.balance.overpaid)} over</div>}</Td>
                    <Td><StatusBadge status={m.balance.derivedStatus} />{m.archived_at && <Badge tone="rose">Archived</Badge>}</Td>
                    {writable && <Td className="whitespace-nowrap text-right">
                      {!m.archived_at && <Button size="sm" variant="success" onClick={() => setEdit({ kind: 'tx', milestone: m, row: null })}>Record transfer</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'milestone', row: m })}><Pencil className="w-3.5 h-3.5" /></Button>
                      {m.archived_at
                        ? <Button size="sm" variant="ghost" onClick={() => act(`${base}/milestones/${m.id}/restore`, 'Restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                        : <Button size="sm" variant="ghost" onClick={() => act(`${base}/milestones/${m.id}/archive`, 'Archived', <>Archive milestone <b>{m.description}</b>? It is removed from totals but kept in history.</>)}><Archive className="w-3.5 h-3.5" /></Button>}
                    </Td>}
                  </tr>
                  {open[m.id] && (
                    <tr><td colSpan={10} className="bg-slate-50/70 px-4 py-3">
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        <div className="lg:col-span-2">
                          <p className="text-xs font-bold text-slate-700 mb-2">Actual transfers</p>
                          {m.transactions.length === 0 ? <p className="text-xs text-slate-500">No transfers recorded — nothing has been paid against this milestone.</p> : (
                            <ul className="space-y-2">
                              {m.transactions.map((tx) => (
                                <li key={tx.id} className={`bg-white border border-slate-200 rounded-lg p-2.5 ${tx.archived_at ? 'opacity-60' : ''}`}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-xs"><b className="font-mono">{formatQAR(tx.amount)}</b> · {formatDate(tx.paid_date)} · {PAYMENT_METHOD_LABELS[tx.method as keyof typeof PAYMENT_METHOD_LABELS]}{tx.reference && <> · Ref <span className="font-mono">{tx.reference}</span></>}{tx.archived_at && <Badge tone="rose">Voided</Badge>}
                                      {tx.notes && <div className="text-[11px] text-slate-500">{tx.notes}</div>}</div>
                                    <div className="flex items-center gap-1">
                                      <Button size="sm" variant="ghost" onClick={() => setOpen((o) => ({ ...o, [`tx-${tx.id}`]: !o[`tx-${tx.id}`] }))}><Paperclip className="w-3.5 h-3.5" />{tx.attachment_count}</Button>
                                      {writable && !tx.archived_at && <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: 'tx', milestone: m, row: tx })}><Pencil className="w-3.5 h-3.5" /></Button>}
                                      {writable && (tx.archived_at
                                        ? <Button size="sm" variant="ghost" onClick={() => act(`${base}/transactions/${tx.id}/restore`, 'Transfer restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                                        : <Button size="sm" variant="ghost" onClick={() => act(`${base}/transactions/${tx.id}/archive`, 'Transfer voided', <>Void this transfer of <b>{formatQAR(tx.amount)}</b>? It will no longer count as paid. The record is kept in the audit history.</>)}><Archive className="w-3.5 h-3.5" /></Button>)}
                                    </div>
                                  </div>
                                  {open[`tx-${tx.id}`] && <div className="mt-2"><Attachments projectId={project.id} entityType="payment_transaction" entityId={tx.id} defaultKind="payment_slip" canUpload={writable && !tx.archived_at} onChange={reload} /></div>}
                                </li>
                              ))}
                            </ul>
                          )}
                          {m.notes && <p className="text-[11px] text-slate-500 mt-2">Notes: {m.notes}</p>}
                        </div>
                        <Attachments projectId={project.id} entityType="payment_milestone" entityId={m.id} defaultKind="supporting_document" canUpload={writable && !m.archived_at} />
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide={edit?.kind === 'milestone'}
        title={edit?.kind === 'milestone' ? (edit.row ? 'Edit payment milestone' : 'Schedule payment milestone') : edit?.row ? 'Edit transfer' : 'Record actual transfer'}
        subtitle={edit?.kind === 'tx' ? `${edit.milestone.payee_name} — ${edit.milestone.description} · pending ${formatQAR(edit.milestone.balance.pending)}` : 'A scheduled milestone is not a payment. Record transfers separately when money is actually paid.'}>
        {edit?.kind === 'milestone' && (
          <RecordForm fields={milestoneFields} initial={edit.row ?? { payee_type: 'contractor', status: 'active' }} mode={edit.row ? 'edit' : 'create'} onCancel={() => setEdit(null)}
            onSubmit={async (v) => {
              if (edit.row) await patch(`${base}/milestones/${edit.row.id}`, v); else await post(`${base}/milestones`, v);
              toast('Milestone saved'); setEdit(null); await reload();
            }} />
        )}
        {edit?.kind === 'tx' && (
          <RecordForm fields={txFields} mode={edit.row ? 'edit' : 'create'}
            initial={edit.row ?? { amount: edit.milestone.balance.pending || '', paid_date: todayLocalISO(), method: 'bank_transfer' }}
            onCancel={() => setEdit(null)} onSubmit={(v) => saveTx(edit, v)} />
        )}
      </Modal>
    </div>
  );
}
