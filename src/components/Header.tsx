import React, { useEffect, useRef, useState } from 'react';
import { PAGE_CONTAINER } from '../lib/layout';
import {
  BookUser, Building2, CalendarDays, Check, ChevronDown, Coins, CreditCard, ExternalLink, FileSignature, FolderOpen, FolderPlus, FolderX, History, Layers, LayoutDashboard, LogOut,
  MapPin, Menu, Plus, Settings, Truck, UserCheck, Users, X, KeyRound, Bell, Download,
} from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { isStandalone } from '../lib/pwa';
import type { Project, Section } from '../lib/types';
import { useSession } from '../lib/session';
import { ROLE_LABELS } from '../../shared/constants';

export const projectLabel = (p: Pick<Project, 'name' | 'code'>) => `${p.name} — ${p.code}`;

/** The project menu shows a search box once the list is longer than this. */
export const PROJECT_SEARCH_MIN = 6;
/** Search by project name, code or location; active projects first, archived ones after. */
export function filterProjects(projects: Project[], query: string): { active: Project[]; archived: Project[] } {
  const q = query.trim().toLowerCase();
  const hit = (p: Project) => !q || `${p.name} ${p.code} ${p.location}`.toLowerCase().includes(q);
  const list = projects.filter(hit);
  return { active: list.filter((p) => !p.archived_at), archived: list.filter((p) => p.archived_at) };
}

interface Props {
  section: Section;
  onNavigate: (s: Section) => void;
  projects: Project[];
  current: Project | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onProjectSettings: () => void;
  onChangePassword: () => void;
  onInstallApp: () => void;
}

