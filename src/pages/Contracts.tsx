import React, { useMemo, useState } from 'react';
import { Archive, ChevronRight, ExternalLink, FileSignature, FileText, FolderOpen, Info, Pencil, Plus, RotateCcw, Settings2 } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { BudgetResponse, CategoriesResponse, Contract, ContractAmendment, ContractDetail, ContractsResponse, FocusProps, Project } from '../lib/types';
import { formatDate, formatDateTime, formatQAR } from '../lib/format';
import { filterContracts } from '../lib/contractFilters';
import { CONTRACT_STATUSES } from '../../shared/constants';
import { Attachments } from '../components/Attachments';
import { ManageCategories } from '../components/ManageCategories';
import { useWideLayout } from '../components/materials/MaterialCategorySection';
import { Badge, Button, Card, EmptyState, inputCls, LinkButton, Modal, Notice, PageHeader, RecordForm, Spinner, StatusBadge, Table, Td, Th, useUi, type FieldSpec } from '../components/ui';

export const NO_AUTO_CHANGES_NOTE = 'Saving a contract or entering its value never changes approved budget amounts, creates payment milestones or marks anything paid.';

type Edit = { kind: 'contract'; row: Contract | ContractDetail | null } | { kind: 'amendment'; contract: ContractDetail; row: ContractAmendment | null };

