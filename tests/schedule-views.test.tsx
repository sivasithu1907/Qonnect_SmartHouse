// Renders the two alternate views (server-side, no browser) and checks what users see:
// labelled date kinds, Not scheduled areas, empty states, dependency links, the today marker,
// optional material milestones, and that no drag / date-changing controls exist.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MaterialSchedule } from '../src/components/schedule/MaterialSchedule';
import { GanttChart } from '../src/components/schedule/GanttChart';
import { mat, phase, task } from './schedule-fixtures';
import { COLLAPSE_THRESHOLD, filterUnscheduled, type UnscheduledGroup } from '../src/components/schedule/UnscheduledPanel';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_CONTAINER } from '../src/lib/layout';

const noop = () => undefined;
const cats = [{ id: 'c1', name: 'Tiles', sort_order: 1, archived_at: null }, { id: 'c2', name: 'Sanitary ware', sort_order: 2, archived_at: null }];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('Material Supply — Schedule view', () => {
  const items = [
    mat({ id: 'a', description: 'Floor tiles', planned_delivery_date: '2026-10-13', supply_responsibility: 'owner' }),
    mat({ id: 'b', description: 'Wall tiles', required_on_site_date: '2026-10-14', supply_responsibility: 'owner' }), // older date only → review
    mat({ id: 'c', category_id: 'c2', category: 'Sanitary ware', description: 'WC pans', planned_delivery_date: '2026-10-12', actual_delivery_date: '2026-10-14', status: 'Delivered', supply_responsibility: 'owner' }),
    mat({ id: 'd', category_id: 'c2', category: 'Sanitary ware', description: 'Basins' }),
    mat({ id: 'e', description: 'Skirting', planned_delivery_date: '2026-10-11', status: 'Ordered', supply_responsibility: 'owner' }),
    mat({ id: 'f', description: 'Gypsum ceiling', planned_completion_date: '2026-10-16', planned_delivery_date: '2026-10-10', supply_responsibility: 'contractor', status: 'Delivered' }),
  ];
  const html = renderToStaticMarkup(<MaterialSchedule items={items} categories={cats} today="2026-10-15" onOpen={noop} />);
  const t = text(html);

  it('shows the week containing today, grouped by category, one row per dated line', () => {
    expect(html).toContain('data-testid="period-label"');
    expect(t).toContain('11 Oct – 17 Oct 2026');
    expect(t.indexOf('Tiles')).toBeLessThan(t.indexOf('Sanitary ware'));
    for (const d of ['Floor tiles', 'Wall tiles', 'WC pans', 'Skirting', 'Gypsum ceiling']) expect(t).toContain(d);
  });

  it('owner delivery and contractor work use their own labels; older dates are shown only as previous dates', () => {
    expect(t).toContain('Planned delivery 13/10/2026');
    expect(html).toContain('Floor tiles — Planned delivery 13/10/2026');
    expect(t).toMatch(/Wall tiles .*Dates need review Required on site \(previous date\) 14\/10\/2026/);
    expect(html).toContain('WC pans — Actual delivery 14/10/2026');
    expect(t).toContain('Delivered 14/10/2026');
    expect(t).toMatch(/Skirting Ordered Owner supply Overdue/); // open, planned date passed, not delivered
    // contractor work: planned completion, not the old delivery date; a delivered status is not completed work
    expect(html).toContain('Gypsum ceiling — Planned completion 16/10/2026');
    expect(html).not.toContain('Gypsum ceiling — Planned delivery');
    expect(t).not.toMatch(/Gypsum ceiling[^]*Completed \d/);
    expect(t).not.toMatch(/Supplier-confirmed|Revised delivery/);
    // legend: simplified kinds, plus the previous-date marker only while a line awaits review
    for (const l of ['Planned delivery', 'Actual delivery', 'Planned completion', 'Actual completion', 'Previous date (needs review)']) expect(t).toContain(l);
    const reconciled = text(renderToStaticMarkup(<MaterialSchedule items={items.filter((m) => m.id !== 'b')} categories={cats} today="2026-10-15" onOpen={noop} />));
    expect(reconciled).not.toContain('Previous date (needs review)');
  });

  it('keeps undated lines in a labelled Not scheduled area', () => {
    expect(t).toContain('Not scheduled — 1 line');
    expect(t).toContain('Basins');
    expect(t).toContain('Basins Ordered Responsibility: needs confirmation'); // status + responsibility on the row
  });

  it('month view and empty states', () => {
    const month = text(renderToStaticMarkup(<MaterialSchedule items={items} categories={cats} today="2026-10-15" onOpen={noop} initialMode="month" />));
    expect(month).toContain('Oct 2026');
    const empty = text(renderToStaticMarkup(<MaterialSchedule items={[mat({ id: 'x' })]} categories={cats} today="2026-10-15" onOpen={noop} />));
    expect(empty).toContain('No material dates entered yet');
    expect(empty).toContain('Not scheduled — 1 line');
    const quiet = text(renderToStaticMarkup(<MaterialSchedule items={items} categories={cats} today="2026-10-15" onOpen={noop} initialAnchor="2026-12-01" />));
    expect(quiet).toContain('Nothing scheduled in this week');
    expect(quiet).toContain('Outside this week: 5 earlier · 0 later.');
  });

  it('is read-only: no drag handles or date inputs', () => {
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('type="date"');
  });
});