export function Header({ section, onNavigate, projects, current, onSelectProject, onCreateProject, onProjectSettings, onChangePassword, onInstallApp }: Props) {
  const { user, can, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const uref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
      if (uref.current && !uref.current.contains(e.target as Node)) setUserMenu(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setUserMenu(false); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, []);
  useEffect(() => { if (open) searchRef.current?.focus(); else setQuery(''); }, [open]);
  const showSearch = projects.length >= PROJECT_SEARCH_MIN;
  const nav: Array<{ id: Section; label: string; icon: React.FC<{ className?: string }>; show: boolean }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, show: true },
    { id: 'budget', label: 'Master Items & Budget', icon: Coins, show: can('budget.read') },
    { id: 'payments', label: 'Payments', icon: CreditCard, show: can('payments.read') },
    { id: 'contracts', label: 'Contracts & Documents', icon: FileSignature, show: can('contracts.read') },
    { id: 'materials', label: 'Material Supply', icon: Truck, show: can('materials.read') },
    { id: 'consultant', label: 'Consultant Visits', icon: UserCheck, show: can('consultant.read') },
    { id: 'site', label: 'Site Visits', icon: MapPin, show: can('site.read') },
    { id: 'timeline', label: 'Timeline', icon: CalendarDays, show: can('timeline.read') },
    { id: 'contacts', label: 'Contacts', icon: BookUser, show: can('directory.read') },
    { id: 'audit', label: 'Audit', icon: History, show: can('audit.read') },
  ];
  const go = (s: Section) => { onNavigate(s); setMobile(false); };
  const drive = current?.drive_folder_url ?? '';
  const navRef = useRef<HTMLElement>(null);

  // keep the active tab visible in the horizontally scrolling tab row (small screens)
  useEffect(() => {
    const el = navRef.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const l = active.offsetLeft, r = l + active.offsetWidth;
    if (l < el.scrollLeft) el.scrollLeft = l - 16;
    else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 16;
  }, [section]);

  const TAB = {
    sky: { on: 'text-sky-700 border-sky-600 font-semibold', icon: 'text-sky-600' },
    indigo: { on: 'text-indigo-700 border-indigo-600 font-semibold', icon: 'text-indigo-600' },
  };
  const tab = (id: Section, label: string, Icon: React.FC<{ className?: string }>, tone: 'sky' | 'indigo' = 'sky') => {
    const active = section === id;
    return (
      <button key={id} type="button" onClick={() => go(id)} aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-1.5 px-3 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors ${
          active ? TAB[tone].on : 'border-transparent font-medium text-slate-600 hover:text-slate-900 hover:border-slate-300'}`}>
        <Icon className={`w-[15px] h-[15px] ${active ? TAB[tone].icon : 'text-slate-400'}`} />
        <span>{label}</span>
      </button>
    );
  };
  const gridButton = (id: Section, label: string, Icon: React.FC<{ className?: string }>) => {
    const active = section === id;
    return (
      <button key={id} type="button" onClick={() => go(id)} aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-1.5 px-2.5 py-2 text-xs rounded-lg ${active ? 'bg-sky-50 text-sky-700 font-semibold' : 'font-medium text-slate-600 hover:bg-slate-100'}`}>
        <Icon className={`w-3.5 h-3.5 ${active ? 'text-sky-600' : 'text-slate-400'}`} /><span>{label}</span>
      </button>
    );
  };

  // Drive state: linked → open; not linked → add (editors) or a plain disabled note (everyone else)
  const canEditLinks = can('links.edit');
  const driveSegment = current && (drive ? (
    <a href={drive} target="_blank" rel="noopener noreferrer" title={`Open the Google Drive folder for ${projectLabel(current)} (new tab)`}
      className="shrink-0 flex items-center gap-2 px-3 sm:px-3.5 text-xs sm:text-[13px] font-semibold text-sky-700 bg-white hover:bg-sky-50 border-l border-slate-200">
      <FolderOpen className="w-4 h-4 text-sky-600" />
      <span className="sm:hidden">Open Drive</span><span className="hidden sm:inline">Open Drive folder</span>
      <ExternalLink className="hidden sm:block w-3 h-3 text-slate-400" />
    </a>
  ) : canEditLinks ? (
    <button type="button" onClick={onProjectSettings} title="No Drive folder linked — add the link in project settings"
      className="shrink-0 flex items-center gap-2 px-3 sm:px-3.5 text-xs sm:text-[13px] font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border-l border-slate-200">
      <FolderPlus className="w-4 h-4 text-slate-500" />
      <span className="sm:hidden">Add Drive</span><span className="hidden sm:inline">Add Drive folder</span>
    </button>
  ) : (
    <span role="note" aria-disabled="true" title="No Drive folder linked yet — ask an admin or project manager to add it"
      className="shrink-0 flex items-center gap-2 px-3 sm:px-3.5 text-xs sm:text-[13px] font-semibold text-slate-500 bg-slate-50 border-l border-slate-200 cursor-not-allowed">
      <FolderX className="w-4 h-4 text-slate-400" />
      <span className="sm:hidden">No Drive</span><span className="hidden sm:inline">Drive not linked</span>
    </span>
  ));

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80 shadow-2xs">
      <div className={PAGE_CONTAINER}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 md:py-0 md:h-16 md:flex-nowrap">
          {/* brand */}
          <button type="button" onClick={() => go('portfolio')} title="Qonnect — all projects" className="order-1 flex items-center gap-2 shrink-0 rounded-lg hover:opacity-90">
            <img src="/qonnect-logo.png" alt="Qonnect" width={36} height={36} className="w-9 h-9 object-contain" />
            <span className="hidden lg:block text-base font-bold tracking-tight text-slate-900">Qonnect</span>
          </button>
          <span className="order-1 hidden md:block w-px h-7 bg-slate-200" aria-hidden="true" />

          {/* project toolbar: selector + Drive action as one control (full width on phones) */}
          <div className="order-3 w-full md:order-2 md:w-auto min-w-0 relative" ref={ref}>
            <div role="group" aria-label="Project"
              className="flex items-stretch h-12 md:h-11 min-w-0 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true"
                aria-label={current ? `Switch project. Current: ${current.name}, ${current.code}` : 'Select project'}
                className="flex-1 md:flex-initial min-w-0 flex items-center gap-2.5 pl-1.5 pr-2.5 text-left hover:bg-slate-50">
                <span className="w-8 h-8 shrink-0 rounded-lg bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center"><Building2 className="w-4 h-4" /></span>
                <span className="min-w-0 flex flex-col">
                  {current ? (
                    <>
                      <span className="text-sm font-bold text-slate-900 leading-tight truncate md:max-w-[22rem]">{current.name}</span>
                      <span className="flex items-center gap-1.5 leading-tight"><span className="text-[11px] font-mono font-semibold text-sky-700 tracking-wide">{current.code}</span>{current.archived_at && <span className="text-[10px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">Archived · read-only</span>}</span>
                    </>
                  ) : <span className="text-sm font-semibold text-slate-600">Select project</span>}
                </span>
                <ChevronDown className={`ml-auto md:ml-1 w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {driveSegment}
            </div>
            {open && (
              <div className="absolute left-0 top-full mt-1.5 w-80 max-w-[calc(100vw-1.5rem)] bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-50">
                <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">Switch project</div>
                {showSearch && (
                  <div className="px-2 pt-2">
                    <label htmlFor="project-search" className="sr-only">Search projects by name or code</label>
                    <input id="project-search" ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or code…"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500/30 focus:border-sky-400" />
                  </div>
                )}
                <div className="max-h-72 overflow-y-auto py-1">
                  <ProjectMenuList projects={projects} query={query} currentId={current?.id ?? null} onSelect={(id) => { onSelectProject(id); setOpen(false); }} />
                </div>
                <div className="pt-1 mt-1 border-t border-slate-100 px-2 space-y-1">
                  <button onClick={() => { go('portfolio'); setOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg">
                    <Layers className="w-3.5 h-3.5 text-indigo-600" />Portfolio (all projects)
                  </button>
                  {current && (can('links.edit') || can('projects.manage')) && (
                    <button onClick={() => { onProjectSettings(); setOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg">
                      <Settings className="w-3.5 h-3.5 text-slate-500" />Project settings & links
                    </button>
                  )}
                  {can('projects.manage') && (
                    <button onClick={() => { onCreateProject(); setOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs font-semibold text-sky-600 hover:bg-sky-50 rounded-lg">
                      <Plus className="w-3.5 h-3.5" />Create new project…
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* notifications + account, kept apart from project controls */}
          <div className="order-2 md:order-3 ml-auto flex items-center gap-1 sm:gap-2">
            <NotificationBell onOpenSettings={() => go('notifications')} />
            <span className="hidden md:block w-px h-7 bg-slate-200" aria-hidden="true" />
            <div className="relative" ref={uref}>
              <button type="button" onClick={() => setUserMenu(!userMenu)} aria-label={`Account menu for ${user.name}`} className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-slate-100">
                <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">{user.name.slice(0, 1).toUpperCase()}</div>
                <div className="hidden md:block text-left">
                  <div className="text-[13px] font-bold text-slate-900 leading-tight">{user.name}</div>
                  <div className="text-[11px] text-slate-500 leading-tight">{ROLE_LABELS[user.role]}</div>
                </div>
              </button>
              {userMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 z-50">
                  <div className="px-3 py-1.5 text-[11px] text-slate-500 border-b border-slate-100 truncate">{user.email}</div>
                  {can('users.manage') && (
                    <button onClick={() => { go('users'); setUserMenu(false); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Users className="w-3.5 h-3.5" />Users & access</button>
                  )}
                  <button onClick={() => { go('notifications'); setUserMenu(false); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Bell className="w-3.5 h-3.5" />Notifications</button>
                  {!isStandalone() && <button onClick={() => { onInstallApp(); setUserMenu(false); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><Download className="w-3.5 h-3.5" />Install app</button>}
                  <button onClick={() => { onChangePassword(); setUserMenu(false); }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"><KeyRound className="w-3.5 h-3.5" />Change password</button>
                  <button onClick={logout} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-rose-700 hover:bg-rose-50"><LogOut className="w-3.5 h-3.5" />Sign out</button>
                </div>
              )}
            </div>
            <button type="button" className="md:hidden w-11 h-11 flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100" onClick={() => setMobile(!mobile)} aria-label={mobile ? 'Close menu' : 'Open menu'} aria-expanded={mobile}>
              {mobile ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* main navigation: always below the project toolbar; scrolls sideways when it does not fit */}
      <div className="relative border-t border-slate-100">
        <nav ref={navRef} aria-label="Main" className={`${PAGE_CONTAINER} flex items-stretch h-11 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}>
          {tab('portfolio', 'All Projects', Layers, 'indigo')}
          <span className="w-px h-4 bg-slate-200 mx-1 self-center shrink-0" aria-hidden="true" />
          {nav.filter((n) => n.show).map((n) => tab(n.id, n.label, n.icon))}
        </nav>
        <div aria-hidden="true" className="xl:hidden pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white to-transparent" />
      </div>
      {mobile && (
        <nav aria-label="Main (menu)" className="md:hidden border-t border-slate-200 bg-white px-3 py-2 grid grid-cols-2 gap-1">
          {gridButton('portfolio', 'All Projects', Layers)}
          {nav.filter((n) => n.show).map((n) => gridButton(n.id, n.label, n.icon))}
        </nav>
      )}
    </header>
  );
}

