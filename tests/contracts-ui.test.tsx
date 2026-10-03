// Contracts & Documents UI pieces: navigation entry per role, list search / filters,
// and which document types the upload control offers per record type.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';
import { SessionContext, type Session } from '../src/lib/session';
import type { Contract, Project } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';
import { filterContracts } from '../src/lib/contractFilters';
import { attachmentKindsFor, type Role } from '../shared/constants';

const project: Project = {
  id: 'p1', code: 'PIN 1', name: 'Villa', location: '', description: '', client: '', status: '',
  planned_start_date: null, target_completion_date: null, misc_percentage: 0, misc_basis: 'approved_finishing',
  control_budget: null, control_budget_confirmed: false, control_budget_confirmed_at: null,
  drive_folder_url: '', sheets_url: '', payments_drive_url: '', materials_drive_url: '', consultant_drive_url: '', site_visits_drive_url: '',
  notes: '', archived_at: null,
};
const header = (role: Role) => {
  const caps = capabilitiesFor(role) as string[];
  const s: Session = { user: { id: 'u', email: 'u@x', name: 'u', role }, capabilities: caps, can: (c) => caps.includes(c), logout: () => undefined };
  return renderToStaticMarkup(
    <SessionContext.Provider value={s}>
      <Header section="contracts" onNavigate={() => undefined} projects={[project]} current={project} onSelectProject={() => undefined}
        onCreateProject={() => undefined} onProjectSettings={() => undefined} onChangePassword={() => undefined} onInstallApp={() => undefined} />
    </SessionContext.Provider>,
  );
};

describe('project navigation', () => {
  it('shows "Contracts & Documents" to roles with contract access only', () => {
    for (const r of ['admin', 'project_manager', 'viewer'] as const) expect(header(r)).toContain('Contracts &amp; Documents');
    for (const r of ['contractor', 'consultant'] as const) expect(header(r)).not.toContain('Contracts &amp; Documents');
  });
  it('marks the section as current in the tab row', () => {
    expect(header('admin')).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Contracts &amp; Documents/);
  });
});

const k = (over: Partial<Contract>): Contract => ({
  id: 'x', title: 'Agreement', category_id: 'c1', category_name: 'Main Contractor', category_sort: 1, company_name: 'Builder Co', reference: '',
  signed_date: null, status: 'Draft', notes: '', drive_url: '', archived_at: null, created_at: '', updated_at: '', created_by_name: null,
  attachment_count: 0, amendment_count: 0, ...over,
});

describe('contract list filters', () => {
  const list = [
    k({ id: 'a', title: 'Main construction agreement', reference: 'MC-01', status: 'Active' }),
    k({ id: 'b', title: 'Gypsum works', company_name: 'Finish LLC', category_id: 'c2', category_name: 'Finishing Works', status: 'Signed', notes: 'ceiling boards' }),
    k({ id: 'c', title: 'Supervision', company_name: 'Consult', category_id: 'c3', category_name: 'Consultant', status: 'Completed' }),
  ];
  const ids = (f: Partial<{ q: string; categoryId: string; status: string }>) => filterContracts(list, { q: '', categoryId: '', status: '', ...f }).map((x) => x.id);
  it('search matches title, company, reference, category and notes, case-insensitively', () => {
    expect(ids({})).toEqual(['a', 'b', 'c']);
    expect(ids({ q: 'mc-01' })).toEqual(['a']);
    expect(ids({ q: 'FINISH' })).toEqual(['b']);
    expect(ids({ q: 'ceiling' })).toEqual(['b']);
    expect(ids({ q: 'consultant' })).toEqual(['c']);
    expect(ids({ q: 'nothing like this' })).toEqual([]);
  });
  it('category and status filters combine with search', () => {
    expect(ids({ categoryId: 'c2' })).toEqual(['b']);
    expect(ids({ status: 'Completed' })).toEqual(['c']);
    expect(ids({ status: 'Completed', q: 'gypsum' })).toEqual([]);
  });
});

describe('document types', () => {
  it('contracts and amendments offer contract document types; other records keep their original list', () => {
    expect(attachmentKindsFor('contract')).toEqual(['signed_contract', 'quotation', 'boq', 'amendment', 'supporting_document']);
    expect(attachmentKindsFor('contract_amendment')).toContain('amendment');
    expect(attachmentKindsFor('payment_transaction')).toEqual(['payment_slip', 'consultant_report', 'delivery_note', 'site_photo', 'supporting_document']);
  });
});
