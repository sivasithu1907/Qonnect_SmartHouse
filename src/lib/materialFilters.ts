// Quick filters for Material Supply. They only read saved values; nothing is filled in.
// Overdue / dates use the shared simplified schedule (owner delivery or contractor work).
import { AWAITING_CONFIRMATION_STATUSES } from '../../shared/calc';
import { hasAnySchedule, isScheduleOverdue, materialSchedule } from '../../shared/materialSchedule';
import type { MaterialItem } from './types';

export const QUICK_FILTERS = ['all', 'overdue', 'review', 'no-date', 'awaiting', 'responsibility'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

export const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  all: 'All lines',
  overdue: 'Overdue',
  review: 'Dates need review',
  responsibility: 'Responsibility needs confirmation',
  'no-date': 'No dates yet',
  awaiting: 'Awaiting confirmation',
};

export const hasAnyMaterialDate = (m: MaterialItem) => hasAnySchedule(materialSchedule(m));

/** Same rule as the dashboard and reminders: outstanding delivery / work whose deadline has passed. */
export const isOverdueLine = (m: MaterialItem, today: string) => isScheduleOverdue(materialSchedule(m), today);
export const needsDateReview = (m: MaterialItem) => materialSchedule(m).needsReview;

export function matchesQuickFilter(m: MaterialItem, f: QuickFilter, today: string): boolean {
  if (f === 'overdue') return isOverdueLine(m, today);
  if (f === 'review') return needsDateReview(m);
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

/** Overdue live lines split into material deliveries and contractor work (never pooled in labels). */
export function overdueSplit(items: MaterialItem[], today: string) {
  let deliveries = 0;
  let work = 0;
  for (const m of items) {
    if (m.archived_at) continue;
    const s = materialSchedule(m);
    if (!isScheduleOverdue(s, today)) continue;
    if (s.workflow === 'contractor' && !s.deadline?.legacy) work++; else deliveries++;
  }
  return { deliveries, work, total: deliveries + work };
}

/** Per-category header counts over the lines currently shown (archived lines count only towards the total). */
export function categorySummary(items: MaterialItem[], today: string) {
  const live = items.filter((m) => !m.archived_at);
  return {
    total: items.length,
    overdue: live.filter((m) => isOverdueLine(m, today)).length,
    review: live.filter((m) => needsDateReview(m)).length,
    noDate: live.filter((m) => !hasAnyMaterialDate(m)).length,
    awaiting: live.filter((m) => AWAITING_CONFIRMATION_STATUSES.has(m.status)).length,
  };
}
