// Project selector: which projects reach the header (server list → projectsForSelector → menu),
// archived projects grouped and marked read-only for admins, and switching between active and
// archived projects under the existing server-side access rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectsForSelector } from '../src/lib/projects';
import { ProjectMenuList } from '../src/components/Header';
import type { Project } from '../src/lib/types';
import { setup, type Ctx } from './helpers';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
// App.tsx loads exactly this list for every user
const LIST_URL = '/api/projects?includeArchived=1';

describe('project selector with archived projects', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await setup();
    const admin = await ctx.agent('admin');
    expect((await admin.post(`/api/projects/${ctx.projects.p2}/archive`)).status).toBe(200);
  });
  afterAll(async () => { await ctx.close(); });

  it('admins get active and archived projects; the menu groups archived ones as read-only', async () => {
    const admin = await ctx.agent('admin');
    const list: Project[] = (await admin.get(LIST_URL)).body;
    expect(list.map((p) => p.id).sort()).toEqual([ctx.projects.p1, ctx.projects.p2].sort());

    const forMenu = projectsForSelector(list, true, ctx.projects.p1);
    expect(forMenu.map((p) => p.id)).toContain(ctx.projects.p2);

    const html = renderToStaticMarkup(<ProjectMenuList projects={forMenu} query="" currentId={ctx.projects.p1} onSelect={() => undefined} />);
    const t = text(html);
    expect(t.indexOf('Active projects')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('Active projects')).toBeLessThan(t.indexOf('PIN 70153699'));
    expect(t.indexOf('Archived (read-only)')).toBeLessThan(t.indexOf('PIN 70153016'));
    expect(html).toContain('aria-label="Umm Garn — PIN 70153016 (archived, read-only)"');
    expect(html).toContain('aria-label="Umm Garn — PIN 70153699 (current project)"');
    expect(t).toContain('Archived · read-only');
  });

  it('non-admins never receive archived projects, even if they were members', async () => {
    for (const role of ['pm2', 'pm', 'viewer', 'contractor']) {
      const a = await ctx.agent(role);
      const list: Project[] = (await a.get(LIST_URL)).body;
      expect(list.every((p) => !p.archived_at)).toBe(true);
      expect(list.map((p) => p.id)).not.toContain(ctx.projects.p2);
      expect(projectsForSelector(list, false).map((p) => p.id)).not.toContain(ctx.projects.p2);
    }
    // and the client-side guard also drops an archived project that is not the current one
    const archived = { id: 'x', name: 'Old', code: 'C', archived_at: '2026-01-01' } as unknown as Project;
    const active = { id: 'y', name: 'New', code: 'D', archived_at: null } as unknown as Project;
    expect(projectsForSelector([active, archived], false).map((p) => p.id)).toEqual(['y']);
    expect(projectsForSelector([active, archived], false, 'x').map((p) => p.id)).toEqual(['y', 'x']);
  });

  it('switching: admin opens the archived project read-only and back to the active one; others get 404', async () => {
    const admin = await ctx.agent('admin');
    const P2 = `/api/projects/${ctx.projects.p2}`;
    const p2 = await admin.get(P2);
    expect(p2.status).toBe(200);
    expect(p2.body.archived_at).toBeTruthy();
    for (const path of ['/dashboard', '/materials', '/timeline', '/payments', '/budget']) expect((await admin.get(P2 + path)).status).toBe(200);
    const before = (await admin.get(P2)).body;
    const write = await admin.patch(P2, { notes: 'should not save' });
    expect(write.status).toBe(409); // archived = read-only until restored
    expect((await admin.post(`${P2}/materials`, { description: 'x' })).status).toBe(409);
    expect((await admin.get(P2)).body.notes).toBe(before.notes);

    const P1 = `/api/projects/${ctx.projects.p1}`;
    expect((await admin.get(P1 + '/dashboard')).status).toBe(200);
    expect((await admin.patch(`${P1}/materials/${(await admin.get(P1 + '/materials')).body.items[0].id}`, { notes: 'switch check' })).status).toBe(200);

    const pm2 = await ctx.agent('pm2');
    expect((await pm2.get(P2)).status).toBe(404);
    expect((await pm2.get(P2 + '/dashboard')).status).toBe(404);
  });

  it('search still finds archived projects by code', () => {
    const projects = [
      { id: 'a', name: 'Umm Garn', code: 'PIN 70153699', location: 'Doha', archived_at: null },
      { id: 'b', name: 'Umm Garn', code: 'PIN 70153016', location: 'Doha', archived_at: '2026-01-01' },
    ] as unknown as Project[];
    const t = text(renderToStaticMarkup(<ProjectMenuList projects={projects} query="70153016" currentId="a" onSelect={() => undefined} />));
    expect(t).toContain('Archived (read-only)');
    expect(t).not.toContain('PIN 70153699');
  });
});
