// Pure calculation helpers shared by the API and the UI. Money is summed in
// integer cents to avoid floating-point drift.

import type { MiscBasis } from './constants';

export const toCents = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};
export const fromCents = (c: number): number => c / 100;

export const sumMoney = (values: Array<number | string | null | undefined>): number =>
  fromCents(values.reduce<number>((acc, v) => acc + toCents(v), 0));

/** Today's date (YYYY-MM-DD) in Qatar time, used for overdue checks. */
export function todayISO(timeZone = 'Asia/Qatar', now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type MilestoneDerivedStatus = 'Unpaid' | 'Partially paid' | 'Paid' | 'Overpaid' | 'Overdue' | 'On hold' | 'Cancelled';

export interface MilestoneInput {
  scheduled_amount: number | string;
  due_date: string | null;
  status: 'active' | 'on_hold' | 'cancelled';
}
export interface TransactionInput {
  amount: number | string;
  archived_at?: string | null;
}

export interface MilestoneBalance {
  scheduled: number;
  paid: number;
  pending: number;       // outstanding against the schedule (0 when cancelled)
  overpaid: number;      // amount paid above the scheduled amount
  isOverdue: boolean;    // due date passed with an unpaid balance
  derivedStatus: MilestoneDerivedStatus;
}

/** Balance for one scheduled milestone. Only recorded, non-archived transfers count as paid. */
export function milestoneBalance(m: MilestoneInput, txs: TransactionInput[], today: string = todayISO()): MilestoneBalance {
  const scheduledC = toCents(m.scheduled_amount);
  const paidC = txs.filter((t) => !t.archived_at).reduce((a, t) => a + toCents(t.amount), 0);
  const overC = Math.max(0, paidC - scheduledC);
  const pendingC = m.status === 'cancelled' ? 0 : Math.max(0, scheduledC - paidC);
  const isOverdue = m.status === 'active' && pendingC > 0 && !!m.due_date && m.due_date < today;

  let derivedStatus: MilestoneDerivedStatus;
  if (overC > 0) derivedStatus = 'Overpaid';
  else if (m.status === 'cancelled') derivedStatus = 'Cancelled';
  else if (pendingC === 0 && paidC > 0) derivedStatus = 'Paid';
  else if (m.status === 'on_hold') derivedStatus = 'On hold';
  else if (isOverdue) derivedStatus = 'Overdue';
  else if (paidC > 0) derivedStatus = 'Partially paid';
  else derivedStatus = 'Unpaid';

  return {
    scheduled: fromCents(scheduledC),
    paid: fromCents(paidC),
    pending: fromCents(pendingC),
    overpaid: fromCents(overC),
    isOverdue,
    derivedStatus,
  };
}

export interface BudgetCategoryInput {
  id: string;
  kind: 'finishing' | 'fixed' | 'other';
  include_in_misc_basis: boolean;
  archived_at?: string | null;
}
export interface BudgetItemInput {
  category_id: string;
  approved_amount: number | string | null;
  archived_at?: string | null;
}

export interface MiscAllowance {
  basis: MiscBasis;
  percentage: number;
  basisAmount: number;
  allowance: number;
  itemsCounted: number;
  itemsMissingValue: number; // items in the basis that have no approved / finalized amount yet
}

/**
 * Miscellaneous allowance = percentage × subtotal of APPROVED / FINALIZED amounts of
 * finishing categories flagged include_in_misc_basis. Fixed costs are never part of the basis,
 * and items without an approved amount contribute nothing.
 */
export function miscAllowance(
  categories: BudgetCategoryInput[],
  items: BudgetItemInput[],
  percentage: number | string,
): MiscAllowance {
  const eligible = new Set(
    categories.filter((c) => !c.archived_at && c.kind === 'finishing' && c.include_in_misc_basis).map((c) => c.id),
  );
  let basisC = 0;
  let counted = 0;
  let missing = 0;
  for (const it of items) {
    if (it.archived_at || !eligible.has(it.category_id)) continue;
    const v = it.approved_amount;
    if (v === null || v === undefined || v === '') {
      missing++;
      continue;
    }
    basisC += toCents(v);
    counted++;
  }
  const pct = Number(percentage) || 0;
  return {
    basis: 'approved_finishing',
    percentage: pct,
    basisAmount: fromCents(basisC),
    allowance: fromCents(Math.round((basisC * pct) / 100)),
    itemsCounted: counted,
    itemsMissingValue: missing,
  };
}

/** Remaining quantity for a material line; null when not computable. */
export function qtyRemaining(ordered: number | string | null, delivered: number | string | null): number | null {
  if (ordered === null || ordered === undefined || ordered === '') return null;
  const o = Number(ordered);
  const d = delivered === null || delivered === undefined || delivered === '' ? 0 : Number(delivered);
  if (!Number.isFinite(o) || !Number.isFinite(d)) return null;
  return Math.round((o - d) * 1000) / 1000;
}

/** Kinds of expected delivery date, in precedence order. */
export type ExpectedDateKind = 'revised' | 'confirmed' | 'planned' | 'required';
export const EXPECTED_DATE_LABELS: Record<ExpectedDateKind, string> = {
  revised: 'Revised delivery',
  confirmed: 'Supplier-confirmed delivery',
  planned: 'Planned delivery',
  required: 'Required on site',
};

/**
 * Expected delivery for a material line, WITHOUT the actual delivery (shown separately):
 * revised > supplier-confirmed > planned > required-on-site. `kind` tells the UI which field the
 * date came from, so a required-on-site date is never presented as a delivery confirmation.
 */
export function expectedDeliveryDate(m: {
  revised_delivery_date: string | null;
  confirmed_delivery_date: string | null;
  planned_delivery_date: string | null;
  required_on_site_date: string | null;
}): { date: string; kind: ExpectedDateKind; label: string } | null {
  const pick = (date: string | null, kind: ExpectedDateKind) => (date ? { date, kind, label: EXPECTED_DATE_LABELS[kind] } : null);
  return pick(m.revised_delivery_date, 'revised')
    ?? pick(m.confirmed_delivery_date, 'confirmed')
    ?? pick(m.planned_delivery_date, 'planned')
    ?? pick(m.required_on_site_date, 'required');
}

/** The delivery date that currently governs a material line (actual > revised > confirmed > planned > required). */
export function effectiveDeliveryDate(m: {
  actual_delivery_date: string | null;
  revised_delivery_date: string | null;
  confirmed_delivery_date: string | null;
  planned_delivery_date: string | null;
  required_on_site_date: string | null;
}): { date: string | null; basis: string } {
  if (m.actual_delivery_date) return { date: m.actual_delivery_date, basis: 'Actual' };
  if (m.revised_delivery_date) return { date: m.revised_delivery_date, basis: 'Revised' };
  if (m.confirmed_delivery_date) return { date: m.confirmed_delivery_date, basis: 'Confirmed' };
  if (m.planned_delivery_date) return { date: m.planned_delivery_date, basis: 'Planned' };
  if (m.required_on_site_date) return { date: m.required_on_site_date, basis: 'Required on site' };
  return { date: null, basis: '' };
}

const CLOSED_MATERIAL = new Set(['Delivered', 'Accepted', 'Cancelled']);
export const isMaterialOpen = (status: string) => !CLOSED_MATERIAL.has(status);

export const AWAITING_CONFIRMATION_STATUSES = new Set([
  'Status not confirmed',
  'Awaiting Approval',
  'Awaiting Supplier Confirmation',
  'Quotation Requested',
]);

/** Validates an external http(s) URL; empty string is allowed (unset). */
export function isValidExternalUrl(v: string): boolean {
  if (v === '') return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Itemized budget totals, shared by the budget page and the dashboard so the same records give the same numbers.
 *   finalized items subtotal = active items with an approved / finalized amount (fixed + finishing + other)
 *   grand total              = subtotal + miscellaneous allowance (the allowance is added exactly once; it is
 *                              calculated on its own basis and is never a budget item)
 *   difference               = grand total − confirmed control budget (only when the budget is confirmed)
 * The control budget is an independent approved limit and is never derived from these totals.
 * Contract values and payments are not part of the itemized total. All arithmetic is in cents.
 */
export function itemizedBudget(input: {
  finalizedSubtotal: number; missingCount: number; miscAllowance: number;
  controlBudget: number | string | null; controlBudgetConfirmed: boolean;
}) {
  const subtotalC = toCents(input.finalizedSubtotal);
  const miscC = toCents(input.miscAllowance);
  const grandC = subtotalC + miscC;
  const confirmed = input.controlBudget !== null && input.controlBudget !== undefined && input.controlBudgetConfirmed;
  const controlC = confirmed ? toCents(input.controlBudget as number) : null;
  const diffC = controlC === null ? null : grandC - controlC;
  return {
    finalizedSubtotal: fromCents(subtotalC),
    miscAllowance: fromCents(miscC),
    grandTotal: fromCents(grandC),
    complete: input.missingCount === 0,
    missingCount: input.missingCount,
    controlBudget: controlC === null ? null : fromCents(controlC),
    controlBudgetConfirmed: confirmed,
    /** grand total − control budget; null until the control budget is confirmed */
    difference: diffC === null ? null : fromCents(diffC),
    aboveControl: diffC !== null && diffC > 0 ? fromCents(diffC) : 0,
    /** only meaningful when complete; otherwise missing amounts could fill it */
    notAllocated: diffC !== null && diffC < 0 ? fromCents(-diffC) : 0,
  };
}
export type ItemizedBudget = ReturnType<typeof itemizedBudget>;
