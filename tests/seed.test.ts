import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.close(); });

const q = async (sql: string, params: unknown[] = []) => (await ctx.pool.query(sql, params)).rows;

describe('seeded source data', () => {
  it('has exactly the two supplied project codes, both Umm Garn', async () => {
    const rows = await q('SELECT code, name, location, misc_percentage, control_budget, control_budget_confirmed FROM projects ORDER BY code');
    expect(rows.map((r) => r.code)).toEqual(['PIN 70153016', 'PIN 70153699']);
    for (const r of rows) {
      expect(r.location).toBe('Umm Garn');
      expect(r.misc_percentage).toBe(10);
      expect(r.control_budget).toBeNull();
      expect(r.control_budget_confirmed).toBe(false);
    }
  });

  it('PIN 70153699 fixed costs match the source and are not approved', async () => {
    const rows = await q(
      `SELECT i.name, i.source_amount, i.approved_amount FROM budget_items i JOIN budget_categories c ON c.id = i.category_id
        WHERE i.project_id = $1 AND c.kind = 'fixed' ORDER BY i.sort_order`, [ctx.projects.p1]);
    expect(rows).toEqual([
      { name: 'Contractor Cost', source_amount: 509500, approved_amount: null },
      { name: 'Consultant Cost', source_amount: 28000, approved_amount: null },
      { name: 'Kahramaa Cost', source_amount: 35000, approved_amount: null },
    ]);
  });

  it('PIN 70153699 category estimates match Variant A / B, with unpriced B left blank', async () => {
    const rows = await q(
      `SELECT c.name, i.source_variant_a a, i.source_variant_b b, i.source_status FROM budget_items i JOIN budget_categories c ON c.id = i.category_id
        WHERE i.project_id = $1 AND c.kind = 'finishing' ORDER BY c.sort_order`, [ctx.projects.p1]);
    expect(rows).toHaveLength(16);
    const sumA = rows.reduce((s, r) => s + Math.round(r.a * 100), 0) / 100;
    const sumB = rows.reduce((s, r) => s + Math.round((r.b ?? 0) * 100), 0) / 100;
    expect(sumA).toBe(628586.5);
    expect(sumB).toBe(473106.8);
    expect(rows.find((r) => r.name === 'Floor')).toMatchObject({ a: 129030.2, b: 35611 });
    for (const n of ['Landscape', 'Insulation', 'Foam / Cladding']) {
      expect(rows.find((r) => r.name === n)).toMatchObject({ b: null, source_status: 'Variant B: Not priced' });
    }
  });

  it('summary figures are preserved as source references flagged Needs review', async () => {
    const rows = await q('SELECT label, variant_a_value a, variant_b_value b, review_status FROM source_references WHERE project_id = $1 ORDER BY sort_order', [ctx.projects.p1]);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.review_status === 'Needs review')).toBe(true);
    expect(rows.find((r) => r.label === 'Grand total shown')).toMatchObject({ a: 1798000.65, b: 1864060 });
    expect(rows.find((r) => r.label === 'Installation 15%')).toMatchObject({ a: null, b: 172673.2 });
  });

  it('no approvals, payments, visits, uploads, work updates or completions are seeded', async () => {
    expect(await q('SELECT 1 FROM budget_items WHERE approved_amount IS NOT NULL')).toHaveLength(0);
    for (const t of ['payment_milestones', 'payment_transactions', 'consultant_visits', 'site_visits', 'visit_actions', 'attachments', 'work_updates']) {
      expect(await q(`SELECT 1 FROM ${t}`)).toHaveLength(0);
    }
    expect(await q(`SELECT 1 FROM timeline_tasks WHERE status <> 'Not Scheduled' OR planned_start IS NOT NULL OR planned_end IS NOT NULL OR actual_start IS NOT NULL OR actual_end IS NOT NULL OR responsible <> ''`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM timeline_phases WHERE schedule_approved OR planned_start IS NOT NULL OR actual_end IS NOT NULL`)).toHaveLength(0);
  });

  it('material lines: 40 lines, statuses not confirmed, no quantities/vendors/POs invented', async () => {
    const rows = await q('SELECT * FROM material_items WHERE project_id = $1', [ctx.projects.p1]);
    expect(rows).toHaveLength(40);
    for (const r of rows) {
      expect(r.status).toBe('Status not confirmed');
      expect(r.quantity).toBeNull();
      expect(r.unit).toBe('');
      expect(r.vendor).toBe('');
      expect(r.amount).toBeNull();
      expect(r.qty_ordered).toBeNull();
      expect(r.planned_delivery_date).toBeNull();
      expect(r.confirmed_delivery_date).toBeNull();
      expect(r.revised_delivery_date).toBeNull();
      expect(r.actual_delivery_date).toBeNull();
    }
  });

  it('only the four tile/marble lines have a supply due date of 10 October 2026', async () => {
    const rows = await q('SELECT description, required_on_site_date FROM material_items WHERE required_on_site_date IS NOT NULL ORDER BY sort_order');
    expect(rows).toEqual([
      { description: 'Ceramic tiles', required_on_site_date: '2026-10-10' },
      { description: 'Porcelain tiles', required_on_site_date: '2026-10-10' },
      { description: 'Marble', required_on_site_date: '2026-10-10' },
      { description: 'Granite', required_on_site_date: '2026-10-10' },
    ]);
  });

  it('gypsum has no delivery date and shows Contractor confirmation required', async () => {
    const rows = await q(`SELECT * FROM material_items WHERE category = 'Gypsum Board & False Ceiling'`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.required_on_site_date).toBeNull();
      expect(r.delivery_date_note).toBe('Contractor confirmation required');
    }
  });

  it('supply responsibility follows the source; unclassified lines need confirmation', async () => {
    const rows = await q('SELECT category, supply_responsibility r, is_package FROM material_items WHERE project_id = $1', [ctx.projects.p1]);
    const by = (cat: string) => rows.filter((x) => x.category === cat).map((x) => x.r);
    expect(new Set(by('Tiles, Ceramic & Marble'))).toEqual(new Set(['owner']));
    expect(new Set(by('Windows & Doors'))).toEqual(new Set(['needs_confirmation']));
    expect(rows.filter((x) => x.category === 'Insulation Works (Roof & Bathrooms)')).toEqual([
      { category: 'Insulation Works (Roof & Bathrooms)', r: 'contractor', is_package: true },
    ]);
    const notes = await q('SELECT category FROM material_scope_notes WHERE project_id = $1', [ctx.projects.p1]);
    expect(notes).toHaveLength(7);
  });

  it('contains no KNX items anywhere', async () => {
    const tables: Array<[string, string]> = [
      ['budget_items', 'name'], ['budget_categories', 'name'], ['material_items', 'description'], ['material_items', 'category'],
      ['timeline_tasks', 'name'], ['timeline_phases', 'name'], ['material_scope_notes', 'contractor_scope'],
    ];
    for (const [t, c] of tables) expect(await q(`SELECT 1 FROM ${t} WHERE ${c} ILIKE '%knx%'`)).toHaveLength(0);
  });

  it('PIN 70153016 has structure only — no values, materials or records copied', async () => {
    const p2 = ctx.projects.p2;
    expect(await q(`SELECT 1 FROM budget_items WHERE project_id = $1 AND (source_amount IS NOT NULL OR source_variant_a IS NOT NULL OR source_variant_b IS NOT NULL OR approved_amount IS NOT NULL OR quantity IS NOT NULL)`, [p2])).toHaveLength(0);
    expect(await q('SELECT 1 FROM material_items WHERE project_id = $1', [p2])).toHaveLength(0);
    expect(await q('SELECT 1 FROM material_scope_notes WHERE project_id = $1', [p2])).toHaveLength(0);
    expect(await q('SELECT 1 FROM source_references WHERE project_id = $1', [p2])).toHaveLength(0);
    expect((await q('SELECT count(*)::int n FROM timeline_phases WHERE project_id = $1', [p2]))[0].n).toBe(20);
  });

  it('20 timeline phases with dependencies, including MEP inspection before plastering and ceiling closure', async () => {
    const deps = await q(
      `SELECT t.template_key k, d2.template_key dep FROM task_dependencies d
         JOIN timeline_tasks t ON t.id = d.task_id JOIN timeline_tasks d2 ON d2.id = d.depends_on_task_id WHERE d.project_id = $1`, [ctx.projects.p1]);
    const has = (k: string, dep: string) => deps.some((d) => d.k === k && d.dep === dep);
    expect(has('p10-plaster', 'p09-insp')).toBe(true);
    expect(has('p13-frame', 'p09-insp')).toBe(true);
    expect(has('p12-tiles', 'p07-test')).toBe(true);
    expect(has('p13-boards', 'p13-insp')).toBe(true);
    expect(has('p17-comm', 'p17-units')).toBe(true);
  });

  it('seeding again is a no-op', async () => {
    const { seedProjects } = await import('../server/seed/apply');
    await seedProjects(ctx.pool, () => undefined);
    expect((await q('SELECT count(*)::int n FROM projects'))[0].n).toBe(2);
    expect((await q('SELECT count(*)::int n FROM material_items'))[0].n).toBe(40);
  });
});
