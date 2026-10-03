// Material Supply list: category sections (counts, indicators, collapse), table vs card layout,
// scope notes behind a disclosure, and the login password visibility toggle.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MaterialCategorySection } from '../src/components/materials/MaterialCategorySection';
import { categorySummary } from '../src/lib/materialFilters';
import { Login } from '../src/components/Login';
import type { ScopeNote } from '../src/lib/types';
import { mat } from './schedule-fixtures';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const today = '2026-10-15';
const category = { id: 'c1', name: 'Tiles, Ceramic & Marble', sort_order: 1, archived_at: null };
const lines = [
  mat({ id: 'a', description: 'Ceramic tiles', planned_delivery_date: '2026-10-01', status: 'Ordered', supply_responsibility: 'owner', qty_ordered: 100, qty_delivered: 40, inspection_status: 'Pending', next_follow_up_date: '2026-10-20' }),
  mat({ id: 'b', description: 'Porcelain tiles', status: 'Status not confirmed' }),
  mat({ id: 'c', description: 'Marble', required_on_site_date: '2026-11-10', status: 'Awaiting Supplier Confirmation', supply_responsibility: 'contractor' }),
  mat({ id: 'd', description: 'Old granite', archived_at: '2026-01-01', status: 'Status not confirmed' }),
];
const note: ScopeNote = { id: 'n', category: 'Tiles', category_id: 'c1', owner_supply: 'Owner supplies ceramic, porcelain, marble and granite.', contractor_scope: 'Contractor supplies adhesive, grout and labour.', source_label: 'Material supply tracker' };
const perms = { full: true, canEditRow: () => true };
const render = (over: Partial<React.ComponentProps<typeof MaterialCategorySection>> = {}) => renderToStaticMarkup(
  <MaterialCategorySection category={category} items={lines} note={note} today={today} open wide perms={perms}
    onToggle={noop} onOpenLine={noop} onArchive={noop} onRestore={noop} onEditScope={noop} {...over} />);

describe('category summary', () => {
  it('counts visible lines; indicators ignore archived lines', () => {
    expect(categorySummary(lines, today)).toEqual({ total: 4, overdue: 1, noDate: 1, awaiting: 2 });
    expect(categorySummary(lines.filter((m) => m.id === 'c'), today)).toEqual({ total: 1, overdue: 0, noDate: 0, awaiting: 1 });
    expect(categorySummary([], today)).toEqual({ total: 0, overdue: 0, noDate: 0, awaiting: 0 });
  });
});

describe('material category section', () => {
  it('header shows the name, visible count and indicators with text labels', () => {
    const t = text(render());
    expect(t).toContain('Tiles, Ceramic & Marble');
    expect(t).toContain('4 items');
    expect(t).toContain('1 overdue');
    expect(t).toContain('1 no dates');
    expect(t).toContain('2 awaiting confirmation');
  });

  it('collapsed: header only, with aria-expanded=false and no lines rendered', () => {
    const html = render({ open: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Ceramic tiles');
    expect(html).not.toContain('<table');
  });

  it('desktop: table with every tracking column; scope notes stay closed until opened', () => {
    const html = render();
    expect(html).toContain('aria-expanded="true"');
    for (const h of ['Item', 'Qty', 'Responsibility', 'Vendor / assigned', 'Status', 'Required on site', 'Delivery', 'Ordered / delivered / remaining', 'Inspection', 'Follow-up']) expect(html).toContain(`>${h}<`);
    expect(html).toContain('id="rec-a"');
    expect(text(html)).toContain('Planned 01/10/2026');
    expect(text(html)).toContain('100 / 40 / 60');
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(text(html)).toContain('Scope notes — Owner supply · Contractor scope');
    expect(html).toContain('aria-label="Edit scope notes for Tiles, Ceramic &amp; Marble"');
  });

  it('phone: one labelled card per line, same fields, no table', () => {
    const html = render({ wide: false });
    expect(html).not.toContain('<table');
    const t = text(html);
    for (const l of ['Responsibility', 'Required on site', 'Delivery', 'Quantity', 'Ordered / delivered / remaining', 'Vendor / assigned', 'Inspection', 'Follow-up']) expect(t).toContain(l);
    expect((html.match(/<li /g) ?? []).length).toBe(4);
    expect(html).toContain('id="rec-b"');
    expect(html).toContain('aria-label="Edit Ceramic tiles"');
    expect(html).toContain('aria-label="Restore Old granite"');
  });

  it('read-only users get View buttons and no archive / scope controls', () => {
    const html = render({ perms: { full: false, canEditRow: () => false }, onEditScope: undefined, wide: false });
    expect(html).toContain('aria-label="View Ceramic tiles"');
    expect(html).not.toContain('Archive Ceramic tiles');
    expect(html).not.toContain('Edit scope notes');
  });

  it('a category without scope notes shows no notes area', () => {
    expect(render({ note: undefined })).not.toContain('<details');
  });
});

describe('login password visibility', () => {
  it('password is hidden by default, with a non-submitting Show password button', () => {
    const html = renderToStaticMarkup(<Login onLoggedIn={noop} />);
    expect(html).toMatch(/<input[^>]*id="password"[^>]*type="password"/);
    expect(html).toMatch(/autoComplete="current-password"|autocomplete="current-password"/);
    expect(html).toMatch(/<button type="button"[^>]*aria-controls="password"[^>]*aria-pressed="false"[^>]*aria-label="Show password"/);
  });
});
