import { createContext, useContext } from 'react';
import type { User } from './types';

export interface Session {
  user: User;
  capabilities: string[];
  can: (cap: string) => boolean;
  logout: () => void;
  /** re-read the signed-in user (e.g. after a profile picture change) without signing out */
  refresh?: () => Promise<void>;
}
export const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionContext missing');
  return s;
}
