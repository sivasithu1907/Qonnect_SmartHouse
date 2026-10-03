// Quick filters for Material Supply. They only read saved values; nothing is filled in.
import { AWAITING_CONFIRMATION_STATUSES, effectiveDeliveryDate, isMaterialOpen } from '../../shared/calc';
import type { MaterialItem } from './types';

export const QUICK_FILTERS = ['all', 'overdue', 'no-date', 'awaiting', 'responsibility'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

export const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  all: 'All lines',
  overdue: 'Overdue delivery',
  responsibility: 'Responsibility needs confirmation',
  'no-date': 'No dates yet',
  awaiting: 'Awaiting confirmation',
};

export const hasAnyMaterialDate = (m: Pick<MaterialItem, 'required_on_site_date' | 'planned_delivery_date' | 'confirmed_delivery_date' | 'revised_delivery_date' | 'actual_delivery_date'>) =>
  !!(m.required_on_site_date || m.planned_delivery_date || m.confirmed_delivery_date || m.revised_delivery_date || m.actual_delivery_date);

/** Same rule as the dashboard: open line, no actual delivery, expected date already passed. */
export const isOverdueLine = (m: MaterialItem, today: string) => {
  const e = effectiveDeliveryDate(m);
  return isMaterialOpen(m.status) && !m.actual_delivery_date && !!e.date && e.date < today;
};

export function matchesQuickFilter(m: MaterialItem, f: QuickFilter, today: string): boolean {
  if (f === 'overdue') return isOverdueLine(m, today);
  if (f === 'responsibility') return m.supply_responsibility === 'needs_confirmation';
  if (f === 'no-date') return !hasAnyMaterialDate(m);
  if (f === 'awaiting') return AWAITING_CONFIRMATION_STATUSES.has(m.status);
  return true;
}

/** Counts over live (non-archived) lines, for the filter chips. */
export function quickFilterCounts(items: MaterialItem[], today: string): Record<QuickFilter, number> {
  const live = items.filter((m) => !m.archived_at);
  return Object.fromEntries(QUICK_FILTERS.map((f) => [f, live.filter((m) => matchesQuickFilter(m, f, today)).length])) as Record<QuickFilter, number>;
}

/** Deep-link value used in #/materials/<project>/filter:<name> (from the dashboard). */
export function quickFilterFromFocus(focusId: string | null | undefined): QuickFilter | null {
  const m = /^filter:([a-z-]+)$/.exec(focusId ?? '');
  return m && (QUICK_FILTERS as readonly string[]).includes(m[1]) ? (m[1] as QuickFilter) : null;
}
