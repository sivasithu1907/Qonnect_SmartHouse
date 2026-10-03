import React, { useEffect, useMemo, useState } from 'react';
import { Download, FolderOpen, Plus, Tags, Truck } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi, useFocusRecord } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { FocusProps, CategoriesResponse, MaterialCategory, MaterialItem, Member, Project, ScopeNote } from '../lib/types';
import { categoryOptions } from '../lib/options';
import { ManageCategories } from '../components/ManageCategories';
import { todayLocalISO } from '../lib/format';
import { INSPECTION_STATUSES, MATERIAL_STATUSES, SUPPLY_RESPONSIBILITIES, SUPPLY_RESPONSIBILITY_LABELS } from '../../shared/constants';
import { effectiveDeliveryDate, isMaterialOpen } from '../../shared/calc';
import { Attachments } from '../components/Attachments';
import { Badge, Button, Card, EmptyState, inputCls, Kpi, LinkButton, Modal, NeedsConfirmation, Notice, PageHeader, RecordForm, Spinner, StatusBadge, Tabs, useUi, type FieldSpec } from '../components/ui';
import { MaterialSchedule } from '../components/schedule/MaterialSchedule';
import { MaterialDateSummary } from '../components/schedule/ScheduleMarks';
import { MaterialCategorySection, useWideLayout } from '../components/materials/MaterialCategorySection';
import { matchesQuickFilter, QUICK_FILTER_LABELS, QUICK_FILTERS, quickFilterCounts, quickFilterFromFocus, type QuickFilter } from '../lib/materialFilters';

