// "Related budget item" selector: one shared order with Master Items & Budget, clean labels, archived
// links kept, project isolation, and linking never changes payment amounts. Isolated test fixtures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Agent, type Ctx } from './helpers';
import { budgetItemOptions, compareBudgetCategories, sortBudgetCategories, sortBudgetItems, type OrderCategory, type OrderItem } from '../src/lib/budgetOrder';

const cat = (id: string, name: string, kind: string, sort_order: number, archived_at: string | null = null): OrderCategory => ({ id, name, kind, sort_order, archived_at });
const item = (id: string, category_id: string, name: string, sort_order: number, archived_at: string | null = null): OrderItem => ({ id, category_id, name, sort_order, archived_at });

describe('shared budget ordering (pure)', () => {
  it('orders by kind, then saved sort order, then name — never by id or dates', () => {
    const cats = [cat('z1', 'Window', 'finishing', 2), cat('a9', 'Fixed Costs', 'fixed', 5), cat('m1', 'Paint', 'finishing', 1), cat('b2', 'Misc works', 'other', 0),
      cat('c3', 'Doors', 'finishing', 2), cat('d4', 'New kind', 'something', 0)];
    expect(sortBudgetCategories(cats).map((c) => c.name)).toEqual(['Fixed Costs', 'Paint', 'Doors', 'Window', 'Misc works', 'New kind']);
    // ids in reverse alphabetical order don't matter
    expect(compareBudgetCategories(cat('zzz', 'A', 'finishing', 1), cat('aaa', 'B', 'finishing', 1))).toBeLessThan(0);
    expect(sortBudgetItems([item('3', 'c', 'Item 10', 0), item('1', 'c', 'item 2', 0), item('2', 'c', 'Zeta', -1)]).map((i) => i.name)).toEqual(['Zeta', 'item 2', 'Item 10']);
  });

  it('keeps Fixed Costs together, shows each name once, and keeps category context', () => {
    const cats = [cat('f', 'Fixed Costs', 'fixed', 0), cat('p', 'Plumbing', 'finishing', 1), cat('w', 'Window', 'finishing', 2), cat('e', 'Electrical', 'finishing', 3)];
    const items = [
      item('i-plumb', 'p', 'Plumbing', 0), item('i-kah', 'f', 'Kahramaa Cost', 2), item('i-con', 'f', 'Contractor Cost', 0),
      item('i-win', 'w', ' Window ', 0), item('i-cons', 'f', 'Consultant Cost', 1), item('i-sw', 'e', 'Switches', 1), item('i-li', 'e', 'Lights', 0),
    ];
    const o = budgetItemOptions(cats, items);
    expect(o.map((x) => [x.group, x.label])).toEqual([
      ['Fixed Costs', 'Contractor Cost'], ['Fixed Costs', 'Consultant Cost'], ['Fixed Costs', 'Kahramaa Cost'],
      ['Finishing categories', 'Plumbing'], ['Finishing categories', 'Window'],
      ['Electrical', 'Lights'], ['Electrical', 'Switches'],
    ]);
    expect(o.every((x) => !x.label.includes('·'))).toBe(true);
    expect(o.find((x) => x.value === 'i-li')!.hint).toBe('Electrical');
    expect(o.find((x) => x.value === 'i-plumb')!.hint).toBeUndefined();
    // category names stay searchable even when not shown as the heading
    expect(o.find((x) => x.value === 'i-plumb')!.keywords).toContain('Plumbing');
    expect(o.map((x) => x.value)).toEqual(['i-con', 'i-cons', 'i-kah', 'i-plumb', 'i-win', 'i-li', 'i-sw']);
  });

  it('offers only active items; an existing archived link stays listed and marked archived', () => {
    const cats = [cat('f', 'Fixed Costs', 'fixed', 0), cat('old', 'Old category', 'finishing', 1, '2026-01-01')];
    const items = [item('a', 'f', 'Contractor Cost', 0), item('b', 'f', 'Consultant Cost', 1, '2026-02-01'), item('c', 'old', 'Tiles', 0)];
    expect(budgetItemOptions(cats, items).map((x) => x.value)).toEqual(['a']);
    const keep = budgetItemOptions(cats, items, 'b');
    expect(keep.map((x) => [x.value, x.archived])).toEqual([['a', false], ['b', true]]);
    expect(budgetItemOptions(cats, items, 'c').find((x) => x.value === 'c')).toMatchObject({ archived: true, label: 'Tiles' });
    expect(budgetItemOptions(cats, items, 'unknown').map((x) => x.value)).toEqual(['a']);
  });

  it('supports newly added categories and items without hardcoded lists', () => {
    const o = budgetItemOptions([cat('f', 'Fixed Costs', 'fixed', 0), cat('n', 'Landscaping', 'other', 1)],
      [item('a', 'f', 'Contractor Cost', 0), item('x', 'n', 'Irrigation', 0), item('y', 'n', 'Lawn', 1)]);
    expect(o.map((x) => [x.group, x.label])).toEqual([['Fixed Costs', 'Contractor Cost'], ['Landscaping', 'Irrigation'], ['Landscaping', 'Lawn']]);
  });
});

