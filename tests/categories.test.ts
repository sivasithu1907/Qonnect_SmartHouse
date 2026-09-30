import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx, type Agent } from './helpers';

let ctx: Ctx;
let admin: Agent;
let P: string;
beforeAll(async () => { ctx = await setup(); admin = await ctx.agent('admin'); P = `/api/projects/${ctx.projects.p1}`; });
afterAll(async () => { await ctx.close(); });

const del = (a: Agent, url: string) => a.raw.delete(url).set('X-CSRF-Token', a.csrf);

describe('centralized category management', () => {
  it('lists budget and material categories in managed order with usage counts', async () => {
    const r = await admin.get(`${P}/categories`);
    expect(r.status).toBe(200);
    expect(r.body.budget).toHaveLength(17);
    expect(r.body.material).toHaveLength(15);
    expect(r.body.material[0]).toMatchObject({ name: 'Tiles, Ceramic & Marble', usage_count: 5 }); // 4 lines + scope note
    const orders = r.body.material.map((c: { sort_order: number }) => c.sort_order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('adds categories and rejects duplicate names (case-insensitive)', async () => {
    const c = await admin.post(`${P}/categories/material`, { name: 'Swimming Pool Equipment' });
    expect(c.status).toBe(201);
    expect((await admin.post(`${P}/categories/material`, { name: '  swimming pool equipment ' })).status).toBe(409);
    expect((await admin.post(`${P}/categories/material`, { name: '' })).status).toBe(400);
    const list = (await admin.get(`${P}/categories`)).body.material;
    expect(list[list.length - 1].name).toBe('Swimming Pool Equipment');
  });

  it('renaming a material category keeps every existing line and scope note, following the new name', async () => {
    const cats = (await admin.get(`${P}/categories`)).body.material;
    const tiles = cats.find((c: { name: string }) => c.name === 'Tiles, Ceramic & Marble');
    const before = (await admin.get(`${P}/materials`)).body;
    const ids = before.items.filter((m: { category_id: string }) => m.category_id === tiles.id).map((m: { id: string }) => m.id).sort();
    const r = await admin.patch(`${P}/categories/material/${tiles.id}`, { name: 'Tiles, Ceramic, Marble & Granite' });
    expect(r.status).toBe(200);
    const after = (await admin.get(`${P}/materials`)).body;
    expect(after.items).toHaveLength(before.items.length);
    const moved = after.items.filter((m: { category_id: string }) => m.category_id === tiles.id);
    expect(moved.map((m: { id: string }) => m.id).sort()).toEqual(ids);
    expect(moved.every((m: { category: string; required_on_site_date: string }) => m.category === 'Tiles, Ceramic, Marble & Granite' && m.required_on_site_date === '2026-10-10')).toBe(true);
    expect(after.scopeNotes.find((n: { category_id: string }) => n.category_id === tiles.id).category).toBe('Tiles, Ceramic, Marble & Granite');
    const db = await ctx.pool.query('SELECT DISTINCT category FROM material_items WHERE category_id = $1', [tiles.id]);
    expect(db.rows).toEqual([{ category: 'Tiles, Ceramic, Marble & Granite' }]);
    // duplicate rename blocked
    expect((await admin.patch(`${P}/categories/material/${tiles.id}`, { name: 'painting works' })).status).toBe(409);
  });

  it('reorders categories and the material list follows the new order', async () => {
    const cats = (await admin.get(`${P}/categories`)).body.material;
    const ids = cats.map((c: { id: string }) => c.id).reverse();
    const r = await admin.post(`${P}/categories/material/reorder`, { ids });
    expect(r.status).toBe(200);
    expect(r.body.map((c: { id: string }) => c.id)).toEqual(ids);
    const mats = (await admin.get(`${P}/materials`)).body.items;
    const firstWithLines = r.body.find((c: { active_count: number }) => c.active_count > 0);
    expect(mats[0].category_id).toBe(firstWithLines.id);
    expect((await admin.post(`${P}/categories/material/reorder`, { ids: ids.slice(1) })).status).toBe(400);
    await admin.post(`${P}/categories/material/reorder`, { ids: [...ids].reverse() });
  });

  it('blocks deleting a category that is in use and explains why; deletes unused ones', async () => {
    const cats = (await admin.get(`${P}/categories`)).body;
    const used = cats.material.find((c: { usage_count: number }) => c.usage_count > 0);
    const r = await del(admin, `${P}/categories/material/${used.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cannot be deleted because it is used by \d+ material line/);
    expect(r.body.error).toMatch(/Archive the category instead/);
    const usedBudget = cats.budget.find((c: { usage_count: number }) => c.usage_count > 0);
    expect((await del(admin, `${P}/categories/budget/${usedBudget.id}`)).status).toBe(409);
    const unused = cats.material.find((c: { name: string }) => c.name === 'Swimming Pool Equipment');
    expect((await del(admin, `${P}/categories/material/${unused.id}`)).status).toBe(200);
    const nb = await admin.post(`${P}/categories/budget`, { name: 'Temporary', kind: 'other' });
    expect((await del(admin, `${P}/categories/budget/${nb.body.id}`)).status).toBe(200);
    const audit = (await admin.get(`${P}/audit`)).body;
    expect(audit.filter((x: { action: string }) => x.action === 'delete')).toHaveLength(2);
  });

  it('archived categories stay on existing lines but cannot be chosen for new or moved lines', async () => {
    const cats = (await admin.get(`${P}/categories`)).body.material;
    const paint = cats.find((c: { name: string }) => c.name === 'Painting Works');
    const other = cats.find((c: { name: string }) => c.name === 'Windows & Doors');
    expect((await admin.post(`${P}/categories/material/${paint.id}/archive`)).body.archived_at).toBeTruthy();
    expect((await admin.post(`${P}/materials`, { category_id: paint.id, description: 'Primer drums' })).status).toBe(400);
    const lines = (await admin.get(`${P}/materials`)).body.items.filter((m: { category_id: string }) => m.category_id === paint.id);
    expect(lines).toHaveLength(4);
    const win = (await admin.get(`${P}/materials`)).body.items.find((m: { category_id: string }) => m.category_id === other.id);
    expect((await admin.patch(`${P}/materials/${win.id}`, { category_id: paint.id })).status).toBe(400);
    expect((await admin.post(`${P}/categories/material/${paint.id}/restore`)).body.archived_at).toBeNull();
  });

  it('keeps categories scoped to their project', async () => {
    const p2cats = await admin.post(`/api/projects/${ctx.projects.p2}/categories/material`, { name: 'Project 2 only' });
    expect(p2cats.status).toBe(201);
    expect((await admin.post(`${P}/materials`, { category_id: p2cats.body.id, description: 'x' })).status).toBe(400);
    expect((await admin.patch(`${P}/categories/material/${p2cats.body.id}`, { name: 'hijack' })).status).toBe(404);
    const p1names = (await admin.get(`${P}/categories`)).body.material.map((c: { name: string }) => c.name);
    expect(p1names).not.toContain('Project 2 only');
  });

  it('only admins can manage categories; other roles read only what they may see', async () => {
    const cats = (await admin.get(`${P}/categories`)).body.material;
    for (const k of ['pm', 'viewer', 'contractor', 'consultant']) {
      const a = await ctx.agent(k);
      expect((await a.post(`${P}/categories/material`, { name: `By ${k}` })).status).toBe(403);
      expect((await a.patch(`${P}/categories/material/${cats[0].id}`, { name: 'x' })).status).toBe(403);
      expect((await del(a, `${P}/categories/material/${cats[0].id}`)).status).toBe(403);
    }
    const c = await ctx.agent('contractor');
    const r = await c.get(`${P}/categories`);
    expect(r.body.budget).toEqual([]);
    expect(r.body.material.length).toBeGreaterThan(0);
    const pm2 = await ctx.agent('pm2');
    expect((await pm2.get(`${P}/categories`)).status).toBe(404);
  });
});
