// Simplified material schedule, shared by the server (dashboard, reminders, CSV) and the app
// (forms, list, schedule, timeline). It only reads saved values; it never fills in, moves or
// clears a date and never changes a status.
//
//   Owner supply       → Planned delivery / Actual delivery (planned_delivery_date / actual_delivery_date)
//   Contractor supply  → Planned completion / Actual completion (planned_completion_date / actual_completion_date)
//   Needs confirmation → no simplified schedule until a responsibility is chosen
//
// Older date fields (required on site, supplier-confirmed, revised, delivery note — and, for
// contractor work, the delivery dates) are "previous date details". When they hold values that
// conflict with, or stand in for, the simplified planned date, the line is flagged for review and
// keeps its previous deadline (revised > supplier-confirmed > planned > required on site) until an
// authorised user confirms which date is the planned date. Old delivery dates are never treated
// as work completion dates automatically.
import { expectedDeliveryDate, isMaterialOpen, qtyRemaining } from './calc';

export type Workflow = 'owner' | 'contractor' | 'unassigned';

export interface MaterialScheduleInput {
  supply_responsibility: string;
  status: string;
  required_on_site_date: string | null;
  planned_delivery_date: string | null;
  confirmed_delivery_date: string | null;
  revised_delivery_date: string | null;
  actual_delivery_date: string | null;
  delivery_date_note?: string | null;
  planned_completion_date?: string | null;
  actual_completion_date?: string | null;
  delivery_schedule_confirmed_at?: string | Date | null;
  work_schedule_confirmed_at?: string | Date | null;
  qty_ordered?: number | string | null;
  qty_delivered?: number | string | null;
}

export type DateField = 'required_on_site_date' | 'planned_delivery_date' | 'confirmed_delivery_date' | 'revised_delivery_date' | 'actual_delivery_date';
export const DATE_FIELD_LABELS: Record<DateField | 'planned_completion_date' | 'actual_completion_date', string> = {
  required_on_site_date: 'Required on site / supply due',
  planned_delivery_date: 'Planned delivery',
  confirmed_delivery_date: 'Supplier-confirmed delivery',
  revised_delivery_date: 'Revised delivery',
  actual_delivery_date: 'Actual delivery',
  planned_completion_date: 'Planned completion',
  actual_completion_date: 'Actual completion',
};

export const WORKFLOW_LABELS = {
  owner: { section: 'Delivery schedule', planned: 'Planned delivery', actual: 'Actual delivery', noun: 'delivery', kind: 'Material delivery' },
  contractor: { section: 'Work schedule', planned: 'Planned completion', actual: 'Actual completion', noun: 'work', kind: 'Contractor work' },
  unassigned: { section: 'Schedule', planned: 'Planned date', actual: 'Actual date', noun: 'schedule', kind: 'Material line' },
} as const;

/** Statuses after which nothing more is expected to arrive (owner delivery). */
const DELIVERED = new Set(['Delivered', 'Accepted']);
/** Statuses that mean the material has not arrived yet. */
const PRE_DELIVERY = new Set(['Status not confirmed', 'Not Ordered', 'Quotation Requested', 'Awaiting Approval', 'Ordered', 'Awaiting Supplier Confirmation', 'In Production', 'Dispatched']);

export const workflowOf = (r: string): Workflow => (r === 'owner' ? 'owner' : r === 'contractor' ? 'contractor' : 'unassigned');
const iso = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);

export interface PreviousDate { field: DateField; label: string; date: string }
export interface Deadline { date: string; label: string; legacy: boolean }
export interface MaterialSchedule {
  workflow: Workflow;
  plannedLabel: string;
  actualLabel: string;
  planned: string | null;
  actual: string | null;
  /** older saved dates that are not part of the simplified schedule (shown under "Previous date details") */
  previous: PreviousDate[];
  /** older dates need an authorised user to confirm the planned date (or a responsibility) */
  needsReview: boolean;
  reviewReason: string | null;
  /** the date reminders, overdue and upcoming use: the simplified planned date, or the previous deadline while under review */
  deadline: Deadline | null;
  /** delivery / work still outstanding (cancelled lines are never outstanding) */
  outstanding: boolean;
  /** owner supply: some quantity delivered, more still expected */
  partial: boolean;
}