export function Contracts({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/contracts`;
  const { can } = useSession();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<ContractsResponse>(`${base}${showArchived ? '?includeArchived=1' : ''}`);
  const { data: cats, reload: reloadCats } = useApi<CategoriesResponse>(`/api/projects/${project.id}/categories`);
  const writable = can('contracts.write') && !project.archived_at;
  const { data: budget } = useApi<BudgetResponse>(writable && can('budget.read') ? `/api/projects/${project.id}/budget` : null);
  const wide = useWideLayout();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [detailKey, setDetailKey] = useState(0);
  const { toast } = useUi();
  useFocusRecord(focusId, data?.contracts, (k) => k.id, (k) => setOpenId(k.id), onFocusHandled);

  const rows = useMemo(() => filterContracts(data?.contracts ?? [], { q, categoryId, status }), [data, q, categoryId, status]);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const finance = data.access.finance;
  const categories = cats?.contract ?? [];

  const categoryOptions = (current?: string) => categories
    .filter((c) => !c.archived_at || c.id === current)
    .map((c) => ({ value: c.id, label: c.archived_at ? `${c.name} (archived)` : c.name }));
  const budgetOptions = (budget?.items ?? []).filter((i) => !i.archived_at).map((i) => ({
    value: i.id, label: i.name, group: budget!.categories.find((c) => c.id === i.category_id)?.name ?? '',
  }));

  const contractFields = (row: Contract | ContractDetail | null): FieldSpec[] => [
    { name: 'title', label: 'Contract title', required: true, wide: true },
    { name: 'category_id', label: 'Category', type: 'select', required: true, options: categoryOptions(row?.category_id) },
    { name: 'company_name', label: 'Contractor / company name', required: true },
    { name: 'reference', label: 'Contract reference', placeholder: 'Optional' },
    { name: 'signed_date', label: 'Signed date', type: 'date' },
    { name: 'contract_value', label: 'Contract value (QAR)', type: 'money', hidden: !finance, help: 'Optional. For reference only — it does not change the budget or payments.' },
    { name: 'status', label: 'Status', type: 'select', required: true, options: CONTRACT_STATUSES.map((s) => ({ value: s, label: s })) },
    { name: 'budget_item_id', label: 'Related budget item', type: 'searchselect', nullable: true, options: budgetOptions, hidden: !budget, help: 'Optional link to a budget item in this project.' },
    { name: 'drive_url', label: 'Google Drive folder link', type: 'url', placeholder: 'https://drive.google.com/…', wide: true },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
  const amendmentFields: FieldSpec[] = [
    { name: 'amendment_date', label: 'Amendment date', type: 'date', required: true },
    { name: 'reference', label: 'Amendment reference', placeholder: 'Optional' },
    { name: 'description', label: 'Description', type: 'textarea', required: true, help: 'What the amendment changes. The original contract and its signed file stay unchanged.' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];

  const saveContract = async (row: Contract | ContractDetail | null, v: Record<string, unknown>) => {
    if (row) await patch(`${base}/${row.id}`, v);
    else {
      const created = await post<{ id: string }>(base, { status: 'Draft', ...v });
      setOpenId(created.id);
    }
    toast(row ? 'Contract updated' : 'Contract added');
    setEdit(null);
    setDetailKey((k) => k + 1);
    await reload();
  };
  const saveAmendment = async (e: Extract<Edit, { kind: 'amendment' }>, v: Record<string, unknown>) => {
    if (e.row) await patch(`${base}/amendments/${e.row.id}`, v);
    else await post(`${base}/${e.contract.id}/amendments`, v);
    toast(e.row ? 'Amendment updated' : 'Amendment recorded');
    setEdit(null);
    setDetailKey((k) => k + 1);
    await reload();
  };

  const newDefaults = categories.find((c) => !c.archived_at) ? { category_id: categories.find((c) => !c.archived_at)!.id, status: 'Draft' } : { status: 'Draft' };

  return (
    <div className="space-y-6">
      <PageHeader icon={<FileSignature className="w-5 h-5" />} title="Contracts & Documents"
        subtitle={`${project.name} — ${project.code} · agreements, quotations, BOQs and amendments for this project`}
        actions={<>
          {can('categories.manage') && <Button onClick={() => setCatsOpen(true)}><Settings2 className="w-4 h-4" />Categories</Button>}
          {writable && <Button variant="primary" onClick={() => setEdit({ kind: 'contract', row: null })} disabled={!categories.some((c) => !c.archived_at)}><Plus className="w-4 h-4" />Add contract</Button>}
        </>} />

      {project.archived_at && <Notice tone="amber">This project is archived. Contracts and documents are read-only.</Notice>}
      <p className="flex items-start gap-2 text-xs text-slate-600"><Info className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />{NO_AUTO_CHANGES_NOTE}</p>

      <Card className="relative overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input type="search" className={`${inputCls} sm:max-w-xs`} placeholder="Search title, company, reference…" aria-label="Search contracts" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={`${inputCls} !w-auto`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived_at ? ' (archived)' : ''}</option>)}
          </select>
          <select className={`${inputCls} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {CONTRACT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 sm:ml-auto"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        </div>
        <p className="text-xs text-slate-500 mb-2" aria-live="polite">{rows.length} of {data.contracts.length} contract{data.contracts.length === 1 ? '' : 's'}</p>

        {rows.length === 0 ? (
          <EmptyState title={data.contracts.length === 0 ? 'No contracts recorded yet' : 'No contracts match the filters'}>
            {data.contracts.length === 0 ? (writable ? 'Add each agreement for this project, then upload its signed copy, quotations and BOQs.' : 'Nothing has been added for this project.') : 'Clear the search or filters to see all contracts.'}
          </EmptyState>
        ) : wide ? (
          <Table>
            <thead><tr>
              <Th>Contract</Th><Th className="hidden lg:table-cell">Category</Th><Th>Contractor / company</Th><Th>Signed</Th>
              {finance && <Th className="text-right">Value</Th>}<Th>Status</Th><Th>Documents</Th>
              {finance && <Th className="text-right">Linked payments</Th>}<Th><span className="sr-only">Open</span></Th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((k) => (
                <tr key={k.id} id={`rec-${k.id}`} className={`hover:bg-slate-50/60 cursor-pointer ${k.archived_at ? 'opacity-60' : ''}`} onClick={() => setOpenId(k.id)}>
                  <Td><button type="button" className="text-left font-semibold text-slate-900 hover:text-sky-700" onClick={(e) => { e.stopPropagation(); setOpenId(k.id); }}>{k.title}</button><div className="text-[11px] text-slate-500 lg:hidden">{k.category_name}</div>{k.reference && <div className="text-[11px] text-slate-500">Ref: {k.reference}</div>}</Td>
                  <Td className="hidden lg:table-cell">{k.category_name}</Td>
                  <Td>{k.company_name}</Td>
                  <Td className="whitespace-nowrap">{formatDate(k.signed_date)}</Td>
                  {finance && <Td className="text-right font-mono whitespace-nowrap">{formatQAR(k.contract_value)}</Td>}
                  <Td><StatusBadge status={k.status} />{k.archived_at && <Badge tone="rose">Archived</Badge>}</Td>
                  <Td className="text-xs whitespace-nowrap">{k.attachment_count} file{k.attachment_count === 1 ? '' : 's'}{k.amendment_count > 0 && ` · ${k.amendment_count} amendment${k.amendment_count === 1 ? '' : 's'}`}</Td>
                  {finance && <Td className="text-right text-xs whitespace-nowrap">{k.payments && k.payments.milestoneCount > 0
                    ? <><div className="text-sky-700">Paid {formatQAR(k.payments.paid)}</div><div className="text-amber-800">Pending {formatQAR(k.payments.pending)}</div></>
                    : <span className="text-slate-400">None linked</span>}</Td>}
                  <Td><ChevronRight className="w-4 h-4 text-slate-400" aria-hidden="true" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <ul className="space-y-2" data-testid="contract-cards">
            {rows.map((k) => (
              <li key={k.id} id={`rec-${k.id}`}>
                <button type="button" onClick={() => setOpenId(k.id)} className={`w-full text-left border border-slate-200 rounded-xl p-3 bg-white hover:border-sky-300 ${k.archived_at ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-slate-900 break-words min-w-0">{k.title}</span>
                    <span className="shrink-0"><StatusBadge status={k.status} /></span>
                  </div>
                  <div className="text-xs text-slate-600 mt-1 break-words">{k.company_name} · {k.category_name}</div>
                  <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>Signed {formatDate(k.signed_date)}</span>
                    {finance && <span>Value {formatQAR(k.contract_value)}</span>}
                    <span>{k.attachment_count} file{k.attachment_count === 1 ? '' : 's'}</span>
                    {k.amendment_count > 0 && <span>{k.amendment_count} amendment{k.amendment_count === 1 ? '' : 's'}</span>}
                    {finance && k.payments && k.payments.milestoneCount > 0 && <span>Paid {formatQAR(k.payments.paid)} · Pending {formatQAR(k.payments.pending)}</span>}
                    {k.archived_at && <Badge tone="rose">Archived</Badge>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {openId && !edit && (
        <ContractDetails key={`${openId}-${detailKey}`} project={project} id={openId} writable={writable}
          onClose={() => setOpenId(null)}
          onEdit={(row) => setEdit({ kind: 'contract', row })}
          onAmend={(contract, row) => setEdit({ kind: 'amendment', contract, row })}
          onChanged={async () => { setDetailKey((k) => k + 1); await reload(); }} />
      )}

      <Modal open={edit?.kind === 'contract'} title={edit?.kind === 'contract' && edit.row ? 'Edit contract' : 'Add contract'} onClose={() => setEdit(null)} wide>
        {edit?.kind === 'contract' && (
          <>
            <p className="text-xs text-slate-500 mb-3">{NO_AUTO_CHANGES_NOTE}</p>
            <RecordForm fields={contractFields(edit.row)} initial={edit.row ?? newDefaults} mode={edit.row ? 'edit' : 'create'} onCancel={() => setEdit(null)} onSubmit={(v) => saveContract(edit.row, v)} />
          </>
        )}
      </Modal>
      <Modal open={edit?.kind === 'amendment'} title={edit?.kind === 'amendment' && edit.row ? 'Edit amendment' : 'Record amendment'} subtitle={edit?.kind === 'amendment' ? edit.contract.title : undefined} onClose={() => setEdit(null)}>
        {edit?.kind === 'amendment' && <RecordForm fields={amendmentFields} initial={edit.row} onCancel={() => setEdit(null)} onSubmit={(v) => saveAmendment(edit, v)} />}
      </Modal>
      <Modal open={catsOpen} title="Contract categories" onClose={() => setCatsOpen(false)} wide>
        <ManageCategories projectId={project.id} kinds={['contract']} initialTab="contract" readOnly={!!project.archived_at}
          onChanged={async () => { await reloadCats(); await reload(); }} />
      </Modal>
    </div>
  );
}

function ContractDetails({ project, id, writable, onClose, onEdit, onAmend, onChanged }: {
  project: Project; id: string; writable: boolean; onClose: () => void;
  onEdit: (row: ContractDetail) => void; onAmend: (contract: ContractDetail, row: ContractAmendment | null) => void; onChanged: () => Promise<void>;
}) {
  const base = `/api/projects/${project.id}/contracts`;
  const { data: k, error } = useApi<ContractDetail>(`${base}/${id}`);
  const { can } = useSession();
  const { toast, confirm } = useUi();
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const editable = writable && !!k && !k.archived_at;

  const act = async (url: string, msg: string, question?: React.ReactNode) => {
    if (question && !(await confirm(question, { confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await onChanged(); } catch (ex) { toast((ex as Error).message, 'error'); }
  };

  return (
    <Modal open title={k?.title ?? 'Contract'} subtitle={k ? `${k.company_name} · ${k.category_name}` : undefined} onClose={onClose} wide>
      {error ? <Notice tone="rose">{error}</Notice> : !k ? <Spinner /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={k.status} />
            {k.archived_at && <Badge tone="rose">Archived</Badge>}
            <span className="flex-1" />
            {editable && <Button size="sm" onClick={() => onEdit(k)}><Pencil className="w-3.5 h-3.5" />Edit</Button>}
            {writable && (k.archived_at
              ? <Button size="sm" onClick={() => act(`${base}/${k.id}/restore`, 'Contract restored')}><RotateCcw className="w-3.5 h-3.5" />Restore</Button>
              : <Button size="sm" variant="ghost" onClick={() => act(`${base}/${k.id}/archive`, 'Contract archived', <>Archive <b>{k.title}</b>? It is hidden from the list but kept with its files and history. Linked payments are not changed.</>)}><Archive className="w-3.5 h-3.5" />Archive</Button>)}
          </div>

          <section aria-labelledby="contract-summary">
            <h3 id="contract-summary" className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Summary</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Field label="Category">{k.category_name}</Field>
              <Field label="Contractor / company">{k.company_name}</Field>
              <Field label="Contract reference">{k.reference || '—'}</Field>
              <Field label="Signed date">{formatDate(k.signed_date)}</Field>
              {'contract_value' in k && <Field label="Contract value">{formatQAR(k.contract_value, { blank: 'Not entered' })}</Field>}
              {'budget_item_name' in k && <Field label="Related budget item">{k.budget_item_name ?? 'Not linked'}</Field>}
              <Field label="Google Drive folder">{k.drive_url ? <a href={k.drive_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 break-all"><FolderOpen className="w-3.5 h-3.5 shrink-0" />Open folder<ExternalLink className="w-3 h-3" /></a> : <LinkButton href="" label="Drive folder" />}</Field>
              <Field label="Added">{formatDateTime(k.created_at)}{k.created_by_name ? ` by ${k.created_by_name}` : ''}</Field>
              {k.notes && <div className="sm:col-span-2"><dt className="text-[11px] font-semibold text-slate-500">Notes</dt><dd className="whitespace-pre-wrap text-slate-800">{k.notes}</dd></div>}
            </dl>
          </section>

          <section aria-labelledby="contract-docs">
            <h3 id="contract-docs" className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Documents</h3>
            <Attachments projectId={project.id} entityType="contract" entityId={k.id} defaultKind="signed_contract" title="Contract documents"
              canUpload={editable} canArchive={(a) => a.kind !== 'signed_contract' || can('projects.manage')} onChange={() => void onChanged()} />
            <p className="text-[11px] text-slate-500 mt-1">Signed contracts are kept as the original agreement — record changes as an amendment below.</p>
          </section>

          <section aria-labelledby="contract-amendments">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 id="contract-amendments" className="text-xs font-bold uppercase tracking-wide text-slate-500">Amendments</h3>
              {editable && <Button size="sm" onClick={() => onAmend(k, null)}><Plus className="w-3.5 h-3.5" />Record amendment</Button>}
            </div>
            {k.amendments.filter((a) => !a.archived_at || writable).length === 0 ? <p className="text-xs text-slate-500">No amendments recorded.</p> : (
              <ul className="space-y-2">
                {k.amendments.filter((a) => !a.archived_at || writable).map((a) => (
                  <li key={a.id} className={`border border-slate-200 rounded-lg p-3 bg-white ${a.archived_at ? 'opacity-60' : ''}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900">{formatDate(a.amendment_date)}{a.reference && <span className="ml-2 text-xs font-normal text-slate-500">Ref: {a.reference}</span>}{a.archived_at && <span className="ml-2"><Badge tone="rose">Archived</Badge></span>}</div>
                        <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{a.description}</p>
                        {a.notes && <p className="text-xs text-slate-500 whitespace-pre-wrap mt-1">{a.notes}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="sm" variant="ghost" onClick={() => setFilesFor(filesFor === a.id ? null : a.id)} aria-expanded={filesFor === a.id}><FileText className="w-3.5 h-3.5" />{a.attachment_count} file{a.attachment_count === 1 ? '' : 's'}</Button>
                        {editable && !a.archived_at && <Button size="sm" variant="ghost" onClick={() => onAmend(k, a)} title="Edit amendment" aria-label="Edit amendment"><Pencil className="w-3.5 h-3.5" /></Button>}
                        {editable && (a.archived_at
                          ? <Button size="sm" variant="ghost" title="Restore amendment" aria-label="Restore amendment" onClick={() => act(`${base}/amendments/${a.id}/restore`, 'Amendment restored')}><RotateCcw className="w-3.5 h-3.5" /></Button>
                          : <Button size="sm" variant="ghost" title="Archive amendment" aria-label="Archive amendment" onClick={() => act(`${base}/amendments/${a.id}/archive`, 'Amendment archived', <>Archive the amendment dated <b>{formatDate(a.amendment_date)}</b>? It is kept in history.</>)}><Archive className="w-3.5 h-3.5" /></Button>)}
                      </div>
                    </div>
                    {filesFor === a.id && (
                      <div className="mt-2">
                        <Attachments projectId={project.id} entityType="contract_amendment" entityId={a.id} defaultKind="amendment" title="Amendment documents"
                          canUpload={editable && !a.archived_at} onChange={() => void onChanged()} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {k.payments && (
            <section aria-labelledby="contract-payments">
              <h3 id="contract-payments" className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Linked payments</h3>
              {k.payments.milestones.length === 0 ? (
                <p className="text-xs text-slate-500">No payment milestones reference this contract. Link one from the Payments page (edit a milestone → Contract).</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3 text-sm">
                    <Mini label="Scheduled" value={formatQAR(k.payments.summary.scheduled)} />
                    <Mini label="Paid (actual transfers)" value={formatQAR(k.payments.summary.paid)} tone="text-sky-700" />
                    <Mini label="Pending" value={formatQAR(k.payments.summary.pending)} tone="text-amber-800" />
                  </div>
                  <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
                    {k.payments.milestones.map((m) => (
                      <li key={m.id} className={m.archived_at ? 'opacity-60' : ''}>
                        <a href={`#/payments/${project.id}/${m.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 no-underline hover:bg-slate-50">
                          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-900 break-words">{m.description}</span><span className="block text-[11px] text-slate-500">{m.payee_name} · due {formatDate(m.due_date)}</span></span>
                          <span className="text-xs font-mono text-right"><span className="block">{formatQAR(m.balance.scheduled)}</span><span className="block text-sky-700">paid {formatQAR(m.balance.paid)}</span></span>
                          <StatusBadge status={m.balance.derivedStatus} />{m.archived_at && <Badge tone="rose">Archived</Badge>}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-slate-500 mt-1">Totals exclude archived milestones and use the same balances as the Payments page.</p>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11px] font-semibold text-slate-500">{label}</dt><dd className="text-slate-800 break-words">{children}</dd></div>;
}
function Mini({ label, value, tone = 'text-slate-900' }: { label: string; value: string; tone?: string }) {
  return <div className="border border-slate-200 rounded-lg px-3 py-2 bg-white"><div className="text-[11px] text-slate-500">{label}</div><div className={`font-mono font-semibold ${tone}`}>{value}</div></div>;
}
