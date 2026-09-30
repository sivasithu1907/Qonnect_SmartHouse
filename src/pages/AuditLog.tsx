import React, { useState } from 'react';
import { History } from 'lucide-react';
import { useApi } from '../lib/hooks';
import type { AuditEntry, Project } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, inputCls, Notice, PageHeader, Spinner, Table, Td, Th } from '../components/ui';

const TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'sky' | 'slate' | 'violet'> = {
  create: 'emerald', update: 'sky', archive: 'rose', restore: 'amber', approve: 'violet', unapprove: 'amber',
  delivery_date_change: 'amber', complete: 'emerald', upload: 'sky', seed: 'slate',
};

export function AuditLog({ project }: { project: Project }) {
  const { data, error } = useApi<AuditEntry[]>(`/api/projects/${project.id}/audit?limit=500`);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const rows = data.filter((r) => !q || `${r.summary} ${r.entity_type} ${r.user_email ?? ''} ${r.action}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <PageHeader icon={<History className="w-5 h-5" />} title="Audit history" subtitle={`${project.name} — ${project.code} · latest 500 changes`} />
      <Card>
        <input className={`${inputCls} max-w-sm mb-4`} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        {rows.length === 0 ? <EmptyState /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>User</Th><Th>Action</Th><Th>Record</Th><Th>Summary</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <Td className="whitespace-nowrap">{formatDateTime(r.created_at)}</Td>
                    <Td>{r.user_email ?? 'system'}</Td>
                    <Td><Badge tone={TONE[r.action] ?? 'slate'}>{r.action.replace(/_/g, ' ')}</Badge></Td>
                    <Td className="text-[11px]">{r.entity_type.replace(/_/g, ' ')}</Td>
                    <Td>{r.summary}</Td>
                  </tr>
                  {open === r.id && (r.before || r.after) && (
                    <tr><td colSpan={5} className="bg-slate-50 px-4 py-2">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] font-mono">
                        <div><div className="font-sans font-semibold text-slate-600 mb-1">Before</div><pre className="whitespace-pre-wrap break-all">{JSON.stringify(r.before, null, 2)}</pre></div>
                        <div><div className="font-sans font-semibold text-slate-600 mb-1">After</div><pre className="whitespace-pre-wrap break-all">{JSON.stringify(r.after, null, 2)}</pre></div>
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
