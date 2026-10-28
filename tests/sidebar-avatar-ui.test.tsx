// Desktop sidebar (expanded / collapsed), role-based module visibility and order, the active module, the
// project selector and Drive shortcut, the compact top bar, and avatars with initials as the fallback.
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar, TopBar } from '../src/components/Sidebar';
import { Avatar, initialsOf } from '../src/components/Avatar';
import { ProfilePictureEditor } from '../src/components/ProfilePicture';
import { UiProvider } from '../src/components/ui';
import { SessionContext, type Session } from '../src/lib/session';
import { DESKTOP_LAYOUT_QUERY } from '../src/lib/media';
import type { Project, Section } from '../src/lib/types';
import { capabilitiesFor } from '../server/permissions';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', code: 'PIN 70153699', name: 'Umm Garn', location: 'Umm Garn', description: '', client: '', status: '',
  planned_start_date: null, target_completion_date: null, misc_percentage: 0, misc_basis: 'approved_finishing',
  control_budget: null, control_budget_confirmed: false, control_budget_confirmed_at: null,
  drive_folder_url: '', sheets_url: '', payments_drive_url: '', materials_drive_url: '', consultant_drive_url: '', site_visits_drive_url: '',
  notes: '', archived_at: null, ...over,
});
type Role = 'admin' | 'viewer' | 'contractor' | 'consultant' | 'project_manager';
const session = (role: Role, avatar: string | null = null): Session => {
  const caps = capabilitiesFor(role) as string[];
  return { user: { id: 'u1', email: 'u@x', name: 'Siva Sithu', role, avatar_version: avatar }, capabilities: caps, can: (c) => caps.includes(c), logout: () => undefined };
};
const wrap = (role: Role, el: React.ReactElement, avatar: string | null = null) =>
  renderToStaticMarkup(<UiProvider><SessionContext.Provider value={session(role, avatar)}>{el}</SessionContext.Provider></UiProvider>);
const sidebar = (role: Role, opts: { collapsed?: boolean; section?: Section; p?: Project | null } = {}) => {
  const p = opts.p === undefined ? project() : opts.p;
  return wrap(role, <Sidebar section={opts.section ?? 'materials'} onNavigate={() => undefined} projects={p ? [p] : []} current={p} onSelectProject={() => undefined}
    onCreateProject={() => undefined} onProjectSettings={() => undefined} collapsed={!!opts.collapsed} onToggleCollapsed={() => undefined} />);
};
const navLabels = (html: string) => {
  const nav = html.slice(html.indexOf('aria-label="Main"'), html.indexOf('</nav>'));
  return [...nav.replace(/&amp;/g, '&').matchAll(/<button[^>]*>.*?<\/svg>(?:<span[^>]*>([^<]*)<\/span>)?<\/button>/g)].map((m) => m[1]).filter(Boolean);
};

