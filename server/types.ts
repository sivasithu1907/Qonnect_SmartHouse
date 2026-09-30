import type { Role } from '../shared/constants';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}
export interface ProjectRow {
  id: string;
  code: string;
  name: string;
  location: string;
  archived_at: string | null;
  [k: string]: unknown;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
      csrfToken?: string;
      project?: ProjectRow;
    }
  }
}