/**
 * Project list inside the selector: active projects first, then archived ones under their own
 * heading, each clearly marked read-only. Only projects the server returned (and
 * projectsForSelector allowed) are passed in.
 */
export function ProjectMenuList({ projects, query, currentId, onSelect }: { projects: Project[]; query: string; currentId: string | null; onSelect: (id: string) => void }) {
  const groups = filterProjects(projects, query);
  const option = (p: Project) => {
    const sel = p.id === currentId;
    return (
      <button key={p.id} type="button" onClick={() => onSelect(p.id)} aria-current={sel ? 'true' : undefined}
        aria-label={`${projectLabel(p)}${p.archived_at ? ' (archived, read-only)' : ''}${sel ? ' (current project)' : ''}`}
        className={`w-full min-h-11 flex items-start justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50 ${sel ? 'bg-sky-50/80' : ''}`}>
        <span className="flex items-start gap-2.5 min-w-0">
          <Building2 className={`w-4 h-4 mt-0.5 shrink-0 ${p.archived_at ? 'text-slate-400' : sel ? 'text-sky-600' : 'text-slate-500'}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className={`block text-xs font-bold truncate ${p.archived_at ? 'text-slate-600' : 'text-slate-900'}`}>{projectLabel(p)}</span>
            <span className="block text-[11px] text-slate-500 truncate">{p.location}{p.status ? ` · ${p.status}` : ''}</span>
            {p.archived_at && <span className="inline-block mt-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">Archived · read-only</span>}
          </span>
        </span>
        {sel && <Check className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />}
      </button>
    );
  };
  const heading = (t: string) => <div role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{t}</div>;
  if (projects.length === 0) return <p className="px-3 py-2 text-xs text-slate-500">No projects assigned to you.</p>;
  if (groups.active.length + groups.archived.length === 0) return <p className="px-3 py-2 text-xs text-slate-500">No project matches “{query.trim()}”.</p>;
  return (
    <>
      {groups.archived.length > 0 && groups.active.length > 0 && heading('Active projects')}
      {groups.active.map(option)}
      {groups.archived.length > 0 && heading('Archived (read-only)')}
      {groups.archived.map(option)}
    </>
  );
}