describe('Project Timeline — Gantt view', () => {
  const phases = [phase('p1', 1, { name: 'Setup', planned_start: '2026-10-01', planned_end: '2026-10-20' }), phase('p2', 2, { name: 'Finishing' })];
  const tasks = [
    task('t1', 'p1', { name: 'Mobilise', planned_start: '2026-10-01', planned_end: '2026-10-05', status: 'Completed', assigned_user_name: 'Pat' }),
    task('t2', 'p1', { name: 'Survey', planned_start: '2026-10-06', planned_end: '2026-10-09', status: 'In Progress', depends_on: ['t1'] }),
    task('t3', 'p2', { name: 'Tiling', planned_end: '2026-11-02', status: 'Scheduled' }),
    task('t4', 'p2', { name: 'Painting' }),
  ];
  const materials = [
    mat({ id: 'm1', description: 'Floor tiles', planned_delivery_date: '2026-10-25', supply_responsibility: 'owner' }),
    mat({ id: 'm2', description: 'Grout', planned_completion_date: '2026-10-25', supply_responsibility: 'contractor' }),
    mat({ id: 'm3', description: 'Doors' }),
  ];
  const render = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<GanttChart phases={phases} tasks={tasks} materials={materials} today="2026-10-15" onOpenPhase={noop} onOpenTask={noop} onOpenMaterials={noop} {...over} />);

  it('groups tasks under phases with duration, status and assignee', () => {
    const html = render();
    const t = text(html);
    expect(t.indexOf('Setup')).toBeLessThan(t.indexOf('Mobilise'));
    expect(t.indexOf('Mobilise')).toBeLessThan(t.indexOf('Finishing'));
    expect(html).toContain('Planned 01/10/2026 → 05/10/2026 (5 days)');
    expect(t).toContain('5d');
    expect(t).toContain('Completed · Pat');
    expect(html).toContain('Planned finish 02/11/2026 (no planned start)'); // single date stays a marker
    expect(t).toContain('Finish only');
    expect(t).toContain('1/2 completed');
  });

  it('draws dependency links and a today marker', () => {
    const html = render();
    expect(html).toContain('data-testid="today-marker"');
    expect(html).toContain('Today 15/10/2026');
    const links = html.match(/<path d="M[^"]+" fill="none"/g) ?? [];
    expect(links).toHaveLength(1);
    expect(html).toContain('After: Mobilise');
  });

  it('lists tasks without planned dates under Not scheduled', () => {
    const t = text(render());
    expect(t).toContain('Not scheduled — 1 task');
    expect(t).toContain('Painting');
  });

  it('materials and contractor work are optional milestones read from material lines, with the same labels', () => {
    expect(text(render())).not.toContain('Materials & contractor work (');
    const html = render({ initialIncludeMaterials: true });
    const t = text(html);
    expect(t).toContain('Materials & contractor work (2)');
    expect(html).toContain('Floor tiles — Planned delivery 25/10/2026');
    expect(html).toContain('Grout — Planned completion 25/10/2026');
    expect(t).not.toContain('Previous date (needs review)');
    expect(t).toContain('1 material line(s) have no planned or actual date');
  });

  it('month zoom renders and an empty plan shows guidance instead of a chart', () => {
    expect(render({ initialZoom: 'month' })).toContain('data-testid="gantt-scroller"');
    const empty = text(renderToStaticMarkup(<GanttChart phases={[phase('p', 1)]} tasks={[task('x', 'p')]} materials={[]} today="2026-10-15" onOpenPhase={noop} onOpenTask={noop} onOpenMaterials={noop} />));
    expect(empty).toContain('No planned dates entered yet');
    expect(empty).toContain('Nothing is scheduled automatically');
  });

  it('is read-only: no drag handles or date inputs', () => {
    const html = render({ initialIncludeMaterials: true });
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('type="date"');
  });
});

