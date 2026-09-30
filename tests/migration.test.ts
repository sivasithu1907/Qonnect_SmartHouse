// Upgrading a database created by the first release (migration 001 + the original seed)
// to migration 002 must keep every record, never copy variant amounts into approved
// amounts, and remain compatible with the previous app version (code rollback).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { createPool } from '../server/db';
import { runMigrations } from '../server/lib/migrate';
import { TEST_DB } from './helpers';

let pool: pg.Pool;
let pid = '';
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

beforeAll(async () => {
  pool = createPool(TEST_DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const only001 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig001-'));
  fs.copyFileSync(path.resolve('migrations/001_init.sql'), path.join(only001, '001_init.sql'));
  await runMigrations(pool, only001, () => undefined);

  // --- data exactly as the first release seeded / stored it
  pid = (await q(`INSERT INTO projects (code, name, misc_basis) VALUES ('PIN 70153699','Umm Garn','variant_a_finishing') RETURNING id`))[0].id;
  const fixed = (await q(`INSERT INTO budget_categories (project_id, name, kind, include_in_misc_basis, sort_order, notes)
    VALUES ($1,'Fixed Costs','fixed',false,0,'Fixed cost subtotal shown in source: QAR 572,500.00. Editing an amount never creates a payment.') RETURNING id`, [pid]))[0].id;
  await q(`INSERT INTO budget_items (project_id, category_id, name, source_amount, notes) VALUES ($1,$2,'Contractor Cost',509500,'Source amount. Approved amount needs confirmation.')`, [pid, fixed]);
  const floor = (await q(`INSERT INTO budget_categories (project_id, name, sort_order) VALUES ($1,'Floor',1) RETURNING id`, [pid]))[0].id;
  await q(`INSERT INTO budget_items (project_id, category_id, name, source_variant_a, source_variant_b, notes)
    VALUES ($1,$2,'Floor (category estimate)',129030.2,35611,'Variant A – Individual / Variant B – Al Wathab are reference estimates only, not approved commitments.')`, [pid, floor]);
  await q(`INSERT INTO budget_items (project_id, category_id, name, source_variant_a, approved_amount, notes)
    VALUES ($1,$2,'Floor tiles (owner item)',100,55000,'My own note mentioning a variant')`, [pid, floor]);
  await q(`INSERT INTO source_references (project_id, label, variant_a_value, variant_b_value) VALUES ($1,'Grand total shown',1798000.65,1864060)`, [pid]);
  await q(`INSERT INTO material_items (project_id, category, description, sort_order) VALUES
    ($1,'Tiles, Ceramic & Marble','Ceramic tiles',0), ($1,'Tiles, Ceramic & Marble','Marble',1),
    ($1,'Windows & Doors','Windows',2), ($1,' windows & doors ','Doors',3), ($1,'Painting Works','Primer',4)`, [pid]);
  await q(`INSERT INTO material_scope_notes (project_id, category, owner_supply) VALUES ($1,'Tiles, Ceramic & Marble','Owner supplies tiles'), ($1,'Landscape Works','Owner supplies plants')`, [pid]);

  await runMigrations(pool, path.resolve('migrations'), () => undefined);
});
afterAll(async () => { await pool.end(); });

describe('migration 002 on existing data', () => {
  it('keeps every budget record and never copies variant amounts into approved amounts', async () => {
    const items = await q('SELECT name, source_amount, source_variant_a, source_variant_b, approved_amount, notes FROM budget_items ORDER BY name');
    expect(items).toEqual([
      { name: 'Contractor Cost', source_amount: 509500, source_variant_a: null, source_variant_b: null, approved_amount: null, notes: '' },
      { name: 'Floor', source_amount: null, source_variant_a: 129030.2, source_variant_b: 35611, approved_amount: null, notes: '' },
      { name: 'Floor tiles (owner item)', source_amount: null, source_variant_a: 100, source_variant_b: null, approved_amount: 55000, notes: 'My own note mentioning a variant' },
    ]);
    expect(await q('SELECT label FROM source_references')).toEqual([{ label: 'Grand total shown' }]);
    expect((await q('SELECT notes FROM budget_categories WHERE kind = $1', ['fixed']))[0].notes).toBe('Editing an amount never creates a payment.');
  });

  it('restricts the misc basis to approved / finalized amounts', async () => {
    expect((await q('SELECT misc_basis FROM projects'))[0].misc_basis).toBe('approved_finishing');
    await expect(pool.query(`UPDATE projects SET misc_basis = 'variant_b_finishing'`)).rejects.toThrow();
  });

  it('creates material categories from existing lines (case/space-insensitive) in their current order and links everything', async () => {
    const cats = await q('SELECT name, sort_order FROM material_categories WHERE project_id = $1 ORDER BY sort_order', [pid]);
    expect(cats.map((c) => c.name)).toEqual(['Tiles, Ceramic & Marble', 'Windows & Doors', 'Painting Works', 'Landscape Works']);
    expect(await q('SELECT 1 FROM material_items WHERE category_id IS NULL')).toHaveLength(0);
    expect(await q('SELECT 1 FROM material_scope_notes WHERE category_id IS NULL')).toHaveLength(0);
    expect((await q('SELECT count(*)::int n FROM material_items'))[0].n).toBe(5);
    const doors = await q(`SELECT m.category, c.name FROM material_items m JOIN material_categories c ON c.id = m.category_id WHERE m.description = 'Doors'`);
    expect(doors).toEqual([{ category: 'Windows & Doors', name: 'Windows & Doors' }]);
  });

  it('stays compatible with the previous app version (inserts / edits by category name)', async () => {
    await q(`INSERT INTO material_items (project_id, category, description) VALUES ($1,'Painting works','Wall putty')`, [pid]);
    await q(`INSERT INTO material_items (project_id, category, description) VALUES ($1,'Brand New Category','Something')`, [pid]);
    const rows = await q(`SELECT m.description, c.name FROM material_items m JOIN material_categories c ON c.id = m.category_id WHERE m.description IN ('Wall putty','Something') ORDER BY 1`);
    expect(rows).toEqual([{ description: 'Something', name: 'Brand New Category' }, { description: 'Wall putty', name: 'Painting Works' }]);
    await q(`UPDATE material_items SET category = 'Windows & Doors' WHERE description = 'Primer'`);
    const primer = await q(`SELECT c.name FROM material_items m JOIN material_categories c ON c.id = m.category_id WHERE m.description = 'Primer'`);
    expect(primer).toEqual([{ name: 'Windows & Doors' }]);
  });

  it('is recorded once and not re-applied', async () => {
    expect((await q('SELECT filename FROM schema_migrations ORDER BY 1')).map((r) => r.filename)).toEqual(['001_init.sql', '002_finalized_budget_and_categories.sql']);
    expect(await runMigrations(pool, path.resolve('migrations'), () => undefined)).toEqual([]);
  });
});
