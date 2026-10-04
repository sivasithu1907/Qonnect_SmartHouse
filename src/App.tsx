import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, Table } from 'lucide-react';
import { get, post, setCsrfToken, setUnauthorizedHandler } from './lib/api';
import { SessionContext, useSession, type Session } from './lib/session';
import { projectsForSelector } from './lib/projects';
import type { Project, Section, User } from './lib/types';
import { PAGE_CONTAINER } from './lib/layout';
import { Header, projectLabel } from './components/Header';
import { Login } from './components/Login';
import { ChangePasswordModal, CreateProjectModal, ProjectSettingsModal } from './components/ProjectForms';
import { Spinner, UiProvider, EmptyState } from './components/ui';
import { Portfolio } from './pages/Portfolio';
import { Dashboard } from './pages/Dashboard';
import { Budget } from './pages/Budget';
import { Payments } from './pages/Payments';
import { Materials } from './pages/Materials';
import { ConsultantVisits } from './pages/ConsultantVisits';
import { SiteVisits } from './pages/SiteVisits';
import { Timeline } from './pages/Timeline';
import { AuditLog } from './pages/AuditLog';
import { Contracts } from './pages/Contracts';
import { UsersAdmin } from './pages/UsersAdmin';
import { NotificationSettings } from './pages/NotificationSettings';
import { UpdateBanner } from './components/UpdateBanner';
import { InstallAppDialog } from './components/InstallApp';
import { detachDeviceOnLogout, syncSubscription } from './lib/push';

const SECTIONS: Section[] = ['portfolio', 'dashboard', 'budget', 'payments', 'contracts', 'materials', 'consultant', 'site', 'timeline', 'audit', 'users', 'notifications'];
const UUID = /^[0-9a-f-]{36}$/i;
const FOCUS_FILTER = /^filter:[a-z-]{1,40}$/; // e.g. #/materials/<project>/filter:no-date

/** Location hash: #/<section>/<projectId?>/<recordId?> — keeps selection across reloads; notification links add a record id. */
function readHash(): { section: Section; projectId: string | null; focusId: string | null } {
  const [, s, p, f] = window.location.hash.split('/');
  return {
    section: SECTIONS.includes(s as Section) ? (s as Section) : 'dashboard',
    projectId: p && UUID.test(p) ? p : null,
    focusId: f && (UUID.test(f) || FOCUS_FILTER.test(f)) ? f : null,
  };
}

export default function App() {
  const [auth, setAuth] = useState<{ user: User; capabilities: string[] } | null | undefined>(undefined);

  const applyAuth = useCallback((d: any) => {
    setCsrfToken(d.csrfToken);
    setAuth({ user: d.user, capabilities: d.capabilities });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth(null));
    get('/api/auth/me').then(applyAuth).catch(() => setAuth(null));
  }, [applyAuth]);

  const session: Session | null = useMemo(() => auth ? {
    user: auth.user,
    capabilities: auth.capabilities,
    can: (c: string) => auth.capabilities.includes(c),
    logout: () => {
      // stop this (possibly shared) device receiving this user's alerts, then sign out
      void detachDeviceOnLogout().finally(() => post('/api/auth/logout').finally(() => { setAuth(null); window.location.hash = ''; }));
    },
  } : null, [auth]);

  if (auth === undefined) return <Spinner />;
  return (
    <UiProvider>
      {session ? (
        <SessionContext.Provider value={session}>
          <Shell />
        </SessionContext.Provider>
      ) : <Login onLoggedIn={applyAuth} />}
    </UiProvider>
  );
}

