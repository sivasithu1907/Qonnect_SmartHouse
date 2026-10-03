import type pg from 'pg';
import { FIXED_COST_ITEMS, FINISHING_CATEGORIES, TIMELINE_TEMPLATE } from './templates';
import { MATERIALS, PROJECTS, SOURCE_MATERIAL_TRACKER } from './sourceData';
import { audit } from '../audit';
import { DEFAULT_CONTRACT_CATEGORIES } from '../../shared/constants';
import { withTx } from '../db';

type C = pg.PoolClient;

/**
 * Budget structure only: categories and one line per category. Every approved / finalized
 * amount is left blank (Needs confirmation) until an authorised admin enters it.
 */
export async function applyBudgetStructure(c: C, projectId: string) {
  const fixed = await c.query(
    `INSERT INTO budget_categories (project_id, name, kind, include_in_misc_basis, sort_order, notes)
     VALUES ($1, 'Fixed Costs', 'fixed', false, 0, 'Approved / finalized amounts need confirmation.') RETURNING id`,
    [projectId],
  );
  let i = 0;
  for (const name of FIXED_COST_ITEMS) {
    await c.query(
      `INSERT INTO budget_items (project_id, category_id, name, sort_order) VALUES ($1,$2,$3,$4)`,
      [projectId, fixed.rows[0].id, name, i++],
    );
  }
  let s = 1;
  for (const name of FINISHING_CATEGORIES) {
    const cat = await c.query(
      `INSERT INTO budget_categories (project_id, name, kind, sort_order) VALUES ($1,$2,'finishing',$3) RETURNING id`,
      [projectId, name, s++],
    );
    await c.query(`INSERT INTO budget_items (project_id, category_id, name, sort_order) VALUES ($1,$2,$3,0)`, [projectId, cat.rows[0].id, name]);
  }
}

/** 20-phase planning template: names and dependencies only, no dates/people/status. */
export async function applyTimelineTemplate(c: C, projectId: string) {
  const idByKey = new Map<string, string>();
  const deps: Array<[string, string]> = [];
  let seq = 1;
  for (const ph of TIMELINE_TEMPLATE) {
    const p = await c.query(
      `INSERT INTO timeline_phases (project_id, seq, name, description) VALUES ($1,$2,$3,$4) RETURNING id`,
      [projectId, seq++, ph.name, ph.description],
    );
    let order = 0;
    for (const t of ph.tasks) {
      const r = await c.query(
        `INSERT INTO timeline_tasks (project_id, phase_id, template_key, name, is_hold_point, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [projectId, p.rows[0].id, t.key, t.name, !!t.holdPoint, order++],
      );
      idByKey.set(t.key, r.rows[0].id);
      for (const d of t.dependsOn ?? []) deps.push([t.key, d]);
    }
  }
  for (const [task, dep] of deps) {
    const a = idByKey.get(task);
    const b = idByKey.get(dep);
    if (!a || !b) throw new Error(`Timeline template dependency not found: ${task} -> ${dep}`);
    await c.query('INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES ($1,$2,$3)', [projectId, a, b]);
  }
}

/**
 * PIN 70153699: budget category structure (no amounts — comparisons live in the linked Google
 * Sheet) and the owner-supplied material supply lines, grouped by managed material categories.
 */
export async function applySourceData(c: C, projectId: string) {
  await applyBudgetStructure(c, projectId);
  let m = 0;
  let order = 1;
  for (const g of MATERIALS) {
    const cat = await c.query(
      `INSERT INTO material_categories (project_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [projectId, g.category, order++],
    );
    const categoryId = cat.rows[0].id;
    if (g.ownerSupply || g.contractorScope) {
      await c.query(
        `INSERT INTO material_scope_notes (project_id, category, category_id, owner_supply, contractor_scope, source_label) VALUES ($1,$2,$3,$4,$5,$6)`,
        [projectId, g.category, categoryId, g.ownerSupply ?? '', g.contractorScope ?? '', SOURCE_MATERIAL_TRACKER],
      );
    }
    for (const item of g.items) {
      await c.query(
        `INSERT INTO material_items (project_id, category, category_id, description, supply_responsibility, responsibility_note, status,
                                     required_on_site_date, delivery_date_note, is_package, source_label, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,'Status not confirmed',$7,$8,$9,$10,$11)`,
        [
          projectId, g.category, categoryId, item, g.responsibility, g.responsibilityNote ?? '',
          g.requiredOnSite ?? null, g.deliveryDateNote ?? '', !!g.isPackage, SOURCE_MATERIAL_TRACKER, m++,
        ],
      );
    }
  }
}

/** Default contract categories for a new project (names only — no contracts are created). */
export async function applyContractCategories(c: C, projectId: string) {
  const { rowCount } = await c.query('SELECT 1 FROM contract_categories WHERE project_id = $1 LIMIT 1', [projectId]);
  if (rowCount) return;
  for (const [i, name] of DEFAULT_CONTRACT_CATEGORIES.entries()) {
    await c.query('INSERT INTO contract_categories (project_id, name, sort_order) VALUES ($1,$2,$3)', [projectId, name, i + 1]);
  }
}

/** Idempotent seed: creates the two supplied projects if their codes don't exist yet. */
export async function seedProjects(pool: pg.Pool, log: (m: string) => void = console.log) {
  for (const p of PROJECTS) {
    await withTx(pool, async (c) => {
      const exists = await c.query(`SELECT id FROM projects WHERE upper(regexp_replace(code, '\\s+', ' ', 'g')) = upper($1)`, [p.code]);
      if (exists.rowCount) {
        log(`Project ${p.code} already exists — skipped`);
        return;
      }
      const { rows } = await c.query(
        `INSERT INTO projects (code, name, location, status, description, misc_percentage) VALUES ($1,$2,$3,$4,$5,10) RETURNING id`,
        [p.code, p.name, p.location, p.status, p.description],
      );
      const id = rows[0].id;
      if (p.seedSource) await applySourceData(c, id);
      else await applyBudgetStructure(c, id);
      await applyTimelineTemplate(c, id);
      await applyContractCategories(c, id);
      await audit(c, null, {
        projectId: id, action: 'seed', entityType: 'project', entityId: id,
        summary: p.seedSource ? 'Seeded budget categories (no amounts) and source material supply lines' : 'Created clean workspace with standard structure',
      });
      log(`Created project ${p.name} — ${p.code}`);
    });
  }
}
