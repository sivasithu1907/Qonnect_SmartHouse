// Contract finance summary, shared by the contract list and the contract detail (server computes it,
// the app only displays it). Reads saved values only; never creates, schedules or changes payments.
//
//   Paid against this contract  = valid (non-voided) transfers recorded on payment milestones that
//                                 explicitly reference this contract (payment_milestones.contract_id).
//                                 Each transfer belongs to exactly one milestone, so it is counted once.
//                                 Transfers on archived milestones still count: archiving a milestone
//                                 hides it from scheduling, it does not void money already paid
//                                 (voiding is done per transfer).
//   Remaining contract balance  = contract value − paid against this contract (never below zero;
//                                 any excess is reported as overpaid). Unknown when no value is entered.
//                                 Includes amounts not yet scheduled — it is not necessarily due now.
//   Scheduled unpaid            = positive outstanding balances of eligible linked milestones
//                                 (not archived, not cancelled) — the same balances as the Payments page.
// Remaining contract balance and scheduled unpaid overlap and must never be added together.
import { fromCents, toCents } from './calc';

export interface ContractMilestoneInput {
  archived_at: string | Date | null;
  status: string;
  scheduled_amount: number | string;
  balance: { paid: number; pending: number; isOverdue: boolean };
  transactions?: Array<{ archived_at: string | Date | null }>;
}

export interface ContractFinance {
  /** null when no contract value is entered (distinct from zero) */
  contractValue: number | null;
  paid: number;
  /** part of `paid` recorded on milestones that are now archived */
  paidOnArchived: number;
  archivedMilestonesWithPayments: number;
  /** null when no contract value is entered */
  remaining: number | null;
  /** paid beyond the contract value (0 when within value or value unknown) */
  overpaid: number;
  scheduledUnpaid: number;
  /** total scheduled on eligible milestones (reference) */
  scheduled: number;
  /** part of the remaining balance not covered by any eligible unpaid milestone (null when value unknown) */
  notYetScheduled: number | null;
  /** eligible (non-archived) linked milestones */
  milestoneCount: number;
  /** all linked milestones, archived included */
  linkedMilestoneCount: number;
  transferCount: number;
  overdueCount: number;
}

export function contractFinance(contractValue: number | string | null | undefined, milestones: ContractMilestoneInput[]): ContractFinance {
  const live = milestones.filter((m) => !m.archived_at);
  const archived = milestones.filter((m) => m.archived_at);
  const paidC = milestones.reduce((a, m) => a + toCents(m.balance.paid), 0);
  const paidArchivedC = archived.reduce((a, m) => a + toCents(m.balance.paid), 0);
  const eligible = live.filter((m) => m.status !== 'cancelled');
  const unpaidC = eligible.reduce((a, m) => a + Math.max(0, toCents(m.balance.pending)), 0);
  const scheduledC = eligible.reduce((a, m) => a + toCents(m.scheduled_amount), 0);
  const hasValue = contractValue !== null && contractValue !== undefined && contractValue !== '';
  const valueC = hasValue ? toCents(contractValue as number) : null;
  const remainingC = valueC === null ? null : Math.max(0, valueC - paidC);
  return {
    contractValue: valueC === null ? null : fromCents(valueC),
    paid: fromCents(paidC),
    paidOnArchived: fromCents(paidArchivedC),
    archivedMilestonesWithPayments: archived.filter((m) => toCents(m.balance.paid) > 0).length,
    remaining: remainingC === null ? null : fromCents(remainingC),
    overpaid: valueC === null ? 0 : fromCents(Math.max(0, paidC - valueC)),
    scheduledUnpaid: fromCents(unpaidC),
    scheduled: fromCents(scheduledC),
    notYetScheduled: remainingC === null ? null : fromCents(Math.max(0, remainingC - unpaidC)),
    milestoneCount: live.length,
    linkedMilestoneCount: milestones.length,
    transferCount: milestones.reduce((a, m) => a + (m.transactions ?? []).filter((t) => !t.archived_at).length, 0),
    overdueCount: live.filter((m) => m.balance.isOverdue).length,
  };
}