function Shell() {
  const { can } = useSession();
  const canManageProjects = can('projects.manage');
  const initial = readHash();
  const [section, setSection] = useState<Section>(initial.section);
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(initial.focusId);
  const [installOpen, setInstallOpen] = useState(false);

  useEffect(() => { void syncSubscription(); }, []);
  // a tapped push notification asks an already-open window to navigate
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const on = (e: MessageEvent) => {
      if (e.data?.type === 'OPEN_URL' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) {
        const hash = e.data.url.includes('#') ? e.data.url.slice(e.data.url.indexOf('#')) : '';
        if (hash) window.location.hash = hash;
      }
    };
    navigator.serviceWorker.addEventListener('message', on);
    return () => navigator.serviceWorker.removeEventListener('message', on);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const list = await get<Project[]>('/api/projects?includeArchived=1');
      setProjects(list);
      setError(null);
      return list;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, []);
  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const current = useMemo(() => {
    if (!projects) return null;
    return projects.find((p) => p.id === projectId) ?? projects.find((p) => !p.archived_at) ?? null;
  }, [projects, projectId]);

  useEffect(() => {
    const h = `#/${section}${current ? `/${current.id}` : ''}`;
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
  }, [section, current]);
  useEffect(() => {
    const on = () => { const r = readHash(); setSection(r.section); if (r.projectId) setProjectId(r.projectId); if (r.focusId) setFocusId(r.focusId); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const selectProject = (id: string) => {
    setProjectId(id);
    if (section === 'portfolio' || section === 'users' || section === 'notifications') setSection('dashboard');
  };
  const onProjectSaved = async (p: Project | null) => {
    await loadProjects();
    if (p) setProjectId(p.id);
    setRefreshKey((k) => k + 1);
  };

  if (!projects) return error ? <div className="p-8"><EmptyState title="Could not load projects">{error}</EmptyState></div> : <Spinner />;

  const selectable = projectsForSelector(projects, canManageProjects, current?.id);
  const pageKey = `${current?.id}-${refreshKey}`;
  const needsProject = !['portfolio', 'users', 'notifications'].includes(section);
  const focusProps = { focusId, onFocusHandled: () => setFocusId(null) };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <Header
        section={section}
        onNavigate={setSection}
        projects={selectable}
        current={current}
        onSelectProject={selectProject}
        onCreateProject={() => setCreateOpen(true)}
        onProjectSettings={() => setSettingsOpen(true)}
        onChangePassword={() => setPwOpen(true)}
        onInstallApp={() => setInstallOpen(true)}
      />
      <UpdateBanner />
      <main className={`flex-1 min-w-0 py-6 sm:py-8 ${PAGE_CONTAINER}`}>
        {section === 'portfolio' && <Portfolio key={refreshKey} onOpen={(id, s) => { setProjectId(id); setSection(s ?? 'dashboard'); }} onCreate={() => setCreateOpen(true)} />}
        {section === 'users' && <UsersAdmin projects={projects} />}
        {section === 'notifications' && <NotificationSettings projects={projects.filter((p) => !p.archived_at)} onInstallApp={() => setInstallOpen(true)} />}
        {needsProject && !current && <EmptyState title="No project selected">You are not assigned to any active project yet. Ask an administrator for access.</EmptyState>}
        {needsProject && current && (
          <React.Fragment key={pageKey}>
            {section === 'dashboard' && <Dashboard key={current.id} project={current} onNavigate={setSection} onSettings={() => setSettingsOpen(true)} />}
            {section === 'budget' && <Budget project={current} onSettings={() => setSettingsOpen(true)} />}
            {section === 'payments' && <Payments project={current} {...focusProps} />}
            {section === 'contracts' && <Contracts project={current} {...focusProps} />}
            {section === 'materials' && <Materials project={current} {...focusProps} />}
            {section === 'consultant' && <ConsultantVisits project={current} {...focusProps} />}
            {section === 'site' && <SiteVisits project={current} {...focusProps} />}
            {section === 'timeline' && <Timeline project={current} {...focusProps} />}
            {section === 'audit' && <AuditLog project={current} />}
          </React.Fragment>
        )}
      </main>
      <footer className="border-t border-slate-200 bg-white py-5 text-xs text-slate-500 mt-auto">
        <div className={`${PAGE_CONTAINER} flex flex-col sm:flex-row items-center justify-between gap-3`}>
          <span className="font-semibold text-slate-700">Qonnect{current ? ` · ${projectLabel(current)}` : ''}</span>
          {current && (
            <div className="flex items-center gap-3">
              {current.sheets_url && <a href={current.sheets_url} target="_blank" rel="noopener noreferrer" className="hover:text-emerald-700 flex items-center gap-1"><Table className="w-3.5 h-3.5 text-emerald-600" />Google Sheet</a>}
              {current.drive_folder_url && <a href={current.drive_folder_url} target="_blank" rel="noopener noreferrer" className="hover:text-sky-700 flex items-center gap-1"><FolderOpen className="w-3.5 h-3.5 text-sky-600" />Drive folder</a>}
            </div>
          )}
        </div>
      </footer>
      <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (p) => { setCreateOpen(false); await loadProjects(); setProjectId(p.id); setSection('dashboard'); }} />
      <ProjectSettingsModal key={current?.id} open={settingsOpen} project={current} onClose={() => setSettingsOpen(false)} onSaved={async (p) => { setSettingsOpen(false); await onProjectSaved(p); }} />
      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <InstallAppDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  );
}
