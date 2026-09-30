import { Router, type Response } from 'express';
import type pg from 'pg';
import { assertCap } from '../auth';
import { can } from '../permissions';
import { loadBudget, budgetSummary } from './budget';
import { loadPayments } from './payments';
import { loadMaterials } from './materials';
import { loadTimeline } from './timeline';
import { addDaysISO, AWAITING_CONFIRMATION_STATUSES, effectiveDeliveryDate, isMaterialOpen, sumMoney, todayISO } from '../../shared/calc';
import { SUPPLY_RESPONSIBILITY_LABELS } from '../../shared/constants';

function materialStats(items: any[], today: string) {
  const soon = addDaysISO(today, 14);
  const live = items.filter((m) => !m.archived_at);
  const withEff: any[] = live.map((m) => ({ ...m, eff: effectiveDeliveryDate(m) }));
  const byStatus: Record<string, number> = {};
  for (const m of live) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  const open = withEff.filter((m) => isMaterialOpen(m.status) && !m.actual_delivery_date);
  const pick = (m: any) => ({ id: m.id, category: m.category, description: m.description, status: m.status, date: m.eff.date, basis: m.eff.basis });
  return {
    total: live.length,
    byStatus,
    awaitingConfirmation: live.filter((m) => AWAITING_CONFIRMATION_STATUSES.has(m.status)).length,
    dueSoon: open.filter((m) => m.eff.date && m.eff.date >= today && m.eff.date <= soon).map(pick),
    overdue: open.filter((m) => m.eff.date && m.eff.date < today).map(pick),
    partiallyDelivered: live.filter((m) => m.status === 'Partially Delivered').length,
    inspectionPending: live.filter((m) => m.status === 'Inspection Pending' || m.inspection_status === 'Pending').length,
  };
}

function timelineStats(t: Awaited<ReturnType<typeof loadTimeline>>) {
  const phases = t.phases.map((p) => {
    const tasks = t.tasks.filter((x) => x.phase_id === p.id);
    const completed = tasks.filter((x) => x.status === 'Completed').length;
    return {
      id: p.id, seq: p.seq, name: p.name, schedule_approved: p.schedule_approved,
      planned_start: p.planned_start, planned_end: p.planned_end,
      total: tasks.length, completed,
      inProgress: tasks.filter((x) => x.status === 'In Progress').length,
      blocked: tasks.filter((x) => x.status === 'Blocked' || x.status === 'On Hold').length,
      scheduled: tasks.filter((x) => x.planned_start || x.planned_end).length,
    };
  });
  const total = t.tasks.length;
  const completed = t.tasks.filter((x) => x.status === 'Completed').length;
  return { phases, total, completed, percent: total ? Math.round((completed / total) * 100) : 0, anyScheduleApproved: t.phases.some((p) => p.schedule_approved) };
}

