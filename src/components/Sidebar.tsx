import React, { useCallback, useRef, useState } from 'react';
import { Building2, ChevronDown, ExternalLink, FolderOpen, FolderPlus, FolderX, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Project, Section } from '../lib/types';
import { useSession } from '../lib/session';
import { NotificationBell } from './NotificationBell';
import { mainNav, PORTFOLIO_NAV, ProjectPopover, projectLabel, SECTION_TITLES, useDismiss, UserMenu } from './Header';

/**
 * Desktop navigation (wide windows only — see DESKTOP_LAYOUT_QUERY): a persistent left sidebar with the logo,
 * project selector, the project's Drive shortcut and the modules in their usual order and role visibility.
 * Collapsed, it shows icons with tooltips; project switching stays available from the project icon.
 */
interface SidebarProps {
  section: Section;
  onNavigate: (s: Section) => void;
  projects: Project[];
  current: Project | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onProjectSettings: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

type Tip = { label: string; top: number; left: number } | null;

export function Sidebar({ section, onNavigate, projects, current, onSelectProject, onCreateProject, onProjectSettings, collapsed, onToggleCollapsed }: SidebarProps) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState<Tip>(null);
  const pref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(pref, open, close);
  const nav = mainNav(can).filter((n) => n.show);

  // collapsed: a tooltip beside the icon (fixed, so the scrolling menu never clips it); Escape hides it
  const tipProps = (label: string) => collapsed ? {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showTip(e.currentTarget, label),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showTip(e.currentTarget, label),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') setTip(null); },
  } : {};
  const showTip = (el: HTMLElement, label: string) => {
    if (open) return;
    const r = el.getBoundingClientRect();
    const edge = el.closest('aside')?.getBoundingClientRect().right ?? r.right;
    setTip({ label, top: r.top + r.height / 2, left: edge + 8 });
  };

