import type { Project } from './types';

/**
 * Projects offered in the header's project selector.
 * The server already decides visibility: archived projects are only returned to admins
 * (GET /api/projects?includeArchived=1), and other users only get projects they are assigned to.
 * On top of that, archived projects are listed only for users who manage projects; anyone else
 * keeps just the active list (plus the current project, so the selector never loses it).
 */
export function projectsForSelector(projects: Project[], canManageProjects: boolean, currentId?: string | null): Project[] {
  if (canManageProjects) return projects;
  return projects.filter((p) => !p.archived_at || p.id === currentId);
}