export function materialSchedule(m: MaterialScheduleInput): MaterialSchedule {
  const workflow = workflowOf(m.supply_responsibility);
  const L = WORKFLOW_LABELS[workflow];
  const v = (f: DateField) => iso(m[f]);
  const prev = (fields: DateField[]) => fields.filter((f) => v(f)).map((f) => ({ field: f, label: DATE_FIELD_LABELS[f], date: v(f)! }));
  const remaining = qtyRemaining(m.qty_ordered ?? null, m.qty_delivered ?? null);
  const delivered = Number(m.qty_delivered ?? 0);
  const partial = workflow === 'owner' && m.status !== 'Cancelled'
    && (m.status === 'Partially Delivered' || (!DELIVERED.has(m.status) && remaining !== null && remaining > 0 && delivered > 0));

  let planned: string | null = null;
  let actual: string | null = null;
  let previous: PreviousDate[];
  let needsReview: boolean;
  let reviewReason: string | null = null;
  if (workflow === 'owner') {
    planned = v('planned_delivery_date');
    actual = v('actual_delivery_date');
    previous = prev(['required_on_site_date', 'confirmed_delivery_date', 'revised_delivery_date']);
    const conflicts = previous.filter((p) => p.date !== planned);
    needsReview = !m.delivery_schedule_confirmed_at && previous.length > 0 && (planned === null || conflicts.length > 0);
    if (needsReview) {
      reviewReason = planned === null
        ? 'Planned delivery is blank, but older date fields hold dates. Choose which date is the planned delivery.'
        : `Older date fields (${conflicts.map((c) => c.label.toLowerCase()).join(', ')}) differ from the planned delivery. Confirm the planned delivery date.`;
    }
  } else if (workflow === 'contractor') {
    planned = iso(m.planned_completion_date);
    actual = iso(m.actual_completion_date);
    previous = prev(['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date']);
    needsReview = !m.work_schedule_confirmed_at && previous.length > 0 && planned === null && actual === null;
    if (needsReview) reviewReason = 'This line has older delivery dates. They are not used as completion dates unless you confirm it. Confirm the work schedule.';
  } else {
    previous = prev(['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date']);
    needsReview = previous.length > 0;
    if (needsReview) reviewReason = 'Select Owner supply or Contractor supply to set the simplified schedule. Existing dates are kept.';
  }

  let deadline: Deadline | null = null;
  let outstanding: boolean;
  if (needsReview || workflow === 'unassigned') {
    // unchanged previous behaviour until reviewed
    const e = expectedDeliveryDate({
      revised_delivery_date: v('revised_delivery_date'), confirmed_delivery_date: v('confirmed_delivery_date'),
      planned_delivery_date: v('planned_delivery_date'), required_on_site_date: v('required_on_site_date'),
    });
    deadline = e ? { date: e.date, label: `${e.label} (previous date)`, legacy: true } : null;
    outstanding = isMaterialOpen(m.status) && !v('actual_delivery_date');
  } else if (workflow === 'owner') {
    deadline = planned ? { date: planned, label: L.planned, legacy: false } : null;
    outstanding = m.status !== 'Cancelled' && (partial || (!actual && !DELIVERED.has(m.status)));
  } else {
    deadline = planned ? { date: planned, label: L.planned, legacy: false } : null;
    // work is complete only when an actual completion date is recorded — a delivered status is not completed work
    outstanding = m.status !== 'Cancelled' && !actual;
  }
  return { workflow, plannedLabel: L.planned, actualLabel: L.actual, planned, actual, previous, needsReview, reviewReason, deadline, outstanding, partial };
}

/** Outstanding with its deadline already passed. Nothing becomes complete because a date passed. */
export function isScheduleOverdue(s: MaterialSchedule, today: string): boolean {
  return s.outstanding && !!s.deadline && s.deadline.date < today;
}

/** Any saved date for the line (simplified or previous). */
export function hasAnySchedule(s: MaterialSchedule): boolean {
  return !!(s.planned || s.actual || s.previous.length);
}

/**
 * Contradictions between dates and status, shown as clear messages. Nothing is changed
 * automatically; the user decides. Lines under review show only the review message.
 */
export function scheduleWarnings(m: MaterialScheduleInput, today: string): string[] {
  const s = materialSchedule(m);
  if (s.needsReview || s.workflow === 'unassigned') return [];
  const out: string[] = [];
  if (s.actual && s.actual > today) out.push(`${s.actualLabel} date is in the future.`);
  if (s.workflow === 'owner') {
    const remaining = qtyRemaining(m.qty_ordered ?? null, m.qty_delivered ?? null);
    if (DELIVERED.has(m.status) && !s.actual) out.push(`Status is “${m.status}” but the actual delivery date is blank.`);
    if (s.actual && PRE_DELIVERY.has(m.status)) out.push(`An actual delivery date is entered but the status is still “${m.status}”.`);
    if (s.actual && remaining !== null && remaining > 0 && m.status !== 'Partially Delivered' && !DELIVERED.has(m.status)) {
      out.push('Quantity delivered is less than ordered. Set the status to Partially Delivered if more is expected.');
    }
    if (m.status === 'Partially Delivered' && remaining !== null && remaining <= 0) out.push('Status is Partially Delivered but the full ordered quantity is recorded as delivered.');
  } else if (m.status === 'Cancelled' && s.actual) {
    out.push('Status is Cancelled but an actual completion date is entered.');
  }
  return out;
}