export async function projectDashboard(pool: pg.Pool, project: Record<string, any>, role: Parameters<typeof can>[0], timeZone: string) {
  const pid = project.id as string;
  const today = todayISO(timeZone);
  const showFinance = can(role, 'budget.read') && can(role, 'payments.read');
  const [materials, timeline, cv, sv] = await Promise.all([
    loadMaterials(pool, pid),
    loadTimeline(pool, pid),
    pool.query(
      `SELECT id, planned_at, consultant_name, purpose, status FROM consultant_visits
        WHERE project_id = $1 AND archived_at IS NULL AND status IN ('Planned','Rescheduled') AND planned_at >= now() - interval '1 day'
        ORDER BY planned_at LIMIT 10`, [pid]),
    pool.query(
      `SELECT v.id, v.visit_at, COALESCE(u.name, v.assigned_name) AS assigned, v.purpose, v.status FROM site_visits v
         LEFT JOIN users u ON u.id = v.assigned_user_id
        WHERE v.project_id = $1 AND v.archived_at IS NULL AND v.status IN ('Planned','Rescheduled') AND v.visit_at >= now() - interval '1 day'
        ORDER BY v.visit_at LIMIT 10`, [pid]),
  ]);

  let finance: Record<string, unknown> | null = null;
  if (showFinance) {
    const [b, p] = await Promise.all([loadBudget(pool, pid), loadPayments(pool, pid, timeZone)]);
    const s = budgetSummary(project, b);
    const live = p.milestones.filter((m) => !m.archived_at);
    const upcomingLimit = addDaysISO(today, 30);
    const monthly = new Map<string, number[]>();
    for (const m of live) for (const t of m.transactions) {
      if (t.archived_at) continue;
      const k = String(t.paid_date).slice(0, 7);
      monthly.set(k, [...(monthly.get(k) ?? []), Number(t.amount)]);
    }
    finance = {
      controlBudget: project.control_budget,
      controlBudgetConfirmed: project.control_budget_confirmed,
      approvedCommitments: s.approvedCommitments,
      approvedItemCount: s.approvedItemCount,
      itemCount: s.itemCount,
      scheduled: p.totals.scheduled,
      paid: p.totals.paid,
      pending: p.totals.pending,
      overdue: p.totals.overdue,
      overdueCount: p.totals.overdueCount,
      overpaid: p.totals.overpaid,
      misc: s.misc,
      byCategory: s.byCategory,
      upcomingPayments: live
        .filter((m) => m.balance.pending > 0 && !m.balance.isOverdue && m.status === 'active' && m.due_date && m.due_date >= today && m.due_date <= upcomingLimit)
        .map((m) => ({ id: m.id, payee_name: m.payee_name, description: m.description, due_date: m.due_date, pending: m.balance.pending })),
      overduePayments: live
        .filter((m) => m.balance.isOverdue)
        .map((m) => ({ id: m.id, payee_name: m.payee_name, description: m.description, due_date: m.due_date, pending: m.balance.pending })),
      paymentsOverTime: [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, amount: sumMoney(v) })),
    };
  }

  const responsibility: Record<string, number> = {};
  for (const m of materials.items) {
    const k = SUPPLY_RESPONSIBILITY_LABELS[m.supply_responsibility as keyof typeof SUPPLY_RESPONSIBILITY_LABELS] ?? m.supply_responsibility;
    responsibility[k] = (responsibility[k] ?? 0) + 1;
  }

  return {
    project: { id: pid, code: project.code, name: project.name, location: project.location, status: project.status, archived_at: project.archived_at },
    today,
    finance,
    materials: { ...materialStats(materials.items, today), responsibility },
    upcomingConsultantVisits: cv.rows,
    upcomingSiteVisits: sv.rows,
    timeline: timelineStats(timeline),
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // prevent spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send('﻿' + body);
}

