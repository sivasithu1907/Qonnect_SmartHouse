// Pure date and model helpers for the Material Supply schedule and the Timeline Gantt view.
// Dates are ISO calendar dates (YYYY-MM-DD) handled as UTC day numbers, so the browser's time
// zone never shifts a date. Nothing here invents, fills in or changes a date.
import { expectedDeliveryDate, isMaterialOpen, type ExpectedDateKind } from '../../shared/calc';
import type { MaterialItem, Phase, Task } from './types';

const DAY = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

/** Week starts on Sunday (Qatar working week Sun–Thu). */
export const WEEK_START = 0;

export function dayNum(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY);
}
export function isoOf(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}
export const addDays = (iso: string, n: number) => isoOf(dayNum(iso) + n);
export const weekday = (iso: string) => new Date(dayNum(iso) * DAY).getUTCDay();
export const isValidISO = (v: string | null | undefined): v is string => !!v && Number.isFinite(dayNum(v));

export function startOfWeek(iso: string): string {
  return addDays(iso, -((weekday(iso) - WEEK_START + 7) % 7));
}
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
export function endOfMonth(iso: string): string {
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
  return isoOf(Math.floor(Date.UTC(y, m, 0) / DAY)); // day 0 of next month
}
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  return isoOf(Math.floor(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1) / DAY));
}
/** Inclusive number of calendar days from start to end. */
export const spanDays = (start: string, end: string) => dayNum(end) - dayNum(start) + 1;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
export const dowLabel = (iso: string) => DOW[weekday(iso)];
export const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

// ------------------------------------------------------------------ periods (Material schedule)
export type PeriodMode = 'week' | 'month';
export interface Period { mode: PeriodMode; start: string; end: string; days: string[]; label: string }

export function periodFor(mode: PeriodMode, anchor: string): Period {
  const start = mode === 'week' ? startOfWeek(anchor) : startOfMonth(anchor);
  const end = mode === 'week' ? addDays(start, 6) : endOfMonth(anchor);
  const days: string[] = [];
  for (let d = dayNum(start); d <= dayNum(end); d++) days.push(isoOf(d));
  const label = mode === 'week' ? `${shortDate(start)} – ${shortDate(end)} ${end.slice(0, 4)}` : monthLabel(start);
  return { mode, start, end, days, label };
}
export function shiftPeriod(mode: PeriodMode, anchor: string, dir: -1 | 1): string {
  return mode === 'week' ? addDays(startOfWeek(anchor), 7 * dir) : addMonths(startOfMonth(anchor), dir);
}
export const inRange = (iso: string | null | undefined, start: string, end: string) => !!iso && iso >= start && iso <= end;

// ------------------------------------------------------------------ material schedule model
export interface ScheduleMark {
  date: string;
  /** expected = governing expected delivery; required = need-by date shown alongside; actual = delivered */
  role: 'expected' | 'required' | 'actual';
  kind: ExpectedDateKind | 'actual';
  label: string;
}
export interface MaterialEntry {
  item: MaterialItem;
  expected: { date: string; kind: ExpectedDateKind; label: string } | null;
  actual: string | null;
  marks: ScheduleMark[];
  /** open line whose expected date is in the past and has no actual delivery */
  overdue: boolean;
}

/** One entry per material line. Lines with no usable date go to `unscheduled`; nothing is filled in. */
export function buildMaterialSchedule(items: MaterialItem[], today: string): { scheduled: MaterialEntry[]; unscheduled: MaterialItem[] } {
  const scheduled: MaterialEntry[] = [];
  const unscheduled: MaterialItem[] = [];
  for (const item of items) {
    const exp = expectedDeliveryDate({
      revised_delivery_date: isValidISO(item.revised_delivery_date) ? item.revised_delivery_date : null,
      confirmed_delivery_date: isValidISO(item.confirmed_delivery_date) ? item.confirmed_delivery_date : null,
      planned_delivery_date: isValidISO(item.planned_delivery_date) ? item.planned_delivery_date : null,
      required_on_site_date: isValidISO(item.required_on_site_date) ? item.required_on_site_date : null,
    });
    const actual = isValidISO(item.actual_delivery_date) ? item.actual_delivery_date : null;
    if (!exp && !actual) { unscheduled.push(item); continue; }
    const marks: ScheduleMark[] = [];
    if (exp) marks.push({ date: exp.date, role: 'expected', kind: exp.kind, label: exp.label });
    // the need-by date stays visible next to a delivery date so lateness against it can be seen
    if (exp && exp.kind !== 'required' && isValidISO(item.required_on_site_date)) {
      marks.push({ date: item.required_on_site_date, role: 'required', kind: 'required', label: 'Required on site' });
    }
    if (actual) marks.push({ date: actual, role: 'actual', kind: 'actual', label: 'Actual delivery' });
    const overdue = !!exp && !actual && isMaterialOpen(item.status) && exp.date < today;
    scheduled.push({ item, expected: exp, actual, marks, overdue });
  }
  const key = (e: MaterialEntry) => e.expected?.date ?? e.actual ?? '';
  scheduled.sort((a, b) => key(a).localeCompare(key(b)) || a.item.description.localeCompare(b.item.description));
  return { scheduled, unscheduled };
}

