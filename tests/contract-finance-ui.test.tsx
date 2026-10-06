// Contract list and detail show Paid / Remaining contract balance / Scheduled unpaid distinctly.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContractFinanceCell, ContractFinanceInline, ContractFinancePanel, REMAINING_NOTE } from '../src/components/contracts/ContractFinance';
import { contractFinance } from '../shared/contractFinance';

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const m = (scheduled: number, paid: number, pending: number, over: Record<string, unknown> = {}) =>
  ({ archived_at: null, status: 'active', scheduled_amount: scheduled, balance: { paid, pending, isOverdue: false }, transactions: paid ? [{ archived_at: null }] : [], ...over });
const example = contractFinance(180000, [m(40000, 40000, 0)]);

describe('contract finance display', () => {
  it('detail: the four amounts for the 180,000 / 40,000 example, with the required note', () => {
    const t = text(renderToStaticMarkup(<ContractFinancePanel f={example} />));
    expect(t).toContain('Contract value QAR 180,000.00');
    expect(t).toContain('Paid against this contract QAR 40,000.00');
    expect(t).toContain('Remaining contract balance QAR 140,000.00');
    expect(t).toContain('Scheduled unpaid QAR 0.00');
    expect(t).toContain(REMAINING_NOTE);
    expect(REMAINING_NOTE).toBe('Remaining contract balance includes amounts not yet scheduled. It is not necessarily due now.');
    expect(t).not.toMatch(/Pending/);
    expect(t).not.toContain('180,000.00 QAR 140'); // no summed figure
  });
  it('list: Paid and Remaining replace “Pending”; scheduled unpaid only as secondary text', () => {
    const cell = text(renderToStaticMarkup(<ContractFinanceCell f={example} />));
    expect(cell).toBe('Paid QAR 40,000.00 Remaining QAR 140,000.00');
    const partial = text(renderToStaticMarkup(<ContractFinanceCell f={contractFinance(180000, [m(50000, 20000, 30000)])} />));
    expect(partial).toBe('Paid QAR 20,000.00 Remaining QAR 160,000.00 Scheduled unpaid QAR 30,000.00');
    expect(text(renderToStaticMarkup(<ContractFinanceInline f={example} />))).toBe('Paid QAR 40,000.00 · Remaining QAR 140,000.00');
    expect(text(renderToStaticMarkup(<ContractFinanceCell f={contractFinance(null, [])} />))).toBe('None linked');
  });
  it('missing value, overpayment and archived payments are explained', () => {
    const noValue = text(renderToStaticMarkup(<ContractFinancePanel f={contractFinance(null, [m(1000, 1000, 0)])} />));
    expect(noValue).toContain('Contract value Not entered');
    expect(noValue).toContain('Remaining contract balance Needs contract value');
    const over = text(renderToStaticMarkup(<ContractFinancePanel f={contractFinance(100, [m(150, 130, 20)])} />));
    expect(over).toContain('Payments exceed the contract value by QAR 30.00');
    expect(text(renderToStaticMarkup(<ContractFinanceCell f={contractFinance(100, [m(150, 130, 20)])} />))).toContain('Overpaid QAR 30.00');
    const archived = text(renderToStaticMarkup(<ContractFinancePanel f={contractFinance(100000, [m(30000, 30000, 0, { archived_at: '2026-01-01' })])} />));
    expect(archived).toContain('Paid includes QAR 30,000.00 recorded on 1 archived milestone');
    expect(archived).toContain('Remaining contract balance QAR 70,000.00');
  });
});
