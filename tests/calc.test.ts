import { describe, expect, it } from 'vitest';
import { milestoneBalance, miscAllowance, qtyRemaining, sumMoney, effectiveDeliveryDate, isValidExternalUrl } from '../shared/calc';

describe('milestoneBalance', () => {
  const m = (over: Partial<{ scheduled_amount: number; due_date: string | null; status: 'active' | 'on_hold' | 'cancelled' }> = {}) => ({
    scheduled_amount: 1000, due_date: '2026-10-15', status: 'active' as const, ...over,
  });
  it('is unpaid with no transfers', () => {
    const b = milestoneBalance(m(), [], '2026-10-01');
    expect(b).toMatchObject({ paid: 0, pending: 1000, overpaid: 0, isOverdue: false, derivedStatus: 'Unpaid' });
  });
  it('sums multiple transfers exactly (no float drift)', () => {
    const b = milestoneBalance(m({ scheduled_amount: 0.3 }), [{ amount: 0.1 }, { amount: 0.2 }], '2026-10-01');
    expect(b.paid).toBe(0.3);
    expect(b.pending).toBe(0);
    expect(b.derivedStatus).toBe('Paid');
  });
  it('partially paid, then overdue after due date', () => {
    expect(milestoneBalance(m(), [{ amount: 400 }], '2026-10-01').derivedStatus).toBe('Partially paid');
    const late = milestoneBalance(m(), [{ amount: 400 }], '2026-10-16');
    expect(late).toMatchObject({ pending: 600, isOverdue: true, derivedStatus: 'Overdue' });
  });
  it('ignores archived (voided) transfers', () => {
    expect(milestoneBalance(m(), [{ amount: 1000, archived_at: '2026-01-01' }], '2026-10-01').paid).toBe(0);
  });
  it('flags overpayment', () => {
    const b = milestoneBalance(m(), [{ amount: 700 }, { amount: 500 }], '2026-10-01');
    expect(b).toMatchObject({ paid: 1200, pending: 0, overpaid: 200, derivedStatus: 'Overpaid' });
  });
  it('cancelled milestones have no pending balance; on-hold is never overdue', () => {
    expect(milestoneBalance(m({ status: 'cancelled' }), [], '2026-12-01')).toMatchObject({ pending: 0, derivedStatus: 'Cancelled' });
    expect(milestoneBalance(m({ status: 'on_hold' }), [], '2026-12-01')).toMatchObject({ pending: 1000, isOverdue: false, derivedStatus: 'On hold' });
  });
  it('milestone without due date is never overdue', () => {
    expect(milestoneBalance(m({ due_date: null }), [], '2030-01-01').isOverdue).toBe(false);
  });
});

describe('miscAllowance (approved / finalized amounts only)', () => {
  const cats = [
    { id: 'f', kind: 'fixed' as const, include_in_misc_basis: false },
    { id: 'a', kind: 'finishing' as const, include_in_misc_basis: true },
    { id: 'b', kind: 'finishing' as const, include_in_misc_basis: false },
  ];
  const items = [
    { category_id: 'f', approved_amount: 500000 },
    { category_id: 'a', approved_amount: 1000 },
    { category_id: 'a', approved_amount: null },
    { category_id: 'b', approved_amount: 9999 },
  ];
  it('uses only finalized amounts of included finishing categories; never fixed costs', () => {
    const r = miscAllowance(cats, items, 10);
    expect(r).toMatchObject({ basis: 'approved_finishing', basisAmount: 1000, allowance: 100, itemsCounted: 1, itemsMissingValue: 1 });
  });
  it('is zero when nothing is finalized yet', () => {
    expect(miscAllowance(cats, [{ category_id: 'a', approved_amount: null }], 10)).toMatchObject({ basisAmount: 0, allowance: 0, itemsMissingValue: 1 });
  });
  it('ignores archived items and categories', () => {
    const r = miscAllowance([{ ...cats[1], archived_at: '2026-01-01' }], [{ category_id: 'a', approved_amount: 500 }], 10);
    expect(r.basisAmount).toBe(0);
    expect(miscAllowance(cats, [{ category_id: 'a', approved_amount: 500, archived_at: '2026-01-01' }], 10).basisAmount).toBe(0);
  });
});

describe('misc helpers', () => {
  it('qtyRemaining', () => {
    expect(qtyRemaining(null, 5)).toBeNull();
    expect(qtyRemaining(10, null)).toBe(10);
    expect(qtyRemaining(10, 3.5)).toBe(6.5);
  });
  it('sumMoney', () => expect(sumMoney([0.1, 0.2, '0.3', null])).toBe(0.6));
  it('effectiveDeliveryDate precedence', () => {
    expect(effectiveDeliveryDate({ actual_delivery_date: null, revised_delivery_date: '2026-11-02', confirmed_delivery_date: '2026-11-01', planned_delivery_date: null, required_on_site_date: '2026-10-10' }))
      .toEqual({ date: '2026-11-02', basis: 'Revised' });
  });
  it('isValidExternalUrl', () => {
    expect(isValidExternalUrl('')).toBe(true);
    expect(isValidExternalUrl('https://drive.google.com/drive/folders/x')).toBe(true);
    expect(isValidExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isValidExternalUrl('not a url')).toBe(false);
  });
});
