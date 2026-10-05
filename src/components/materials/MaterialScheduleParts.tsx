import React, { useState } from 'react';
import { AlertTriangle, CalendarClock, ChevronRight, History } from 'lucide-react';
import { post } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { MaterialItem } from '../../lib/types';
import { DATE_FIELD_LABELS, isScheduleOverdue, materialSchedule, scheduleWarnings, type DateField, type MaterialScheduleInput } from '../../../shared/materialSchedule';
import { Badge, Button } from '../ui';

/** Collapsed list of older saved dates (never shown when there are none, e.g. on new lines). */
export function PreviousDateDetails({ m, defaultOpen = false }: { m: MaterialScheduleInput; defaultOpen?: boolean }) {
  const s = materialSchedule(m);
  const note = (m.delivery_date_note ?? '').trim();
  if (!s.previous.length && !note) return null;
  return (
    <details className="group rounded-lg border border-slate-200 bg-slate-50/60" open={defaultOpen}>
      <summary className="cursor-pointer select-none list-none flex items-center gap-2 px-3 py-2 min-h-10 text-xs font-semibold text-slate-700 rounded-lg [&::-webkit-details-marker]:hidden">
        <ChevronRight className="w-3.5 h-3.5 text-slate-500 transition-transform group-open:rotate-90" aria-hidden="true" />
        <History className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        Previous date details
        <span className="font-normal text-slate-500">— {s.previous.length + (note ? 1 : 0)} saved</span>
      </summary>
      <div className="px-3 pb-3 space-y-1.5">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {s.previous.map((p) => (
            <div key={p.field} className="flex gap-2"><dt className="text-slate-500">{p.label}:</dt><dd className="font-semibold text-slate-800">{formatDate(p.date)}</dd></div>
          ))}
          {note && <div className="flex gap-2 sm:col-span-2"><dt className="text-slate-500">Delivery date note:</dt><dd className="text-slate-800">{note}</dd></div>}
        </dl>
        <p className="text-[11px] text-slate-500">
          {s.needsReview
            ? 'Kept as saved. Until the schedule is confirmed, reminders and overdue checks keep using the previous deadline.'
            : 'Kept as saved for reference. They are not used for reminders or overdue checks.'}
        </p>
      </div>
    </details>
  );
}

/** Schedule cell for the list (table and mobile cards). */
export function ScheduleCell({ m, today }: { m: MaterialItem; today: string }) {
  const s = materialSchedule(m);
  const late = !m.archived_at && isScheduleOverdue(s, today);
  return (
    <div className="text-[11px] space-y-0.5">
      {s.needsReview ? (
        <>
          <div><Badge tone="amber">{s.workflow === 'unassigned' ? 'Choose responsibility' : 'Dates need review'}</Badge></div>
          {s.deadline && <div className="text-amber-900">Previous date {formatDate(s.deadline.date)}</div>}
          {s.workflow === 'owner' && s.actual && <div className="text-emerald-700 font-semibold">Actual delivery {formatDate(s.actual)}</div>}
        </>
      ) : s.workflow === 'unassigned' ? (
        <span className="text-slate-400">—</span>
      ) : (
        <>
          {s.planned ? <div>{s.plannedLabel} {formatDate(s.planned)}</div> : !s.actual && <span className="text-slate-400">—</span>}
          {s.actual && <div className={`font-semibold ${s.workflow === 'contractor' ? 'text-indigo-700' : 'text-emerald-700'}`}>{s.actualLabel} {formatDate(s.actual)}</div>}
        </>
      )}
      {s.partial && <div><Badge tone="amber">Partially delivered</Badge></div>}
      {late && <div><Badge tone="rose">{s.workflow === 'contractor' && !s.deadline?.legacy ? 'Work overdue' : 'Overdue'}</Badge></div>}
    </div>
  );
}

/** Contradictions between the dates and status, from the values currently in the form. */
export function ScheduleWarningList({ m, today }: { m: MaterialScheduleInput; today: string }) {
  const w = scheduleWarnings(m, today);
  if (!w.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900" role="status">
      <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />Check the status and dates</div>
      <ul className="list-disc pl-5 mt-1 space-y-0.5">{w.map((x) => <li key={x}>{x}</li>)}</ul>
      <p className="mt-1 text-[11px] text-amber-800">Nothing is changed automatically — update the status or date if needed.</p>
    </div>
  );
}

