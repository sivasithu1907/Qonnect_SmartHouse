import React, { useState } from 'react';
import { Pencil, Plus, Users } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import type { Project } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { ROLE_LABELS, ROLES } from '../../shared/constants';
import { Badge, Button, Card, Modal, Notice, PageHeader, RecordForm, Spinner, Table, Td, Th, useUi } from '../components/ui';

interface UserRow { id: string; email: string; name: string; role: string; is_active: boolean; last_login_at: string | null; locked_until: string | null; project_ids: string[] }

export function UsersAdmin({ projects }: { projects: Project[] }) {
  const { data, error, reload } = useApi<UserRow[]>('/api/users');
  const [edit, setEdit] = useState<{ row: UserRow | null } | null>(null);
  const { toast } = useUi();
  if (error) return <Notice tone="rose">{error}</Notice>;
  if (!data) return <Spinner />;
  const projectOptions = projects.map((p) => ({ value: p.id, label: `${p.name} — ${p.code}${p.archived_at ? ' (archived)' : ''}` }));
  const label = (id: string) => projects.find((p) => p.id === id)?.code ?? id;
  return (
    <div className="space-y-6">
      <PageHeader icon={<Users className="w-5 h-5" />} title="Users & access" subtitle="Admins see all projects. Other roles only see projects they are assigned to."
        actions={<Button variant="primary" onClick={() => setEdit({ row: null })}><Plus className="w-4 h-4" />New user</Button>} />
      <Card>
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Projects</Th><Th>Last login</Th><Th>Status</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((u) => (
              <tr key={u.id}>
                <Td className="font-semibold">{u.name}</Td>
                <Td>{u.email}</Td>
                <Td><Badge tone={u.role === 'admin' ? 'violet' : 'slate'}>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</Badge></Td>
                <Td className="text-[11px]">{u.role === 'admin' ? 'All projects' : u.project_ids.length ? u.project_ids.map(label).join(', ') : <span className="text-amber-700">None assigned</span>}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(u.last_login_at)}</Td>
                <Td>{!u.is_active ? <Badge tone="rose">Inactive</Badge> : u.locked_until && new Date(u.locked_until) > new Date() ? <Badge tone="amber">Locked</Badge> : <Badge tone="emerald">Active</Badge>}</Td>
                <Td><Button size="sm" variant="ghost" onClick={() => setEdit({ row: u })}><Pencil className="w-3.5 h-3.5" /></Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.row ? `Edit ${edit.row.name}` : 'New user'} wide>
        {edit && (
          <RecordForm mode={edit.row ? 'edit' : 'create'}
            initial={edit.row ? { name: edit.row.name, role: edit.row.role, isActive: edit.row.is_active, projectIds: edit.row.project_ids } : { role: 'viewer', projectIds: [], isActive: true }}
            fields={[
              { name: 'email', label: 'Email', required: true, hidden: !!edit.row },
              { name: 'name', label: 'Full name', required: true },
              { name: 'role', label: 'Role', type: 'select', options: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
              { name: 'isActive', label: 'Active', type: 'checkbox', hidden: !edit.row },
              { name: 'password', label: edit.row ? 'Reset password (leave blank to keep)' : 'Initial password', type: 'password', required: !edit.row, help: 'At least 12 characters with letters and numbers. Share it securely; the user should change it after first login.' },
              { name: 'projectIds', label: 'Assigned projects (Ctrl/Cmd-click for several)', type: 'multiselect', options: projectOptions },
              { name: 'unlock', label: 'Clear login lockout', type: 'checkbox', hidden: !edit.row },
            ]}
            onCancel={() => setEdit(null)}
            onSubmit={async (v) => {
              if (!v.password) delete v.password;
              if (edit.row) await patch(`/api/users/${edit.row.id}`, v); else await post('/api/users', v);
              toast('User saved'); setEdit(null); await reload();
            }} />
        )}
      </Modal>
    </div>
  );
}
