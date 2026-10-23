import { createContext, useContext } from 'react';
import type { FetchLike, User } from './api.js';

export type Session = { user: User; fetchImpl: FetchLike; signOut: () => Promise<void> };

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionContext');
  return session;
}