describe('Not scheduled list', () => {
  const many = Array.from({ length: COLLAPSE_THRESHOLD + 3 }, (_, i) => task(`u${i}`, i % 2 ? 'p1' : 'p2', { name: `Unscheduled task ${i}` }));
  const phases = [phase('p1', 1, { name: 'Setup' }), phase('p2', 2, { name: 'Finishing' })];

  it('large lists start collapsed: phase sections with counts, no rows until expanded', () => {
    const html = renderToStaticMarkup(<GanttChart phases={phases} tasks={many} materials={[]} today="2026-10-15" onOpenPhase={noop} onOpenTask={noop} onOpenMaterials={noop} />);
    const t = text(html);
    expect(t).toContain(`Not scheduled — ${many.length} tasks`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="unscheduled-rows"');
    expect(t).toMatch(/1\. Setup 7/);
    expect(t).toMatch(/2\. Finishing 8/);
    expect(html).toContain('placeholder="Search unscheduled tasks"');
    expect(t).toContain('Expand all');
  });

  it('small lists start expanded as readable rows (not chips)', () => {
    const html = renderToStaticMarkup(<GanttChart phases={phases} tasks={many.slice(0, 3)} materials={[]} today="2026-10-15" onOpenPhase={noop} onOpenTask={noop} onOpenMaterials={noop} />);
    expect(html).toContain('aria-expanded="true"');
    expect((html.match(/data-testid="unscheduled-rows"/g) ?? []).length).toBe(2);
  });

  it('search matches item names, details and group names, case-insensitively', () => {
    const groups: UnscheduledGroup[] = [
      { key: 'a', label: 'Tiles', searchLabel: 'Tiles', items: [{ id: '1', name: 'Floor tiles', searchText: 'Ordered Owner supply', onOpen: noop }, { id: '2', name: 'Grout', searchText: 'Not Ordered Contractor supply', onOpen: noop }] },
      { key: 'b', label: 'Doors', searchLabel: 'Doors', items: [{ id: '3', name: 'Main door', searchText: 'Needs confirmation', onOpen: noop }] },
      { key: 'c', label: 'Empty', searchLabel: 'Empty', items: [] },
    ];
    expect(filterUnscheduled(groups, '').map((g) => g.key)).toEqual(['a', 'b']);
    expect(filterUnscheduled(groups, 'GROUT').flatMap((g) => g.items.map((i) => i.id))).toEqual(['2']);
    expect(filterUnscheduled(groups, 'contractor').flatMap((g) => g.items.map((i) => i.id))).toEqual(['2']);
    expect(filterUnscheduled(groups, 'doors').map((g) => g.items.length)).toEqual([1]);
    expect(filterUnscheduled(groups, 'zzz')).toEqual([]);
  });
});

describe('page width', () => {
  it('one shared near-full-width container is used by the header, banner, every page and the footer', () => {
    expect(PAGE_CONTAINER).toContain('w-full');
    expect(PAGE_CONTAINER).toContain('max-w-[2400px]');
    for (const f of ['src/App.tsx', 'src/components/Header.tsx', 'src/components/UpdateBanner.tsx']) {
      expect(fs.readFileSync(path.resolve(f), 'utf8')).toContain('PAGE_CONTAINER');
    }
    // no page keeps the old narrow 7xl page cap
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const narrow = walk(path.resolve('src')).filter((f) => /\.tsx?$/.test(f) && fs.readFileSync(f, 'utf8').includes('max-w-7xl'));
    expect(narrow).toEqual([]);
  });
});