const OWNER_SOURCES: DateField[] = ['planned_delivery_date', 'required_on_site_date', 'confirmed_delivery_date', 'revised_delivery_date'];
const WORK_SOURCES: DateField[] = ['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date'];

/**
 * Explicit date reconciliation for a line whose older dates need review. Shown inside the edit form.
 * `formResponsibility` is the value currently selected in the form (may differ from the saved one).
 */
export function DateReviewPanel({ row, formResponsibility, canConfirm, endpoint, onConfirmed }: {
  row: MaterialItem; formResponsibility: string; canConfirm: boolean; endpoint: string; onConfirmed: (updated: MaterialItem) => void;
}) {
  const saved = materialSchedule(row);
  const preview = materialSchedule({ ...row, supply_responsibility: formResponsibility });
  const owner = row.supply_responsibility === 'owner';
  const sources = (owner ? OWNER_SOURCES : WORK_SOURCES).filter((f) => row[f]);
  const [choice, setChoice] = useState<string>(''); // nothing is preselected: the user chooses explicitly
  const [useActual, setUseActual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // responsibility changed in the form but not saved yet
  if (formResponsibility !== row.supply_responsibility) {
    if (!preview.needsReview || formResponsibility === 'needs_confirmation') return null;
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-sky-900" role="status">
        <b>Save to switch the schedule.</b> {formResponsibility === 'contractor'
          ? 'This line has delivery dates. After saving, confirm the work schedule — delivery dates are not used as completion dates automatically.'
          : 'After saving, confirm which saved date is the planned delivery.'} All saved dates are kept.
      </div>
    );
  }
  if (!saved.needsReview || saved.workflow === 'unassigned') return null;

  const confirm = async () => {
    setBusy(true); setErr(null);
    try {
      const updated = await post<MaterialItem>(endpoint, { workflow: row.supply_responsibility, planned_source: choice, actual_from_delivery: !owner && useActual ? true : undefined });
      onConfirmed(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-950 space-y-2" data-testid="date-review">
      <div className="flex items-start gap-1.5">
        <CalendarClock className="w-4 h-4 shrink-0 mt-px text-amber-700" aria-hidden="true" />
        <div>
          <div className="font-semibold">Dates need review</div>
          <p className="text-amber-900">{saved.reviewReason}</p>
          {saved.deadline && <p className="text-[11px] text-amber-800 mt-0.5">Until confirmed, reminders and overdue checks use {formatDate(saved.deadline.date)} ({saved.deadline.label}).</p>}
        </div>
      </div>
      {canConfirm ? (
        <fieldset className="space-y-1.5">
          <legend className="font-semibold text-slate-800">{owner ? 'Which saved date is the planned delivery?' : 'Planned completion'}</legend>
          {sources.map((f) => (
            <label key={f} className="flex items-center gap-2 min-h-8">
              <input type="radio" name={`src-${row.id}`} value={f} checked={choice === f} onChange={() => setChoice(f)} />
              <span>{DATE_FIELD_LABELS[f]} — <b>{formatDate(row[f])}</b>{owner && f === 'planned_delivery_date' && <span className="text-slate-500"> (current planned delivery)</span>}</span>
            </label>
          ))}
          {(!owner || !row.planned_delivery_date) && (
            <label className="flex items-center gap-2 min-h-8">
              <input type="radio" name={`src-${row.id}`} value="none" checked={choice === 'none'} onChange={() => setChoice('none')} />
              <span>{owner ? 'None — leave the planned delivery blank for now' : 'Don’t use an older date — I’ll enter the planned completion myself'}</span>
            </label>
          )}
          {!owner && row.actual_delivery_date && !row.actual_completion_date && (
            <label className="flex items-center gap-2 min-h-8 pt-1 border-t border-amber-200">
              <input type="checkbox" checked={useActual} onChange={(e) => setUseActual(e.target.checked)} />
              <span>The work was also finished on the actual delivery date ({formatDate(row.actual_delivery_date)}) — use it as the actual completion</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="primary" busy={busy} disabled={!choice} onClick={confirm}>{owner ? 'Confirm planned delivery' : 'Confirm work schedule'}</Button>
            <span className="text-[11px] text-slate-600">Older dates stay saved under Previous date details. The change is recorded in the audit history.</span>
          </div>
          {err && <p className="text-rose-700">{err}</p>}
        </fieldset>
      ) : (
        <p className="text-[11px] text-slate-600">An admin or project manager confirms the schedule.</p>
      )}
    </div>
  );
}
