// Project toolbar (header): selector + Drive action states, and the active section in the tab row.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header';
import { SessionContext, type Session } from '../src/lib/session';
import type { Project } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', code: 'PIN 70153699', name: 'Umm Garn', location: 'Umm Garn', description: '', client: '', status: '',
  planned_start_date: null, target_completion_date: null, misc_percentage: 0, misc_basis: 'approved_finishing',
  control_budget: null, control_budget_confirmed: false, control_budget_confirmed_at: null,
  drive_folder_url: '', sheets_url: '', payments_drive_url: '', materials_drive_url: '', consultant_drive_url: '', site_visits_drive_url: '',
  notes: '', archived_at: null, ...over,
});
const session = (role: 'admin' | 'viewer'): Session => {
  const caps = capabilitiesFor(role) as string[];
  return { user: { id: 'u', email: 'u@x', name: 'sivasithu', role }, capabilities: caps, can: (c) => caps.includes(c), logout: () => undefined };
};
const render = (role: 'admin' | 'viewer', p: Project | null, section: 'materials' | 'portfolio' = 'materials') =>
  renderToStaticMarkup(
    <SessionContext.Provider value={session(role)}>
      <Header section={section} onNavigate={() => undefined} projects={p ? [p] : []} current={p} onSelectProject={() => undefined}
        onCreateProject={() => undefined} onProjectSettings={() => undefined} onChangePassword={() => undefined} onInstallApp={() => undefined} />
    </SessionContext.Provider>,
  );

describe('project toolbar', () => {
  it('shows the project name and code together in one project group', () => {
    const html = render('admin', project({ drive_folder_url: 'https://drive.google.com/drive/folders/abc' }));
    expect(html).toContain('role="group" aria-label="Project"');
    expect(html).toContain('Umm Garn');
    expect(html).toContain('PIN 70153699');
    expect(html).toContain('aria-label="Switch project. Current: Umm Garn, PIN 70153699"');
  });

  it('linked Drive: "Open Drive folder" link opening in a new tab', () => {
    const html = render('viewer', project({ drive_folder_url: 'https://drive.google.com/drive/folders/abc' }));
    expect(html).toMatch(/<a href="https:\/\/drive\.google\.com\/drive\/folders\/abc" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('Open Drive folder');
    expect(html).not.toContain('Add Drive folder');
    expect(html).not.toContain('Drive not linked');
  });

  it('no Drive link: editors get "Add Drive folder"; others a disabled "Drive not linked" — never a blue link', () => {
    const admin = render('admin', project());
    expect(admin).toContain('Add Drive folder');
    expect(admin).not.toContain('Open Drive folder');
    expect(admin).not.toMatch(/<a href="[^"]*drive/i);
    const viewer = render('viewer', project());
    expect(viewer).toContain('Drive not linked');
    expect(viewer).toContain('aria-disabled="true"');
    expect(viewer).not.toContain('Add Drive folder');
    expect(viewer).not.toContain('Open Drive folder');
  });

  it('no project selected: no Drive action', () => {
    const html = render('admin', null, 'portfolio');
    expect(html).toContain('Select project');
    expect(html).not.toMatch(/Drive (folder|not linked)/);
  });

  it('main navigation sits below the toolbar with the active section marked', () => {
    const html = render('admin', project());
    expect(html.indexOf('aria-label="Project"')).toBeLessThan(html.indexOf('aria-label="Main"'));
    const active = /<button[^>]*aria-current="page"[^>]*>(.*?)<\/button>/.exec(html)?.[1] ?? '';
    expect(active).toContain('Material Supply');
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });
});