describe('desktop sidebar', () => {
  it('is used from 1024px of window width (below that the existing header is kept)', () => {
    expect(DESKTOP_LAYOUT_QUERY).toBe('(min-width: 1024px)');
  });

  it('expanded: logo, project selector with name and code, Drive shortcut, modules in the usual order', () => {
    const html = sidebar('admin', { p: project({ drive_folder_url: 'https://drive.google.com/drive/folders/abc' }) });
    expect(html).toContain('src="/qonnect-logo.png"');
    expect(html).toContain('role="group" aria-label="Project"');
    expect(html).toContain('aria-label="Switch project. Current: Umm Garn, PIN 70153699"');
    expect(html).toMatch(/<a href="https:\/\/drive\.google\.com\/drive\/folders\/abc" target="_blank" rel="noopener noreferrer"/);
    expect(html.indexOf('aria-label="Project"')).toBeLessThan(html.indexOf('aria-label="Main"'));
    expect(navLabels(html)).toEqual(['All Projects', 'Dashboard', 'Master Items & Budget', 'Payments', 'Contracts & Documents', 'Material Supply', 'Consultant Visits', 'Site Visits', 'Timeline', 'Contacts', 'Audit']);
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('marks exactly one active module', () => {
    const html = sidebar('admin', { section: 'payments' });
    const active = /<button[^>]*aria-current="page"[^>]*>(.*?)<\/button>/.exec(html)?.[1] ?? '';
    expect(active).toContain('Payments');
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  it('shows only the modules the role can open', () => {
    const viewer = navLabels(sidebar('viewer'));
    const admin = navLabels(sidebar('admin'));
    expect(viewer.length).toBeLessThanOrEqual(admin.length);
    expect(viewer).not.toContain('Audit');
    // same relative order as the full list
    expect(viewer).toEqual(admin.filter((l) => viewer.includes(l)));
  });

  it('collapsed: icon-only buttons keep accessible names; project switching and Drive stay reachable', () => {
    const html = sidebar('admin', { collapsed: true });
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('aria-expanded="false"');
    for (const l of ['All Projects', 'Dashboard', 'Payments', 'Material Supply', 'Audit']) expect(html).toContain(`aria-label="${l}"`);
    expect(html).toContain('aria-label="Switch project. Current: Umm Garn, PIN 70153699"');
    expect(html).toContain('aria-label="Add Drive folder"');
    expect(navLabels(html)).toEqual([]); // no visible text labels
    expect(html).toContain('w-[4.5rem]');
  });

  it('Drive states follow permissions; no project → no Drive shortcut', () => {
    expect(sidebar('viewer')).toContain('Drive not linked');
    expect(sidebar('viewer')).toContain('aria-disabled="true"');
    expect(sidebar('admin')).toContain('Add Drive folder');
    const none = sidebar('admin', { p: null, section: 'portfolio' });
    expect(none).toContain('Select project');
    expect(none).not.toMatch(/Drive (folder|not linked)/);
  });

  it('the menu scrolls on its own and animations respect reduced motion', () => {
    const html = sidebar('admin');
    expect(html).toMatch(/<nav aria-label="Main" class="[^"]*overflow-y-auto/);
    expect(html).toContain('h-screen');
    expect(html).not.toMatch(/(?<!motion-safe:)transition-\[width\]/);
  });
});

describe('top bar', () => {
  it('shows the page title, notifications and the account menu with the avatar', () => {
    const html = wrap('admin', <TopBar section="timeline" current={project()} onNavigate={() => undefined} onChangePassword={() => undefined} onInstallApp={() => undefined} onProfilePicture={() => undefined} />, '1700000000000');
    expect(html).toContain('data-testid="page-title">Timeline<');
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('aria-label="Account menu for Siva Sithu"');
    expect(html).toContain('src="/api/users/u1/avatar?v=1700000000000"');
  });
});

describe('avatars', () => {
  it('initials when there is no picture (Latin and Arabic names)', () => {
    expect(initialsOf('Siva Sithu')).toBe('SS');
    expect(initialsOf('admin')).toBe('A');
    expect(initialsOf('محمد علي')).toBe('مع');
    expect(initialsOf('')).toBe('?');
    const html = renderToStaticMarkup(<Avatar userId="u1" name="Siva Sithu" version={null} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('>SS<');
    expect(html).toContain('rounded-full');
  });

  it('the picture comes from the authorised, versioned endpoint', () => {
    const html = renderToStaticMarkup(<Avatar userId="u1" name="Siva Sithu" version="42" size="lg" />);
    expect(html).toContain('src="/api/users/u1/avatar?v=42"');
    expect(html).toContain('alt=""');
  });

  it('the editor explains formats and size before upload and offers remove only when there is a picture', () => {
    const none = wrap('viewer', <ProfilePictureEditor userId="u1" name="Siva Sithu" version={null} onChanged={() => undefined} />);
    expect(none).toContain('JPEG, PNG or WebP, up to 5 MB');
    expect(none).toContain('Upload picture');
    expect(none).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(none).not.toContain('Remove');
    const has = wrap('viewer', <ProfilePictureEditor userId="u1" name="Siva Sithu" version="9" onChanged={() => undefined} />);
    expect(has).toContain('Replace picture');
    expect(has).toContain('Remove');
  });
});
