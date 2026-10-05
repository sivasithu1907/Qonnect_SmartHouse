// Material Supply quick filters: only saved values are read; nothing is filled in.
import { describe, expect, it } from 'vitest';
import { matchesQuickFilter, quickFilterCounts, quickFilterFromFocus } from '../src/lib/materialFilters';
import { mat } from './schedule-fixtures';

const today = '2026-10-15';
describe('material quick filters', () => {
  const items = [
    mat({ id: 'a', supply_responsibility: 'needs_confirmation', status: 'Status not confirmed' }),
    mat({ id: 'b', supply_responsibility: 'owner', required_on_site_date: '2026-11-01', status: 'Awaiting Supplier Confirmation' }),
    mat({ id: 'c', supply_responsibility: 'contractor', planned_delivery_date: '2026-10-01', status: 'Ordered' }),
    mat({ id: 'd', supply_responsibility: 'owner', revised_delivery_date: '2026-10-01', actual_delivery_date: '2026-10-02', status: 'Delivered' }),
    mat({ id: 'e', supply_responsibility: 'needs_confirmation', archived_at: '2026-01-01' }),
  ];
  const ids = (f: Parameters<typeof matchesQuickFilter>[1]) => items.filter((m) => !m.archived_at && matchesQuickFilter(m, f, today)).map((m) => m.id);

  it('finds lines by saved values', () => {
    expect(ids('responsibility')).toEqual(['a']);
    expect(ids('no-date')).toEqual(['a']);
    expect(ids('awaiting')).toEqual(['a', 'b']);
    expect(ids('overdue')).toEqual(['c']); // d was delivered, b is in the future
    // b (owner: required-on-site only), c (contractor: old delivery date), d (owner: revised, no planned) await review
    expect(ids('review')).toEqual(['b', 'c', 'd']);
    expect(ids('all')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts exclude archived lines and never modify records', () => {
    expect(quickFilterCounts(items, today)).toEqual({ all: 4, overdue: 1, review: 3, 'no-date': 1, awaiting: 2, responsibility: 1 });
    expect(items[0].planned_delivery_date).toBeNull();
  });

  it('dashboard deep links map to known filters only', () => {
    expect(quickFilterFromFocus('filter:no-date')).toBe('no-date');
    expect(quickFilterFromFocus('filter:awaiting')).toBe('awaiting');
    expect(quickFilterFromFocus('filter:unknown')).toBeNull();
    expect(quickFilterFromFocus('6e0a7d9b-ba6d-4e66-80e5-ec97a61cd865')).toBeNull();
    expect(quickFilterFromFocus(null)).toBeNull();
  });
});
