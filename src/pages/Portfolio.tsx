import React from 'react';
import { Building2, Layers, Plus } from 'lucide-react';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Project, Section } from '../lib/types';
import { formatQAR } from '../lib/format';
import { Badge, Button, EmptyState, NeedsConfirmation, PageHeader, Spinner, Notice } from '../components/ui';

interface Row {
  project: Project;
  finance: { controlBudget: number | null; controlBudgetConfirmed: boolean; approvedCommitments: number; paid: number; pending: number; overdue: number } | null;
  materials: { total: number; awaitingConfirmation: number; overdue: number; dueSoon: number };
  timeline: { total: number; completed: number; percent: number };
  upcomingVisits: number;
}

export function Portfolio({ onOpen, onCreate }: { onOpen: (id: string, s?: Section) => void; onCreate: () => void }) {
  const { can } = useSession();
  const { data, error } = useApi<Row[]>(`/api/portfolio${can('projects.manage') ? '?includeArchived=1' : ''}`);
  return (
    <div>
      <PageHeader icon={<Layers className="w-5 h-5" />} title="Project portfolio"
        subtitle="Each project's totals are calculated separately. Project names can repeat — the project code identifies each one."
        actions={can('projects.manage') && <Button variant="primary" onClick={onCreate}><Plus className="w-4 h-4" />New project</Button>} />
      {error && <Notice tone="rose">{error}</Notice>}
      {!data ? <Spinner /> : data.length === 0 ? <EmptyState title="No projects">No projects are assigned to you.</EmptyState> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
          {data.map((r) => (
            <div key={r.project.id} className={`bg-white rounded-xl border shadow-2xs p-5 ${r.project.archived_at ? 'border-dashed border-slate-300 opacity-75' : 'border-slate-200'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center shrink-0"><Building2 className="w-5 h-5" /></div>
                  <div className="min-w-0">
                    <h3 className="text-base font-bold text-slate-900 truncate">{r.project.name}</h3>
                    <div className="text-sm font-mono font-bold text-sky-700">{r.project.code}</div>
                    <div className="text-xs text-slate-500">{r.project.location}{r.project.status ? ` · ${r.project.status}` : ''}</div>
                  </div>
                </div>
                {r.project.archived_at ? <Badge tone="rose">Archived</Badge> : <Button size="sm" variant="primary" onClick={() => onOpen(r.project.id)}>Open</Button>}
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 text-xs">
                {r.finance && (
                  <>
                    <div><dt className="text-slate-500">Control budget</dt><dd className="font-semibold mt-0.5">{r.finance.controlBudget === null || !r.finance.controlBudgetConfirmed ? <NeedsConfirmation /> : formatQAR(r.finance.controlBudget)}</dd></div>
                    <div><dt className="text-slate-500">Approved commitments</dt><dd className="font-mono font-semibold mt-0.5">{formatQAR(r.finance.approvedCommitments)}</dd></div>
                    <div><dt className="text-slate-500">Paid</dt><dd className="font-mono font-semibold text-sky-700 mt-0.5">{formatQAR(r.finance.paid)}</dd></div>
                    <div><dt className="text-slate-500">Pending</dt><dd className="font-mono font-semibold text-amber-800 mt-0.5">{formatQAR(r.finance.pending)}</dd></div>
                    <div><dt className="text-slate-500">Overdue</dt><dd className={`font-mono font-semibold mt-0.5 ${r.finance.overdue ? 'text-rose-700' : ''}`}>{formatQAR(r.finance.overdue)}</dd></div>
                  </>
                )}
                <div><dt className="text-slate-500">Material lines</dt><dd className="font-semibold mt-0.5">{r.materials.total} <span className="text-slate-400 font-normal">({r.materials.awaitingConfirmation} awaiting confirmation)</span></dd></div>
                <div><dt className="text-slate-500">Materials overdue / due ≤14d</dt><dd className="font-semibold mt-0.5">{r.materials.overdue} / {r.materials.dueSoon}</dd></div>
                <div><dt className="text-slate-500">Timeline tasks done</dt><dd className="font-semibold mt-0.5">{r.timeline.completed}/{r.timeline.total} ({r.timeline.percent}%)</dd></div>
                <div><dt className="text-slate-500">Upcoming visits</dt><dd className="font-semibold mt-0.5">{r.upcomingVisits}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
