import React from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Coins, CreditCard, LayoutDashboard, Settings, Table, FolderOpen, Truck } from 'lucide-react';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Project, Section } from '../lib/types';
import { formatDate, formatDateTime, formatQAR } from '../lib/format';
import { Button, Card, EmptyState, Kpi, LinkButton, NeedsConfirmation, Notice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { CountBreakdown, GroupedBars, materialColor, MonthlyBars, ProgressRow } from '../components/charts';

export function Dashboard({ project, onNavigate, onSettings }: { project: Project; onNavigate: (s: Section) => void; onSettings: () => void }) {
  const { can } = useSession();
  const { data: d, error } = useApi<any>(`/api/projects/${project.id}/dashboard`);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!d) return <Spinner />;
  const f = d.finance;
  const m = d.materials;
  const controlConfirmed = f && f.controlBudget !== null && f.controlBudgetConfirmed;

  return (
    <div className="space-y-6">
      <PageHeader icon={<LayoutDashboard className="w-5 h-5" />}
        title={`${project.name} — ${project.code}`}
        subtitle={<>{project.location}{project.status ? ` · ${project.status}` : ''}{project.archived_at && <span className="ml-2 text-rose-600 font-semibold">Archived (read-only)</span>}</>}
        actions={(can('links.edit') || can('projects.manage')) && <Button onClick={onSettings}><Settings className="w-4 h-4" />Settings & links</Button>} />

      <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl p-3">
        <span className="text-xs font-semibold text-slate-700 mr-1">Project links:</span>
        <LinkButton href={project.drive_folder_url} label="Drive folder" icon={<FolderOpen className="w-3.5 h-3.5" />} />
        <LinkButton href={project.sheets_url} label="Google Sheet" tone="emerald" icon={<Table className="w-3.5 h-3.5" />} />
        <span className="text-[11px] text-slate-400">External links — not synchronised with the app.</span>
      </div>

      {f && !controlConfirmed && (
        <Notice title="Control budget needs confirmation.">
          Source Variant A / B estimates and the source dashboard totals are reference values only. They are not approved commitments or payments, and the displayed grand totals may double-count costs. An admin must confirm the control budget in project settings.
        </Notice>
      )}

      {f ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label="Control budget" icon={<Coins className="w-4 h-4 text-slate-400" />}
            value={controlConfirmed ? formatQAR(f.controlBudget) : <NeedsConfirmation />}
            hint={f.controlBudget !== null && !f.controlBudgetConfirmed ? `Entered ${formatQAR(f.controlBudget)} — not confirmed` : 'Set by admin'} onClick={() => onNavigate('budget')} />
          <Kpi label="Approved commitments" tone="emerald" icon={<CheckCircle2 className="w-4 h-4 text-emerald-500" />}
            value={formatQAR(f.approvedCommitments)} hint={`${f.approvedItemCount} of ${f.itemCount} budget items have an approved amount`} onClick={() => onNavigate('budget')} />
          <Kpi label="Amount paid" tone="sky" icon={<CreditCard className="w-4 h-4 text-sky-500" />}
            value={formatQAR(f.paid)} hint="Recorded transfers only" onClick={() => onNavigate('payments')} />
          <Kpi label="Pending (scheduled, unpaid)" tone="amber" icon={<CalendarClock className="w-4 h-4 text-amber-500" />}
            value={formatQAR(f.pending)} hint={f.overdue > 0 ? <span className="text-rose-700 font-semibold">{formatQAR(f.overdue)} overdue ({f.overdueCount})</span> : `Scheduled total ${formatQAR(f.scheduled)}`} onClick={() => onNavigate('payments')} />
        </div>
      ) : (
        <Notice tone="sky">Financial figures are not available for your role.</Notice>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Kpi label="Material lines" value={m.total} icon={<Truck className="w-4 h-4 text-slate-400" />} onClick={() => onNavigate('materials')} />
        <Kpi label="Awaiting confirmation" tone="amber" value={m.awaitingConfirmation} onClick={() => onNavigate('materials')} />
        <Kpi label="Due in 14 days" tone="sky" value={m.dueSoon.length} onClick={() => onNavigate('materials')} />
        <Kpi label="Overdue deliveries" tone={m.overdue.length ? 'rose' : 'slate'} value={m.overdue.length} icon={m.overdue.length ? <AlertTriangle className="w-4 h-4 text-rose-500" /> : undefined} onClick={() => onNavigate('materials')} />
        <Kpi label="Partial / inspection pending" value={`${m.partiallyDelivered} / ${m.inspectionPending}`} onClick={() => onNavigate('materials')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {f && (
          <Card title="Budget vs committed vs paid by category" subtitle="Reference = Variant A source estimate (not a commitment). Committed = approved amounts."><div className="max-h-[30rem] overflow-y-auto pr-1">
            <GroupedBars
              rows={f.byCategory.filter((c: any) => c.source_variant_a || c.source_amount || c.approved || c.paid).map((c: any) => ({
                label: c.name,
                values: { ref: c.kind === 'fixed' ? c.source_amount : c.source_variant_a, approved: c.approved, paid: c.paid },
              }))}
              series={[{ key: 'ref', label: 'Source reference', color: '#cbd5e1' }, { key: 'approved', label: 'Approved / committed', color: '#10b981' }, { key: 'paid', label: 'Paid', color: '#0ea5e9' }]} />
          </div></Card>
        )}
        <Card title="Material status" subtitle="Counts per status across all material lines">
          <CountBreakdown counts={m.byStatus} colorFor={materialColor} />
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-[11px] font-semibold text-slate-600 mb-2">Supply responsibility</p>
            <CountBreakdown counts={m.responsibility} colorFor={(k) => (k.startsWith('Owner') ? '#0ea5e9' : k.startsWith('Contractor') ? '#6366f1' : '#f59e0b')} />
          </div>
        </Card>
        {f && (
          <Card title="Payments over time" subtitle="Actual transfers by month">
            <MonthlyBars data={f.paymentsOverTime} />
          </Card>
        )}
        <Card title="Timeline progress" subtitle={d.timeline.anyScheduleApproved ? `${d.timeline.completed}/${d.timeline.total} tasks completed` : 'Planning template — dates and sequencing not yet approved'}>
          {d.timeline.total === 0 ? <EmptyState /> : (
            <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
              {d.timeline.phases.map((p: any) => (
                <ProgressRow key={p.id} label={`${p.seq}. ${p.name}`} done={p.completed} total={p.total}
                  sub={p.planned_start || p.planned_end ? `${formatDate(p.planned_start)} → ${formatDate(p.planned_end)}${p.schedule_approved ? ' · approved' : ' · not approved'}` : 'Not scheduled'} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {f && (
          <Card title="Upcoming & overdue payments" subtitle="Next 30 days">
            {f.overduePayments.length === 0 && f.upcomingPayments.length === 0 ? <EmptyState /> : (
              <ul className="space-y-2">
                {f.overduePayments.map((p: any) => (
                  <li key={p.id} className="text-xs flex justify-between gap-2"><span><StatusBadge status="Overdue" /> {p.payee_name} — {p.description}<span className="text-slate-400"> · due {formatDate(p.due_date)}</span></span><span className="font-mono font-semibold text-rose-700">{formatQAR(p.pending)}</span></li>
                ))}
                {f.upcomingPayments.map((p: any) => (
                  <li key={p.id} className="text-xs flex justify-between gap-2"><span>{p.payee_name} — {p.description}<span className="text-slate-400"> · due {formatDate(p.due_date)}</span></span><span className="font-mono font-semibold">{formatQAR(p.pending)}</span></li>
                ))}
              </ul>
            )}
          </Card>
        )}
        <Card title="Materials due soon / overdue">
          {m.overdue.length === 0 && m.dueSoon.length === 0 ? <EmptyState title="Nothing due in the next 14 days" /> : (
            <ul className="space-y-2">
              {[...m.overdue.map((x: any) => ({ ...x, late: true })), ...m.dueSoon].map((x: any) => (
                <li key={x.id} className="text-xs flex justify-between gap-2">
                  <span>{x.late && <StatusBadge status="Overdue" />} {x.description}<span className="text-slate-400"> · {x.category}</span></span>
                  <span className="text-slate-600 whitespace-nowrap">{formatDate(x.date)} <span className="text-slate-400">({x.basis})</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Upcoming visits">
          {d.upcomingConsultantVisits.length === 0 && d.upcomingSiteVisits.length === 0 ? <EmptyState /> : (
            <ul className="space-y-2">
              {d.upcomingConsultantVisits.map((v: any) => <li key={v.id} className="text-xs"><b>Consultant</b> · {formatDateTime(v.planned_at)} · {v.purpose}{v.consultant_name ? ` (${v.consultant_name})` : ''}</li>)}
              {d.upcomingSiteVisits.map((v: any) => <li key={v.id} className="text-xs"><b>Site</b> · {formatDateTime(v.visit_at)} · {v.purpose}{v.assigned ? ` (${v.assigned})` : ''}</li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