/** Entries with at least one mark inside the period, plus how many dated entries fall before/after it. */
export function entriesInPeriod(entries: MaterialEntry[], start: string, end: string) {
  const visible: MaterialEntry[] = [];
  let before = 0;
  let after = 0;
  let nextDate: string | null = null;
  let prevDate: string | null = null;
  for (const e of entries) {
    const dates = e.marks.map((m) => m.date);
    if (dates.some((d) => inRange(d, start, end))) { visible.push(e); continue; }
    const max = dates.reduce((a, b) => (a > b ? a : b));
    const min = dates.reduce((a, b) => (a < b ? a : b));
    if (max < start) { before++; if (!prevDate || max > prevDate) prevDate = max; } else { after++; if (!nextDate || min < nextDate) nextDate = min; }
  }
  return { visible, before, after, nextDate, prevDate };
}

// ------------------------------------------------------------------ Gantt model
export type TaskSpan =
  | { kind: 'range'; start: string; end: string; days: number }
  | { kind: 'start-only'; start: string }
  | { kind: 'end-only'; end: string }
  | { kind: 'invalid'; start: string; end: string }
  | { kind: 'none' };

/** Uses only the record's own planned start / finish. A single date is shown as a marker, never extended. */
export function plannedSpan(r: { planned_start: string | null; planned_end: string | null }): TaskSpan {
  const s = isValidISO(r.planned_start) ? r.planned_start : null;
  const e = isValidISO(r.planned_end) ? r.planned_end : null;
  if (s && e) return e < s ? { kind: 'invalid', start: s, end: e } : { kind: 'range', start: s, end: e, days: spanDays(s, e) };
  if (s) return { kind: 'start-only', start: s };
  if (e) return { kind: 'end-only', end: e };
  return { kind: 'none' };
}
export const spanDates = (s: TaskSpan): string[] =>
  s.kind === 'range' || s.kind === 'invalid' ? [s.start, s.end] : s.kind === 'start-only' ? [s.start] : s.kind === 'end-only' ? [s.end] : [];

export interface GanttModel {
  phases: Array<{ phase: Phase; span: TaskSpan; tasks: Array<{ task: Task; span: TaskSpan }>; done: number; total: number }>;
  unscheduled: Array<{ phase: Phase; tasks: Task[] }>;
  scheduledCount: number;
}
export function buildGantt(phases: Phase[], tasks: Task[]): GanttModel {
  let scheduledCount = 0;
  const out: GanttModel = { phases: [], unscheduled: [], scheduledCount: 0 };
  for (const phase of phases) {
    const mine = tasks.filter((t) => t.phase_id === phase.id);
    const withSpan = mine.map((task) => ({ task, span: plannedSpan(task) }));
    const dated = withSpan.filter((x) => x.span.kind !== 'none');
    scheduledCount += dated.length;
    out.phases.push({ phase, span: plannedSpan(phase), tasks: dated, done: mine.filter((t) => t.status === 'Completed').length, total: mine.length });
    const none = withSpan.filter((x) => x.span.kind === 'none').map((x) => x.task);
    if (none.length) out.unscheduled.push({ phase, tasks: none });
  }
  out.scheduledCount = scheduledCount;
  return out;
}

/** Visible date range for the Gantt: every shown date and today, padded to whole months. */
export function ganttRange(dates: string[], today: string): { start: string; end: string; days: number } {
  const all = [...dates.filter(isValidISO), today];
  const min = all.reduce((a, b) => (a < b ? a : b));
  const max = all.reduce((a, b) => (a > b ? a : b));
  const start = startOfMonth(addDays(min, -7));
  const end = endOfMonth(addDays(max, 14));
  return { start, end, days: spanDays(start, end) };
}
