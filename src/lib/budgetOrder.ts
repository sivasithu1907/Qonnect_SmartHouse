// One ordering rule for budget categories and items, shared by Master Items & Budget and every
// "Related budget item" selector. It is presentation only: saved records and their sort_order are
// never changed. Rule: category kind (fixed → finishing → other), then the saved sort_order, then
// the name (natural, case-insensitive). Record IDs and created/updated dates are never used; when
// everything is equal the incoming order is kept (stable sort).
import type { Option } from '../components/ui';

export interface OrderCategory { id: string; name: string; kind: string; sort_order: number; archived_at: string | null }
export interface OrderItem { id: string; category_id: string; name: string; sort_order: number; archived_at: string | null }

export const BUDGET_KIND_ORDER = ['fixed', 'finishing', 'other'] as const;
export const BUDGET_KIND_TITLE: Record<string, string> = { fixed: 'Fixed costs', finishing: 'Finishing categories', other: 'Other categories' };

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const kindRank = (k: string) => {
  const i = (BUDGET_KIND_ORDER as readonly string[]).indexOf(k);
  return i < 0 ? BUDGET_KIND_ORDER.length : i;
};
const num = (n: number | null | undefined) => (Number.isFinite(n) ? Number(n) : 0);
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

export function compareBudgetCategories(a: OrderCategory, b: OrderCategory): number {
  return kindRank(a.kind) - kindRank(b.kind) || num(a.sort_order) - num(b.sort_order) || collator.compare(clean(a.name), clean(b.name));
}
export function compareBudgetItems(a: OrderItem, b: OrderItem): number {
  return num(a.sort_order) - num(b.sort_order) || collator.compare(clean(a.name), clean(b.name));
}
export const sortBudgetCategories = <T extends OrderCategory>(cats: readonly T[]): T[] => [...cats].sort(compareBudgetCategories);
export const sortBudgetItems = <T extends OrderItem>(items: readonly T[]): T[] => [...items].sort(compareBudgetItems);

/**
 * Options for a "Related budget item" selector, in budget-page order.
 * - Only active items in active categories are offered for new selections.
 * - `keepId` (the record's current link) stays listed, marked archived, if it was archived since.
 * - Labels show the item name once. A category with a single item of the same name ("Plumbing")
 *   is listed under its kind heading instead of repeating "Plumbing" as heading and item.
 * - The category name stays searchable and is shown as a hint where it adds context.
 */
export function budgetItemOptions(categories: readonly OrderCategory[], items: readonly OrderItem[], keepId?: string | null): Option[] {
  const out: Option[] = [];
  for (const cat of sortBudgetCategories(categories)) {
    const listed = sortBudgetItems(items.filter((i) => i.category_id === cat.id && ((!i.archived_at && !cat.archived_at) || i.id === keepId)));
    if (!listed.length) continue;
    const kindTitle = BUDGET_KIND_TITLE[cat.kind] ?? 'Other categories';
    const selfNamed = listed.length === 1 && clean(listed[0].name).toLowerCase() === clean(cat.name).toLowerCase();
    for (const i of listed) {
      out.push({
        value: i.id,
        label: clean(i.name),
        group: selfNamed ? kindTitle : clean(cat.name),
        hint: selfNamed ? undefined : clean(cat.name),
        keywords: `${cat.name} ${kindTitle}`,
        archived: !!(i.archived_at || cat.archived_at),
      });
    }
  }
  return out;
}