const CONTRACTOR_FIELDS = new Set(['status', 'vendor', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date', 'qty_ordered', 'qty_delivered', 'next_follow_up_date', 'notes', 'document_url']);

export function Materials({ project, focusId, onFocusHandled }: { project: Project } & FocusProps) {
  const base = `/api/projects/${project.id}/materials`;
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<{ items: MaterialItem[]; scopeNotes: ScopeNote[] }>(`${base}${showArchived ? '?includeArchived=1' : ''}`);
  const { user, can } = useSession();
  const full = can('materials.write') && !project.archived_at;
  const contractor = can('materials.contractor') && !project.archived_at;
  const { data: members } = useApi<Member[]>(full ? `/api/projects/${project.id}/members` : null);
  const { data: catData, reload: reloadCats } = useApi<CategoriesResponse>(`/api/projects/${project.id}/categories`);
  const manageCats = can('categories.manage') && !project.archived_at;
  const [catsOpen, setCatsOpen] = useState(false);
  const { toast, confirm } = useUi();
  const [edit, setEdit] = useState<{ row: MaterialItem | null } | null>(null);
  // #/materials/<project>/filter:<name> (dashboard links) opens a quick filter; a record id opens that line
  const linkedFilter = quickFilterFromFocus(focusId);
  const [quick, setQuick] = useState<QuickFilter>(linkedFilter ?? 'all');
  useEffect(() => { if (linkedFilter) { setQuick(linkedFilter); onFocusHandled?.(); } }, [linkedFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  // expanded / collapsed categories; a user's choice wins over the automatic default
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const wide = useWideLayout();
  useFocusRecord(linkedFilter ? null : focusId, data?.items, (m) => m.id, (m) => { setOpenMap((o) => ({ ...o, [m.category_id]: true })); setEdit({ row: m }); }, onFocusHandled);
  const [scopeEdit, setScopeEdit] = useState<{ row: ScopeNote | null; category: MaterialCategory } | null>(null);
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('');
  const [resp, setResp] = useState('');
  const [mine, setMine] = useState(false);
  const [view, setView] = useState<'list' | 'schedule'>('list');

  const today = todayLocalISO();
  const items = useMemo(() => (data?.items ?? []).filter((m) =>
    (!cat || m.category_id === cat) && (!status || m.status === status) && (!resp || m.supply_responsibility === resp) && (!mine || m.assigned_contractor_id === user.id) && matchesQuickFilter(m, quick, today)), [data, cat, status, resp, mine, user.id, quick, today]);
  useEffect(() => { setOpenMap({}); }, [cat, status, resp, mine, quick, showArchived]);
  const quickCounts = useMemo(() => quickFilterCounts(data?.items ?? [], today), [data, today]);
  // groups follow the centrally managed category order; archived categories still show their existing lines
  const categories = useMemo<MaterialCategory[]>(() => {
    const list = [...(catData?.material ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const known = new Set(list.map((c) => c.id));
    for (const m of data?.items ?? []) {
      if (!known.has(m.category_id)) { known.add(m.category_id); list.push({ id: m.category_id, name: m.category, sort_order: 1e9, archived_at: null }); }
    }
    return list;
  }, [catData, data]);

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const live = data.items.filter((m) => !m.archived_at);
  const overdue = live.filter((m) => { const e = effectiveDeliveryDate(m); return isMaterialOpen(m.status) && !m.actual_delivery_date && e.date && e.date < today; });

  const contractors = (members ?? []).filter((u) => u.role === 'contractor');
  const fields = (row: MaterialItem | null): FieldSpec[] => {
    const lock = (name: string) => !full && !CONTRACTOR_FIELDS.has(name);
    const f: FieldSpec[] = [
      { name: 'category_id', label: 'Category', type: 'select', required: true, options: categoryOptions(catData?.material ?? [], row?.category_id),
        help: manageCats ? 'Categories are maintained in Manage categories.' : undefined },
      { name: 'description', label: 'Material / description', required: true },
      { name: 'quantity', label: 'Quantity', type: 'number' },
      { name: 'unit', label: 'Unit' },
      { name: 'amount', label: 'Amount (QAR)', type: 'money' },
      { name: 'supply_responsibility', label: 'Supply responsibility', type: 'select', options: SUPPLY_RESPONSIBILITIES.map((r) => ({ value: r, label: SUPPLY_RESPONSIBILITY_LABELS[r] })) },
      { name: 'responsibility_note', label: 'Responsibility note', wide: true },
      { name: 'vendor', label: 'Contractor / vendor' },
      { name: 'assigned_contractor_id', label: 'Assigned contractor user (can update this line)', type: 'select', nullable: true, options: contractors.map((c) => ({ value: c.id, label: c.name })), hidden: !full },
      { name: 'status', label: 'Status', type: 'select', options: MATERIAL_STATUSES.map((s) => ({ value: s, label: s })) },
      { name: 'required_on_site_date', label: 'Required on site / supply due', type: 'date' },
      { name: 'planned_delivery_date', label: 'Planned delivery', type: 'date' },
      { name: 'confirmed_delivery_date', label: 'Supplier-confirmed delivery', type: 'date' },
      { name: 'revised_delivery_date', label: 'Revised delivery', type: 'date' },
      { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date' },
      { name: 'delivery_date_note', label: 'Delivery date note', placeholder: 'e.g. Contractor confirmation required' },
      { name: 'qty_ordered', label: 'Quantity ordered', type: 'number' },
      { name: 'qty_delivered', label: 'Quantity delivered', type: 'number' },
      { name: 'inspection_status', label: 'Inspection', type: 'select', options: INSPECTION_STATUSES.map((s) => ({ value: s, label: s || '— Not set —' })) },
      { name: 'next_follow_up_date', label: 'Next follow-up', type: 'date' },
      { name: 'document_url', label: 'Document link (e.g. Drive)', type: 'url', wide: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ];
    return f.map((x) => ({ ...x, disabled: row ? lock(x.name) : false }));
  };

  const act = async (url: string, msg: string, q?: React.ReactNode) => {
    if (q && !(await confirm(q, { confirmLabel: 'Archive', danger: true }))) return;
    try { await post(url); toast(msg); await reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const grouped = categories.filter((c) => items.some((m) => m.category_id === c.id));
  const noteFor = (c: MaterialCategory) => data.scopeNotes.find((n) => n.category_id === c.id);
  // open everything when the list is short or filtered; otherwise start with compact category headers
  const filtered = !!(cat || status || resp || mine || quick !== 'all');
  const autoOpen = filtered || items.length <= 20 || grouped.length === 1;
  const perms = { full, canEditRow: (m: MaterialItem) => full || (contractor && m.assigned_contractor_id === user.id) };

  return (
    <div className="space-y-6">
      <PageHeader icon={<Truck className="w-5 h-5" />} title="Material Supply" subtitle={`${project.name} — ${project.code} · one line per material item`}
        actions={<>
          <LinkButton href={project.materials_drive_url} label="Materials Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
          <a href={`/api/projects/${project.id}/reports/materials.csv`}><Button><Download className="w-4 h-4" />CSV</Button></a>
          {manageCats && <Button onClick={() => setCatsOpen(true)}><Tags className="w-4 h-4" />Manage categories</Button>}
          {full && <Button variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-4 h-4" />Material line</Button>}
        </>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Material lines" value={live.length} />
        <Kpi label="Status not confirmed" tone="amber" value={live.filter((m) => m.status === 'Status not confirmed').length} />
        <Kpi label="Responsibility needs confirmation" tone="amber" value={live.filter((m) => m.supply_responsibility === 'needs_confirmation').length} />
        <Kpi label="Overdue deliveries" tone={overdue.length ? 'rose' : 'slate'} value={overdue.length} />
      </div>

      <Notice tone="sky">Quantities, suppliers and delivery confirmations are blank unless entered by an authorised user. Source dates are shown only where the source tracker provides them.</Notice>

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Tabs value={view} onChange={setView} tabs={[{ id: 'list', label: 'List' }, { id: 'schedule', label: 'Schedule' }]} />
          <select className={`${inputCls} !w-auto`} value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived_at ? ' (archived)' : ''}</option>)}</select>
          <select className={`${inputCls} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{MATERIAL_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select className={`${inputCls} !w-auto`} value={resp} onChange={(e) => setResp(e.target.value)}><option value="">All responsibilities</option>{SUPPLY_RESPONSIBILITIES.map((r) => <option key={r} value={r}>{SUPPLY_RESPONSIBILITY_LABELS[r]}</option>)}</select>
          {contractor && <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Assigned to me</label>}
          <label className="flex items-center gap-1.5 text-xs text-slate-600 ml-auto"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        </div>
        <div role="group" aria-label="Quick filters" className="flex flex-wrap items-center gap-1.5 -mt-1 mb-4">
          {QUICK_FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={quick === f} onClick={() => setQuick(f)}
              className={`min-h-9 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold ${quick === f ? 'bg-sky-600 border-sky-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
              {QUICK_FILTER_LABELS[f]}
              <span className={`rounded-full px-1.5 text-[11px] ${quick === f ? 'bg-white/20' : 'bg-slate-100 text-slate-600'}`}>{f === 'all' ? quickCounts.all : quickCounts[f]}</span>
            </button>
          ))}
          {quick === 'no-date' && <span className="text-[11px] text-slate-600">Open a line to enter its required-on-site or delivery dates. Supplier-confirmed dates are entered by an authorised user.</span>}
          {quick === 'responsibility' && <span className="text-[11px] text-slate-600">Open a line to set owner or contractor supply.</span>}
        </div>
        {view === 'schedule' ? (
          data.items.length === 0 ? <EmptyState>No material lines yet.</EmptyState>
            : <MaterialSchedule items={items} categories={categories} today={today} onOpen={(m) => setEdit({ row: m })} />
        ) : grouped.length === 0 ? <EmptyState>{!data.items.length ? 'No material lines yet.' : quick !== 'all' ? `No lines in “${QUICK_FILTER_LABELS[quick]}” with the current filters.` : 'No lines match the filters.'}</EmptyState> : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-600">{items.length} line{items.length === 1 ? '' : 's'} in {grouped.length} categor{grouped.length === 1 ? 'y' : 'ies'}</p>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="min-h-9" onClick={() => setOpenMap(Object.fromEntries(grouped.map((c) => [c.id, true])))}>Expand all</Button>
                <Button size="sm" variant="ghost" className="min-h-9" onClick={() => setOpenMap(Object.fromEntries(grouped.map((c) => [c.id, false])))}>Collapse all</Button>
              </div>
            </div>
            {grouped.map((c) => (
              <MaterialCategorySection key={c.id} category={c} items={items.filter((m) => m.category_id === c.id)} note={noteFor(c)} today={today}
                open={openMap[c.id] ?? autoOpen} onToggle={() => setOpenMap((o) => ({ ...o, [c.id]: !(o[c.id] ?? autoOpen) }))}
                wide={wide} perms={perms} onOpenLine={(m) => setEdit({ row: m })}
                onArchive={(m) => act(`${base}/${m.id}/archive`, 'Archived', <>Archive material line <b>{m.description}</b>?</>)}
                onRestore={(m) => act(`${base}/${m.id}/restore`, 'Restored')}
                onEditScope={full ? () => setScopeEdit({ row: noteFor(c) ?? null, category: c }) : undefined} />
            ))}
          </div>
        )}
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.row ? `${edit.row.category} — ${edit.row.description}` : 'Add material line'}
        subtitle={edit?.row && !full ? (edit.row.assigned_contractor_id === user.id ? 'You can update delivery, quantity, vendor and status fields on lines assigned to you.' : 'Read-only') : undefined}>
        {edit && (() => {
          const row = edit.row;
          const canEdit = full || (contractor && row?.assigned_contractor_id === user.id);
          return (
            <div className="space-y-4">
              {canEdit ? (
                <RecordForm fields={fields(row)} initial={row ?? { supply_responsibility: 'needs_confirmation', status: 'Status not confirmed' }} mode={row ? 'edit' : 'create'} onCancel={() => setEdit(null)}
                  extra={row && <Attachments projectId={project.id} entityType="material" entityId={row.id} defaultKind="delivery_note" canUpload={!!canEdit && !row.archived_at} onChange={reload} />}
                  onSubmit={async (v) => {
                    if (row) await patch(`${base}/${row.id}`, v); else await post(base, v);
                    toast('Material line saved'); setEdit(null); await reload(); await reloadCats();
                  }} />
              ) : (
                <>
                  {contractor && <p className="text-xs text-slate-500">This line is not assigned to you, so it is read-only.</p>}
                  {row && (
                    <div className="space-y-2 border border-slate-200 rounded-lg p-3">
                      <div className="flex flex-wrap items-center gap-1.5"><StatusBadge status={row.status} />
                        {row.supply_responsibility === 'needs_confirmation' ? <NeedsConfirmation /> : <Badge tone={row.supply_responsibility === 'owner' ? 'sky' : 'indigo'}>{SUPPLY_RESPONSIBILITY_LABELS[row.supply_responsibility]}</Badge>}
                        {row.vendor && <span className="text-xs text-slate-600">Vendor: {row.vendor}</span>}</div>
                      <MaterialDateSummary m={row} />
                    </div>
                  )}
                  {row && <Attachments projectId={project.id} entityType="material" entityId={row.id} defaultKind="delivery_note" canUpload={false} onChange={reload} />}
                </>
              )}
            </div>
          );
        })()}
      </Modal>

      <Modal open={!!scopeEdit} onClose={() => setScopeEdit(null)} title={`Scope notes — ${scopeEdit?.category.name ?? ''}`}>
        {scopeEdit && (
          <RecordForm initial={scopeEdit.row} mode={scopeEdit.row ? 'edit' : 'create'}
            fields={[
              { name: 'owner_supply', label: 'Owner supply', type: 'textarea' },
              { name: 'contractor_scope', label: 'Contractor scope', type: 'textarea' },
              { name: 'source_label', label: 'Source label' },
            ]}
            onCancel={() => setScopeEdit(null)}
            onSubmit={async (v) => {
              if (scopeEdit.row) await patch(`${base}/scope-notes/${scopeEdit.row.id}`, v);
              else await post(`${base}/scope-notes`, { ...v, category_id: scopeEdit.category.id });
              toast('Scope notes saved'); setScopeEdit(null); await reload();
            }} />
        )}
      </Modal>

      <Modal open={catsOpen} onClose={() => setCatsOpen(false)} wide title="Manage categories" subtitle={`${project.name} — ${project.code}`}>
        {catsOpen && <ManageCategories projectId={project.id} initialTab="material" onChanged={async () => { await reloadCats(); await reload(); }} />}
      </Modal>
    </div>
  );
}