describe('selector data from the API', () => {
  let ctx: Ctx;
  let P = '';
  let admin: Agent;
  let pm: Agent;
  beforeAll(async () => {
    ctx = await setup();
    P = `/api/projects/${ctx.projects.p1}`;
    admin = await ctx.agent('admin');
    pm = await ctx.agent('pm');
  });
  afterAll(async () => { await ctx.close(); });

  it('the seeded structure lists Contractor, Consultant and Kahramaa together first, in budget-page order', async () => {
    const b = (await pm.get(`${P}/budget`)).body;
    const o = budgetItemOptions(b.categories, b.items);
    expect(o.slice(0, 3).map((x) => [x.group, x.label])).toEqual([['Fixed Costs', 'Contractor Cost'], ['Fixed Costs', 'Consultant Cost'], ['Fixed Costs', 'Kahramaa Cost']]);
    // same sequence as the budget page: sorted categories, each with its sorted items
    const pageOrder = sortBudgetCategories(b.categories.filter((c: any) => !c.archived_at))
      .flatMap((c: any) => sortBudgetItems(b.items.filter((i: any) => i.category_id === c.id && !i.archived_at)).map((i: any) => i.id));
    expect(o.map((x) => x.value)).toEqual(pageOrder);
    expect(o.some((x) => /(.+) · \1/.test(x.label))).toBe(false);
  });

  it('only this project’s items are offered (other project and unauthorized roles get none)', async () => {
    const b1 = (await admin.get(`${P}/budget`)).body;
    const b2 = (await admin.get(`/api/projects/${ctx.projects.p2}/budget`)).body;
    const ids2 = new Set(b2.items.map((i: any) => i.id));
    expect(budgetItemOptions(b1.categories, b1.items).some((x) => ids2.has(x.value))).toBe(false);
    expect((await (await ctx.agent('contractor')).get(`${P}/budget`)).status).toBe(403);
    expect((await (await ctx.agent('pm2')).get(`${P}/budget`)).status).toBe(404);
  });

  it('linking keeps item ids, never changes amounts or paid status, and an archived link is preserved on edit', async () => {
    const b = (await admin.get(`${P}/budget`)).body;
    const [first, second] = sortBudgetItems(b.items.filter((i: any) => !i.archived_at));
    const m = (await pm.post(`${P}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Builder', description: 'Stage 1', scheduled_amount: 50000, budget_item_id: first.id })).body;
    expect(m.budget_item_id).toBe(first.id);
    const relink = (await pm.patch(`${P}/payments/milestones/${m.id}`, { budget_item_id: second.id })).body;
    expect(relink).toMatchObject({ budget_item_id: second.id, scheduled_amount: 50000, status: 'active' });
    const pay = (await pm.get(`${P}/payments`)).body.milestones.find((x: any) => x.id === m.id);
    expect(pay.balance.paid).toBe(0);
    expect(pay.budget_item_name).toBe(second.name);

    // the API refuses to archive an item an active milestone links to (existing rule) …
    expect((await admin.post(`${P}/budget/items/${second.id}/archive`)).status).toBe(400);
    // … but older links can point at archived items (e.g. archived in a category, or before the rule): simulate on test data
    await ctx.pool.query('UPDATE budget_items SET archived_at = now() WHERE id = $1', [second.id]);
    // the link and its name remain; editing another field keeps it
    expect((await pm.patch(`${P}/payments/milestones/${m.id}`, { notes: 'checked' })).body.budget_item_id).toBe(second.id);
    const after = (await pm.get(`${P}/payments`)).body.milestones.find((x: any) => x.id === m.id);
    expect(after).toMatchObject({ budget_item_id: second.id, budget_item_name: second.name, scheduled_amount: 50000 });
    const b2 = (await admin.get(`${P}/budget`)).body;
    expect(budgetItemOptions(b2.categories, b2.items).some((x) => x.value === second.id)).toBe(false);
    expect(budgetItemOptions(b2.categories, b2.items, second.id).find((x) => x.value === second.id)?.archived).toBe(true);
    // explicit unlink is allowed and changes nothing else
    expect((await pm.patch(`${P}/payments/milestones/${m.id}`, { budget_item_id: null })).body).toMatchObject({ budget_item_id: null, scheduled_amount: 50000 });
  });
});
