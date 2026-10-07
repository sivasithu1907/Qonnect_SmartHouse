// Contacts / Companies UI pieces: navigation entry per role, record-form selectors and quick-add,
// linked-name badge, contact actions (WhatsApp never pre-fills or sends) and the phone input default.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';
import { SessionContext, type Session } from '../src/lib/session';
import type { Project } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';
import type { Role } from '../shared/constants';
import { ContactActions } from '../src/components/directory/ContactActions';
import { DirectoryLinkBadge, useDirectoryLink } from '../src/components/directory/DirectoryLink';
import { contactOptions, entryOptions, type ProjectDirectoryEntry } from '../src/lib/directory';
import { PhoneInput, RecordForm } from '../src/components/ui';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', code: 'PIN 1', name: 'Villa', location: '', description: '', client: '', status: '',
  planned_start_date: null, target_completion_date: null, misc_percentage: 0, misc_basis: 'approved_finishing',
  control_budget: null, control_budget_confirmed: false, control_budget_confirmed_at: null,
  drive_folder_url: '', sheets_url: '', payments_drive_url: '', materials_drive_url: '', consultant_drive_url: '', site_visits_drive_url: '',
  notes: '', archived_at: null, ...over,
});
const session = (role: Role): Session => {
  const caps = capabilitiesFor(role) as string[];
  return { user: { id: 'u', email: 'u@x', name: 'u', role }, capabilities: caps, can: (c) => caps.includes(c), logout: () => undefined };
};
const withSession = (role: Role, el: React.ReactElement) => renderToStaticMarkup(<SessionContext.Provider value={session(role)}>{el}</SessionContext.Provider>);
const header = (role: Role) => withSession(role,
  <Header section="contacts" onNavigate={() => undefined} projects={[project()]} current={project()} onSelectProject={() => undefined}
    onCreateProject={() => undefined} onProjectSettings={() => undefined} onChangePassword={() => undefined} onInstallApp={() => undefined} />);

const list: ProjectDirectoryEntry[] = [
  { id: 'e1', ref: 'DIR-0001', display_name: 'Gulf Gypsum WLL', entity_type: 'company', entry_roles: ['subcontractor', 'supplier'], roles: ['subcontractor'], scope: '', responsible_contact_id: null,
    contacts: [{ id: 'c1', name: 'Ali', position: 'PM', is_primary: true }, { id: 'c2', name: 'Sara', position: '', is_primary: false }] },
  { id: 'e2', ref: 'DIR-0002', display_name: 'Eng. Samir', entity_type: 'individual', entry_roles: ['consultant'], roles: ['consultant'], scope: '', responsible_contact_id: null, contacts: [] },
];

function FormWithLink({ p, row }: { p: Project; row: Record<string, any> | null }) {
  const dir = useDirectoryLink(p);
  return <RecordForm fields={[{ name: 'company_name', label: 'Company name' }, ...dir.fields(row)]} initial={row} onSubmit={async () => undefined} onCancel={() => undefined} />;
}

describe('Contacts navigation', () => {
  it('is shown to admin, project manager and viewer only — never to contractors or consultants', () => {
    for (const r of ['admin', 'project_manager', 'viewer'] as Role[]) expect(header(r)).toContain('Contacts');
    for (const r of ['contractor', 'consultant'] as Role[]) expect(header(r)).not.toMatch(/>Contacts</);
  });
});

describe('record-form directory selectors', () => {
  it('options: entries assigned to the project grouped as companies / individuals; contacts of the chosen entry only', () => {
    const o = entryOptions(list);
    expect(o.map((x) => [x.value, x.group])).toEqual([['e1', 'Companies'], ['e2', 'Individuals']]);
    expect(o[0].keywords).toContain('DIR-0001');
    expect(contactOptions(list, 'e1').map((c) => c.label)).toEqual(['Ali', 'Sara']);
    expect(contactOptions(list, 'e2')).toEqual([]);
    expect(contactOptions(list, null)).toEqual([]);
  });

  it('PM on an active project: selector plus "assign or add" action; the typed name field stays', () => {
    const html = withSession('project_manager', <FormWithLink p={project()} row={null} />);
    expect(html).toContain('Company name');
    expect(html).toContain('Directory company / individual');
    expect(html).toContain('Not listed? Assign an existing entry or add a new one');
  });

  it('archived project or viewer: no quick-add; contractor / consultant: no directory fields at all', () => {
    expect(withSession('project_manager', <FormWithLink p={project({ archived_at: '2026-01-01' })} row={null} />)).not.toContain('Not listed?');
    expect(withSession('viewer', <FormWithLink p={project()} row={null} />)).not.toContain('Not listed?');
    for (const r of ['contractor', 'consultant'] as Role[]) {
      const html = withSession(r, <FormWithLink p={project()} row={null} />);
      expect(html).not.toContain('Directory company');
      expect(html).toContain('Company name');
    }
  });

  it('an existing (even archived) link is shown by name while the list loads', () => {
    const html = withSession('admin', <FormWithLink p={project()} row={{ company_name: 'Old Name Co', directory_entry_id: 'e9', directory_entry_name: 'New Name WLL', directory_entry_archived_at: '2026-02-01', directory_contact_id: 'c9', directory_contact_name: 'Ali' }} />);
    expect(html).toContain('New Name WLL (archived)');
    expect(html).toContain('value="Old Name Co"');
  });
});

describe('linked badge and contact actions', () => {
  it('badge shows the linked entry and contact next to the recorded name; nothing when not linked', () => {
    expect(renderToStaticMarkup(<DirectoryLinkBadge row={{}} />)).toBe('');
    const html = renderToStaticMarkup(<DirectoryLinkBadge row={{ directory_entry_name: 'Gulf Gypsum WLL', directory_contact_name: 'Ali', directory_entry_archived_at: '2026-01-01' }} />);
    expect(html).toContain('Gulf Gypsum WLL');
    expect(html).toContain('Ali');
    expect(html).toContain('Archived');
  });

  it('call / WhatsApp / email links; WhatsApp opens a chat without any pre-filled text', () => {
    const html = renderToStaticMarkup(<ContactActions phone="5512 3456" email="a@b.qa" name="Ali" />);
    expect(html).toContain('href="tel:+97455123456"');
    expect(html).toContain('href="https://wa.me/97455123456"');
    expect(html).not.toContain('text=');
    expect(html).toContain('href="mailto:a@b.qa"');
    expect(renderToStaticMarkup(<ContactActions phone="" email="" />)).toBe('');
  });

  it('phone input defaults to Qatar +974 and keeps international numbers', () => {
    expect(renderToStaticMarkup(<PhoneInput value="" onChange={() => undefined} />)).toMatch(/<option value="974" selected="">/);
    const intl = renderToStaticMarkup(<PhoneInput value="+44 20 7946 0000" onChange={() => undefined} />);
    expect(intl).toMatch(/<option value="44" selected="">/);
  });
});
