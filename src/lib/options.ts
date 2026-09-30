// Consistent, sequence-ordered option lists for "Related …" dropdowns.
import type { MaterialCategory, MaterialItem, Phase, Task } from './types';
import type { Option } from '../components/ui';

const byNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? 1e9) - (b ?? 1e9);

/**
 * Timeline tasks ordered by phase sequence, then task order within the phase.
 * Label: "7.2  Water / flood test and inspection before covering"; grouped under
 * "Phase 7 · Waterproofing and insulation, …" so the phase is visible when searching.
 */
export function timelineTaskOptions(phases: Phase[], tasks: Task[], opts: { excludeId?: string } = {}): Option[] {
  const phaseById = new Map(phases.map((p) => [p.id, p]));
  const sortedPhases = [...phases].sort((a, b) => a.seq - b.seq);
  const out: Option[] = [];
  for (const p of sortedPhases) {
    const own = tasks
      .filter((t) => t.phase_id === p.id && t.id !== opts.excludeId)
      .sort((a, b) => byNum(a.sort_order, b.sort_order) || a.name.localeCompare(b.name));
    own.forEach((t, i) => {
      out.push({
        value: t.id,
        label: `${p.seq}.${i + 1}  ${t.name}${t.archived_at ? ' (archived)' : ''}`,
        group: `Phase ${p.seq} · ${shorten(p.name)}`,
      });
    });
  }
  // tasks whose phase is missing (should not happen) go last, still readable
  for (const t of tasks) if (!phaseById.has(t.phase_id) && t.id !== opts.excludeId) out.push({ value: t.id, label: t.name, group: 'Other' });
  return out;
}

/** Material lines ordered by managed category order, then line order. */
export function materialOptions(items: MaterialItem[]): Option[] {
  return [...items]
    .sort((a, b) => byNum(a.category_sort, b.category_sort) || a.category.localeCompare(b.category) || 0)
    .map((m) => ({ value: m.id, label: m.description, group: m.category }));
}

export function categoryOptions(cats: MaterialCategory[], currentId?: string | null): Option[] {
  return [...cats]
    .filter((c) => !c.archived_at || c.id === currentId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((c) => ({ value: c.id, label: c.archived_at ? `${c.name} (archived)` : c.name }));
}

export const labelOf = (opts: Option[], id: string | null | undefined) => (id ? opts.find((o) => o.value === id)?.label.replace(/\s{2,}/g, ' ') ?? '' : '');

function shorten(s: string, n = 48) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
