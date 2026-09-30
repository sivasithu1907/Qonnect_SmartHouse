import React, { useState } from 'react';
import { Archive, ArrowDown, ArrowUp, Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { api, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { BudgetCategory, CategoriesResponse, MaterialCategory } from '../lib/types';
import { Badge, Button, EmptyState, inputCls, Notice, Spinner, Tabs, useUi } from './ui';

type Kind = 'budget' | 'material';
type Row = (BudgetCategory | MaterialCategory) & { usage_count?: number; active_count?: number };

const KIND_LABEL: Record<string, string> = { finishing: 'Finishing', fixed: 'Fixed cost', other: 'Other' };

/**
 * Admin-only, project-scoped category management: add, rename, reorder, archive / restore and
 * delete (only when unused). Budget categories group budget items; material categories group
 * material supply lines. Records are never changed except for following a rename.
 */
export function ManageCategories({ projectId, initialTab = 'budget', onChanged, readOnly }: {
  projectId: string; initialTab?: Kind; onChanged?: () => void; readOnly?: boolean;
}) {
  const base = `/api/projects/${projectId}/categories`;
  const { data, error, reload } = useApi<CategoriesResponse>(base);
  const [tab, setTab] = useState<Kind>(initialTab);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'finishing' | 'fixed' | 'other'>('finishing');
  const [busy, setBusy] = useState(false);
  const { toast, confirm } = useUi();

  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const all: Row[] = tab === 'budget' ? data.budget : data.material;
  const rows = all.filter((c) => showArchived || !c.archived_at);
  const archivedCount = all.filter((c) => c.archived_at).length;

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      await reload();
      onChanged?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!newName.trim()) return;
    void run(() => post(`${base}/${tab}`, tab === 'budget' ? { name: newName, kind: newKind } : { name: newName }), `Added “${newName.trim()}”`).then(() => setNewName(''));
  };
  const saveRename = (c: Row) => {
    if (!draft.trim() || draft.trim() === c.name) { setEditing(null); return; }
    void run(() => patch(`${base}/${tab}/${c.id}`, { name: draft }), `Renamed to “${draft.trim()}”`).then(() => setEditing(null));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const ids = all.map((c) => c.id);
    const visible = rows.map((c) => c.id);
    const a = ids.indexOf(visible[idx]);
    const b = ids.indexOf(visible[idx + dir]);
    if (a < 0 || b < 0) return;
    [ids[a], ids[b]] = [ids[b], ids[a]];
    void run(() => post(`${base}/${tab}/reorder`, { ids }), 'Order saved');
  };
  const archive = async (c: Row) => {
    const n = c.active_count ?? 0;
    const msg = tab === 'budget'
      ? <>Archive <b>{c.name}</b>? It disappears from the category dropdown and its {n} active item(s) are hidden from budget totals. Nothing is deleted and you can restore it.</>
      : <>Archive <b>{c.name}</b>? It disappears from the category dropdown for new material lines. Its {n} existing line(s) stay unchanged. You can restore it.</>;
    if (await confirm(msg, { title: 'Archive category', confirmLabel: 'Archive', danger: true })) {
      await run(() => post(`${base}/${tab}/${c.id}/archive`), `Archived “${c.name}”`);
    }
  };
  const remove = async (c: Row) => {
    if (!(await confirm(<>Delete <b>{c.name}</b> permanently? This is only possible because no records use it.</>, { title: 'Delete category', confirmLabel: 'Delete', danger: true }))) return;
    await run(() => api('DELETE', `${base}/${tab}/${c.id}`), `Deleted “${c.name}”`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onChange={(t) => { setTab(t); setEditing(null); }} tabs={[
          { id: 'budget', label: 'Budget categories', count: data.budget.filter((c) => !c.archived_at).length },
          { id: 'material', label: 'Material categories', count: data.material.filter((c) => !c.archived_at).length },
        ]} />
        {archivedCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived ({archivedCount})</label>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {tab === 'budget'
          ? 'Budget categories group the Master Items & Budget lines and appear in the budget item form. The order here is the order used everywhere.'
          : 'Material categories group the material supply lines and appear as the category dropdown in the material line form.'}
        {' '}Categories belong to this project only. A category used by any record cannot be deleted — archive it instead.
      </p>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} !w-auto flex-1 min-w-[200px]`} placeholder={`New ${tab} category name`} value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="New category name" />
          {tab === 'budget' && (
            <select className={`${inputCls} !w-auto`} value={newKind} onChange={(e) => setNewKind(e.target.value as typeof newKind)} aria-label="Category type">
              <option value="finishing">Finishing</option><option value="fixed">Fixed cost</option><option value="other">Other</option>
            </select>
          )}
          <Button variant="primary" onClick={add} busy={busy} disabled={!newName.trim()}><Plus className="w-4 h-4" />Add category</Button>
        </div>
      )}

      {rows.length === 0 ? <EmptyState title="No categories yet" /> : (
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
          {rows.map((c, idx) => (
            <li key={c.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${c.archived_at ? 'bg-slate-50 opacity-75' : ''}`}>
              <span className="w-6 text-right text-[11px] font-mono text-slate-400">{idx + 1}</span>
              <div className="flex-1 min-w-[180px]">
                {editing === c.id ? (
                  <div className="flex items-center gap-1">
                    <input data-autofocus autoFocus className={`${inputCls} !py-1`} value={draft} onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveRename(c); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} aria-label="Category name" />
                    <Button size="sm" variant="primary" onClick={() => saveRename(c)} title="Save name"><Check className="w-3.5 h-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)} title="Cancel"><X className="w-3.5 h-3.5" /></Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">{c.name}</span>
                    {'kind' in c && <Badge tone={c.kind === 'fixed' ? 'indigo' : 'slate'}>{KIND_LABEL[c.kind]}</Badge>}
                    {'kind' in c && c.kind === 'finishing' && !c.include_in_misc_basis && <Badge>Excluded from misc basis</Badge>}
                    {c.archived_at && <Badge tone="rose">Archived</Badge>}
                    <span className="text-[11px] text-slate-500">· used by {c.usage_count ?? 0} record(s)</span>
                  </div>
                )}
              </div>
              {!readOnly && editing !== c.id && (
                <div className="flex items-center gap-0.5">
                  <Button size="sm" variant="ghost" title="Move up" disabled={busy || idx === 0} onClick={() => move(idx, -1)}><ArrowUp className="w-3.5 h-3.5" /></Button>
                  <Button size="sm" variant="ghost" title="Move down" disabled={busy || idx === rows.length - 1} onClick={() => move(idx, 1)}><ArrowDown className="w-3.5 h-3.5" /></Button>
                  <Button size="sm" variant="ghost" title="Rename" onClick={() => { setEditing(c.id); setDraft(c.name); }}><Pencil className="w-3.5 h-3.5" /></Button>
                  {'kind' in c && c.kind === 'finishing' && (
                    <Button size="sm" variant="ghost" title={c.include_in_misc_basis ? 'Exclude from misc allowance basis' : 'Include in misc allowance basis'}
                      onClick={() => run(() => patch(`${base}/budget/${c.id}`, { include_in_misc_basis: !c.include_in_misc_basis }), 'Misc basis updated')}>
                      <span className="text-[10px] font-bold">{c.include_in_misc_basis ? 'Misc ✓' : 'Misc ✗'}</span>
                    </Button>
                  )}
                  {c.archived_at
                    ? <Button size="sm" variant="ghost" title="Restore" onClick={() => run(() => post(`${base}/${tab}/${c.id}/restore`), `Restored “${c.name}”`)}><RotateCcw className="w-3.5 h-3.5" /></Button>
                    : <Button size="sm" variant="ghost" title="Archive" onClick={() => archive(c)}><Archive className="w-3.5 h-3.5" /></Button>}
                  <Button size="sm" variant="ghost" title={(c.usage_count ?? 0) > 0 ? 'In use — archive instead' : 'Delete (unused)'}
                    onClick={() => (c.usage_count ?? 0) > 0
                      ? toast(`“${c.name}” is used by ${c.usage_count} record(s), so it can’t be deleted. Archive it instead — existing records stay unchanged.`, 'error')
                      : remove(c)}>
                    <Trash2 className={`w-3.5 h-3.5 ${(c.usage_count ?? 0) > 0 ? 'text-slate-300' : 'text-rose-500'}`} />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