  const item = (id: Section, label: string, Icon: React.FC<{ className?: string }>, tone: 'sky' | 'indigo' = 'sky') => {
    const active = section === id;
    const on = tone === 'indigo' ? 'bg-indigo-50 text-indigo-700' : 'bg-sky-50 text-sky-700';
    const bar = tone === 'indigo' ? 'bg-indigo-600' : 'bg-sky-600';
    const icon = active ? (tone === 'indigo' ? 'text-indigo-600' : 'text-sky-600') : 'text-slate-400 group-hover:text-slate-600';
    return (
      <li key={id}>
        <button type="button" onClick={() => onNavigate(id)} aria-current={active ? 'page' : undefined} aria-label={collapsed ? label : undefined}
          {...tipProps(label)}
          className={`group relative w-full flex items-center gap-3 min-h-10 rounded-lg text-[13px] text-left motion-safe:transition-colors ${collapsed ? 'justify-center px-0' : 'px-3'} ${
            active ? `${on} font-semibold` : 'font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
          {active && <span aria-hidden="true" className={`absolute left-0 top-2 bottom-2 w-1 rounded-r ${bar}`} />}
          <Icon className={`w-[18px] h-[18px] shrink-0 ${icon}`} />
          {!collapsed && <span className="truncate">{label}</span>}
        </button>
      </li>
    );
  };

  // Drive shortcut for the selected project: open (linked), add (editors) or a disabled note (others)
  const drive = current?.drive_folder_url ?? '';
  const driveBase = `flex items-center gap-2 min-h-10 rounded-lg text-xs font-semibold ${collapsed ? 'justify-center w-11 mx-auto' : 'px-3 w-full'}`;
  const driveShortcut = current && (drive ? (
    <a href={drive} target="_blank" rel="noopener noreferrer" title={collapsed ? undefined : `Open the Google Drive folder for ${projectLabel(current)} (new tab)`}
      aria-label={collapsed ? `Open Drive folder for ${projectLabel(current)} (new tab)` : undefined} {...tipProps('Open Drive folder')}
      className={`${driveBase} text-sky-700 hover:bg-sky-50`}>
      <FolderOpen className="w-4 h-4 text-sky-600 shrink-0" />{!collapsed && <><span className="truncate">Open Drive folder</span><ExternalLink className="ml-auto w-3 h-3 text-slate-400 shrink-0" /></>}
    </a>
  ) : can('links.edit') ? (
    <button type="button" onClick={onProjectSettings} title={collapsed ? undefined : 'No Drive folder linked — add the link in project settings'}
      aria-label={collapsed ? 'Add Drive folder' : undefined} {...tipProps('Add Drive folder')}
      className={`${driveBase} text-slate-600 hover:bg-slate-100`}>
      <FolderPlus className="w-4 h-4 text-slate-500 shrink-0" />{!collapsed && <span className="truncate">Add Drive folder</span>}
    </button>
  ) : (
    <span role="note" aria-disabled="true" tabIndex={collapsed ? 0 : undefined} title={collapsed ? undefined : 'No Drive folder linked yet — ask an admin or project manager to add it'}
      aria-label={collapsed ? 'Drive not linked' : undefined} {...tipProps('Drive not linked')}
      className={`${driveBase} text-slate-500 cursor-not-allowed`}>
      <FolderX className="w-4 h-4 text-slate-400 shrink-0" />{!collapsed && <span className="truncate">Drive not linked</span>}
    </span>
  ));

  const projectName = current ? projectLabel(current) : 'Select project';
  return (
    <aside id="app-sidebar" aria-label="Sidebar"
      className={`sticky top-0 h-screen shrink-0 z-40 flex flex-col bg-white border-r border-slate-200 motion-safe:transition-[width] motion-safe:duration-200 ${collapsed ? 'w-[4.5rem]' : 'w-64'}`}>
      {/* brand */}
      <div className={`h-16 shrink-0 flex items-center border-b border-slate-100 ${collapsed ? 'justify-center' : 'px-4'}`}>
        <button type="button" onClick={() => onNavigate('portfolio')} title="Qonnect — all projects" aria-label="Qonnect — all projects" className="flex items-center gap-2 rounded-lg hover:opacity-90">
          <img src="/qonnect-logo.png" alt="" width={36} height={36} className="w-9 h-9 object-contain" />
          {!collapsed && <span className="text-base font-bold tracking-tight text-slate-900">Qonnect</span>}
        </button>
      </div>

      {/* project selector + Drive shortcut (outside the scrolling menu so the switcher is never clipped) */}
      <div className="shrink-0 relative px-3 pt-3 pb-2 border-b border-slate-100 space-y-1" ref={pref}>
        <div role="group" aria-label="Project">
          {collapsed ? (
            <button type="button" onClick={() => { setTip(null); setOpen(!open); }} aria-expanded={open} aria-haspopup="true"
              aria-label={current ? `Switch project. Current: ${current.name}, ${current.code}` : 'Select project'} {...tipProps(projectName)}
              className={`w-11 h-11 mx-auto flex items-center justify-center rounded-xl border ${open ? 'bg-sky-100 border-sky-200' : 'bg-sky-50 border-sky-100 hover:bg-sky-100'} text-sky-600`}>
              <Building2 className="w-5 h-5" />
            </button>
          ) : (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true"
              aria-label={current ? `Switch project. Current: ${current.name}, ${current.code}` : 'Select project'}
              className="w-full flex items-center gap-2.5 p-1.5 pr-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-left shadow-2xs">
              <span className="w-8 h-8 shrink-0 rounded-lg bg-sky-50 border border-sky-100 text-sky-600 flex items-center justify-center"><Building2 className="w-4 h-4" /></span>
              <span className="min-w-0 flex-1 flex flex-col">
                {current ? (
                  <>
                    <span className="text-[13px] font-bold text-slate-900 leading-tight truncate">{current.name}</span>
                    <span className="text-[11px] font-mono font-semibold text-sky-700 tracking-wide leading-tight truncate">{current.code}</span>
                    {current.archived_at && <span className="mt-0.5 self-start text-[10px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">Archived · read-only</span>}
                  </>
                ) : <span className="text-sm font-semibold text-slate-600">Select project</span>}
              </span>
              <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
        {driveShortcut}
        {open && (
          <ProjectPopover className={collapsed ? 'absolute left-full top-3 ml-2' : 'absolute left-3 top-full mt-1'} projects={projects} current={current}
            onSelect={(id) => { onSelectProject(id); setOpen(false); }} onPortfolio={() => { onNavigate('portfolio'); setOpen(false); }}
            onSettings={() => { onProjectSettings(); setOpen(false); }} onCreate={() => { onCreateProject(); setOpen(false); }} />
        )}
      </div>

      {/* modules: scrolls on its own on short windows */}
      <nav aria-label="Main" className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3" onScroll={() => setTip(null)}>
        <ul className="space-y-0.5">
          {item(PORTFOLIO_NAV.id, PORTFOLIO_NAV.label, PORTFOLIO_NAV.icon, 'indigo')}
          <li aria-hidden="true" className="my-2 h-px bg-slate-100" />
          {nav.map((n) => item(n.id, n.label, n.icon))}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-slate-100 p-3">
        <button type="button" onClick={() => { setTip(null); onToggleCollapsed(); }} aria-controls="app-sidebar" aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} {...tipProps('Expand sidebar')}
          className={`flex items-center gap-3 min-h-10 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800 ${collapsed ? 'w-11 mx-auto justify-center' : 'w-full px-3'}`}>
          {collapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <><PanelLeftClose className="w-[18px] h-[18px]" /><span>Collapse</span></>}
        </button>
      </div>

      {collapsed && tip && (
        <div role="tooltip" className="fixed z-[60] -translate-y-1/2 pointer-events-none whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white shadow-lg"
          style={{ top: tip.top, left: tip.left }}>{tip.label}</div>
      )}
    </aside>
  );
}

/** Compact desktop top bar: page title (and project), notifications and the account menu. */
export function TopBar({ section, current, onNavigate, onChangePassword, onInstallApp, onProfilePicture }: {
  section: Section; current: Project | null; onNavigate: (s: Section) => void; onChangePassword: () => void; onInstallApp: () => void; onProfilePicture: () => void;
}) {
  const projectScoped = !['portfolio', 'users', 'notifications', 'backup'].includes(section);
  return (
    <div className="sticky top-0 z-30 h-14 shrink-0 bg-white/95 backdrop-blur-md border-b border-slate-200/80 shadow-2xs">
      <div className="h-full flex items-center gap-3 px-5 xl:px-8 2xl:px-10">
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="text-base font-bold text-slate-900 truncate" data-testid="page-title">{SECTION_TITLES[section]}</span>
          {projectScoped && current && <span className="hidden xl:inline text-xs text-slate-500 truncate">{current.name} · <span className="font-mono font-semibold text-sky-700">{current.code}</span></span>}
        </div>
        <NotificationBell onOpenSettings={() => onNavigate('notifications')} />
        <span className="w-px h-7 bg-slate-200" aria-hidden="true" />
        <UserMenu onNavigate={onNavigate} onChangePassword={onChangePassword} onInstallApp={onInstallApp} onProfilePicture={onProfilePicture} />
      </div>
    </div>
  );
}