export function dashboardRoutes(pool: pg.Pool, timeZone: string) {
  const r = Router({ mergeParams: true });

  r.get('/dashboard', async (req, res) => {
    res.json(await projectDashboard(pool, req.project!, req.user!.role, timeZone));
  });

  // ---- CSV reports (project-scoped)
  const safeCode = (c: string) => c.replace(/[^A-Za-z0-9]+/g, '-');
  r.get('/reports/payments.csv', async (req, res) => {
    assertCap(req, 'payments.read');
    const p = await loadPayments(pool, req.project!.id, timeZone);
    const rows: unknown[][] = [];
    for (const m of p.milestones) {
      const base = [m.payee_type, m.payee_name, m.cost_category, m.budget_item_name ?? '', m.po_contract_ref, m.invoice_ref, m.description, m.due_date, m.scheduled_amount, m.balance.paid, m.balance.pending, m.balance.derivedStatus];
      if (!m.transactions.filter((t: any) => !t.archived_at).length) rows.push([...base, '', '', '', '', m.notes]);
      for (const t of m.transactions.filter((x: any) => !x.archived_at)) rows.push([...base, t.paid_date, t.method, t.reference, t.amount, t.notes || m.notes]);
    }
    sendCsv(res, `payments-${safeCode(req.project!.code)}.csv`,
      ['Payee type', 'Payee', 'Cost category', 'Budget item', 'PO/Contract', 'Invoice', 'Milestone', 'Due date', 'Scheduled (QAR)', 'Total paid (QAR)', 'Pending (QAR)', 'Status', 'Transfer date', 'Method', 'Bank/cheque ref', 'Transfer amount (QAR)', 'Notes'],
      rows);
  });

  r.get('/reports/materials.csv', async (req, res) => {
    assertCap(req, 'materials.read');
    const m = await loadMaterials(pool, req.project!.id);
    sendCsv(res, `materials-${safeCode(req.project!.code)}.csv`,
      ['Category', 'Description', 'Quantity', 'Unit', 'Amount (QAR)', 'Supply responsibility', 'Vendor', 'Status', 'Required on site / supply due', 'Planned delivery', 'Confirmed delivery', 'Revised delivery', 'Actual delivery', 'Date note', 'Qty ordered', 'Qty delivered', 'Inspection', 'Next follow-up', 'Notes', 'Source'],
      m.items.map((x) => [x.category, x.description, x.quantity, x.unit, x.amount, SUPPLY_RESPONSIBILITY_LABELS[x.supply_responsibility as keyof typeof SUPPLY_RESPONSIBILITY_LABELS], x.vendor, x.status, x.required_on_site_date, x.planned_delivery_date, x.confirmed_delivery_date, x.revised_delivery_date, x.actual_delivery_date, x.delivery_date_note, x.qty_ordered, x.qty_delivered, x.inspection_status, x.next_follow_up_date, x.notes, x.source_label]));
  });

  r.get('/reports/budget.csv', async (req, res) => {
    assertCap(req, 'budget.read');
    const b = await loadBudget(pool, req.project!.id);
    const cat = new Map(b.categories.map((c) => [c.id, c]));
    sendCsv(res, `budget-${safeCode(req.project!.code)}.csv`,
      ['Category', 'Kind', 'Item', 'Source amount', 'Variant A – Individual (ref)', 'Variant B – Al Wathab (ref)', 'Source status', 'Approved amount', 'Scheduled payments', 'Paid', 'Source', 'Notes', 'Archived'],
      b.items.map((i) => [cat.get(i.category_id)?.name, cat.get(i.category_id)?.kind, i.name, i.source_amount, i.source_variant_a, i.source_variant_b, i.source_status, i.approved_amount ?? 'Needs confirmation', i.scheduled_amount, i.paid_amount, i.source_label, i.notes, i.archived_at ? 'yes' : '']));
  });

  return r;
}

/** Portfolio across all projects the user can access; totals are per project, never pooled. */
export function portfolioRoute(pool: pg.Pool, timeZone: string) {
  const r = Router();
  r.get('/', async (req, res) => {
    const u = req.user!;
    const includeArchived = req.query.includeArchived === '1' && u.role === 'admin';
    const { rows } = await pool.query(
      u.role === 'admin'
        ? `SELECT * FROM projects WHERE ($1 OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, created_at`
        : `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 WHERE p.archived_at IS NULL ORDER BY p.created_at`,
      u.role === 'admin' ? [includeArchived] : [u.id],
    );
    const out = [];
    for (const p of rows) {
      const d = await projectDashboard(pool, p, u.role, timeZone);
      out.push({
        project: p,
        finance: d.finance
          ? { controlBudget: p.control_budget, controlBudgetConfirmed: p.control_budget_confirmed, approvedCommitments: d.finance.approvedCommitments, paid: d.finance.paid, pending: d.finance.pending, overdue: d.finance.overdue }
          : null,
        materials: { total: d.materials.total, awaitingConfirmation: d.materials.awaitingConfirmation, overdue: d.materials.overdue.length, dueSoon: d.materials.dueSoon.length },
        timeline: { total: d.timeline.total, completed: d.timeline.completed, percent: d.timeline.percent },
        upcomingVisits: d.upcomingConsultantVisits.length + d.upcomingSiteVisits.length,
      });
    }
    res.json(out);
  });
  return r;
}
