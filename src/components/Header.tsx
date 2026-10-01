import React, { useEffect, useRef, useState } from 'react';
import { PAGE_CONTAINER } from '../lib/layout';
import {
  Building2, CalendarDays, Check, ChevronDown, Coins, CreditCard, FolderOpen, History, Layers, LayoutDashboard, LogOut,
  MapPin, Menu, Plus, Settings, Truck, UserCheck, Users, X, KeyRound, Bell, Download,
} from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { isStandalone } from '../lib/pwa';
import type { Project, Section } from '../lib/types';
import { useSession } from '../lib/session';
import { ROLE_LABELS } from '../../shared/constants';

export const projectLabel = (p: Pick<Project, 'name' | 'code'>) => `${p.name} — ${p.code}`;

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
  const ref = useRef<HTMLDivElement>(null);
  const uref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
      if (uref.current && !uref.current.contains(e.target as Node)) setUserMenu(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const nav: Array<{ id: Section; label: string; icon: React.FC<{ className?: string }>; show: boolean }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, show: true },
    { id: 'budget', label: 'Master Items & Budget', icon: Coins, show: can('budget.read') },
    { id: 'payments', label: 'Payments', icon: CreditCard, show: can('payments.read') },
    { id: 'materials', label: 'Material Supply', icon: Truck, show: can('materials.read') },
    { id: 'consultant', label: 'Consultant Visits', icon: UserCheck, show: can('consultant.read') },
    { id: 'site', label: 'Site Visits', icon: MapPin, show: can('site.read') },
    { id: 'timeline', label: 'Timeline', icon: CalendarDays, show: can('timeline.read') },
    { id: 'audit', label: 'Audit', icon: History, show: can('audit.read') },
  ];
  const go = (s: Section) => { onNavigate(s); setMobile(false); };
  const drive = current?.drive_folder_url ?? '';

  const ACTIVE = {
    sky: { btn: 'bg-sky-50 text-sky-700 font-semibold shadow-2xs', icon: 'text-sky-600' },
    indigo: { btn: 'bg-indigo-50 text-indigo-700 font-semibold shadow-2xs', icon: 'text-indigo-600' },
  };
  const navButton = (id: Section, label: string, Icon: React.FC<{ className?: string }>, activeTone: 'sky' | 'indigo' = 'sky') => {
    const active = section === id;
    return (
      <button key={id} onClick={() => go(id)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
          active ? ACTIVE[activeTone].btn : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'}`}>
        <Icon className={`w-3.5 h-3.5 ${active ? ACTIVE[activeTone].icon : 'text-slate-400'}`} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80 shadow-2xs">
      <div className={PAGE_CONTAINER}>
        <div className="flex items-center justify-between h-16 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => go('portfolio')} title="Qonnect — all projects" className="flex items-center gap-2 shrink-0 rounded-lg hover:opacity-90">
              <img src="/qonnect-logo.png" alt="Qonnect" width={36} height={36} className="w-9 h-9 object-contain" />
              <span className="hidden lg:block text-base font-bold tracking-tight text-slate-900">Qonnect</span>
            </button>

            {/* Drive button — opens the selected project's Drive folder */}
            {current && (drive ? (
              <a href={drive} target="_blank" rel="noopener noreferrer" title={`Open Google Drive folder for ${projectLabel(current)}`}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 shrink-0">
                <FolderOpen className="w-3.5 h-3.5" /><span>Drive</span>
              </a>
            ) : (
              <button type="button" onClick={can('links.edit') ? onProjectSettings : undefined} title={can('links.edit') ? 'Drive folder not set — click to add the link' : 'Drive folder link not set'}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-dashed border-slate-300 text-slate-400 shrink-0">
                <FolderOpen className="w-3.5 h-3.5" /><span>Drive</span>
              </button>
            ))}

            {/* Project selector: name/location + code always shown together */}
            <div className="relative min-w-0" ref={ref}>
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
                className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-100/90 hover:bg-slate-200/80 border border-slate-200 rounded-xl text-left min-w-0">
                <Building2 className="w-4 h-4 text-sky-600 shrink-0" />
                <div className="min-w-0">
                  {current ? (
                    <>
                      <div className="text-xs sm:text-sm font-bold text-slate-900 leading-tight truncate">{current.name}</div>
                      <div className="text-[10px] sm:text-[11px] font-mono font-semibold text-sky-700 leading-tight">{current.code}{current.archived_at ? ' · archived' : ''}</div>
                    </>
                  ) : <span className="text-xs font-semibold text-slate-600">Select project</span>}
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className="absolute left-0 top-full mt-1.5 w-80 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-50">
                  <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">Switch project</div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {projects.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No projects assigned to you.</p>}
                    {projects.map((p) => {
                      const sel = p.id === current?.id;
                      return (
                        <button key={p.id} onClick={() => { onSelectProject(p.id); setOpen(false); }}
                          className={`w-full flex items-start justify-between px-3 py-2 text-left hover:bg-slate-50 ${sel ? 'bg-sky-50/80' : ''}`}>
                          <div className="flex items-start gap-2.5 min-w-0">
                            <Building2 className={`w-4 h-4 mt-0.5 shrink-0 ${sel ? 'text-sky-600' : 'text-slate-400'}`} />
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-slate-900 truncate">{projectLabel(p)}</div>
                              <div className="text-[11px] text-slate-500 truncate">{p.location}{p.status ? ` · ${p.status}` : ''}</div>
                              {p.archived_at && <div className="text-[10px] font-semibold text-rose-600">Archived</div>}
                            </div>
                          </div>
                          {sel && <Check className="w-4 h-4 text-sky-600 shrink-0" />}
                        </button>
                      );
                    })}
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
          </div>

          <div className="flex items-center gap-1">
            <NotificationBell onOpenSettings={() => go('notifications')} />
            <div className="relative" ref={uref}>
              <button onClick={() => setUserMenu(!userMenu)} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100">
                <div className="w-7 h-7 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">{user.name.slice(0, 1).toUpperCase()}</div>
                <div className="hidden md:block text-left">
                  <div className="text-xs font-semibold text-slate-800 leading-tight">{user.name}</div>
                  <div className="text-[10px] text-slate-500 leading-tight">{ROLE_LABELS[user.role]}</div>
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
            <button className="xl:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100" onClick={() => setMobile(!mobile)} aria-label="Menu">
              {mobile ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <nav className="hidden xl:flex items-center gap-0.5 pb-2 -mt-1 overflow-x-auto">
          {navButton('portfolio', 'All Projects', Layers, 'indigo')}
          <span className="w-px h-4 bg-slate-200 mx-1" />
          {nav.filter((n) => n.show).map((n) => navButton(n.id, n.label, n.icon))}
        </nav>
      </div>
      {mobile && (
        <nav className="xl:hidden border-t border-slate-200 bg-white px-4 py-2 grid grid-cols-2 gap-1">
          {navButton('portfolio', 'All Projects', Layers, 'indigo')}
          {nav.filter((n) => n.show).map((n) => navButton(n.id, n.label, n.icon))}
        </nav>
      )}
    </header>
  );
}
