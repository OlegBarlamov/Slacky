import { useEffect, useState } from 'react';
import type { Id, User } from '@shared/types';
import { searchUsers, useStore } from '../state/store';

/**
 * People whose name starts with `prefix` (null: not searching). Users already known answer
 * at once; the server's answer (members of `convId` first) replaces them shortly after.
 * Bootstrap only carries people in my conversations, so the server is what finds everyone.
 */
export function useUserSearch(prefix: string | null, convId: Id | null, limit = 8): User[] {
  const users = useStore((s) => s.users);
  const [found, setFound] = useState<{ prefix: string; users: User[] } | null>(null);

  useEffect(() => {
    if (prefix === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      searchUsers(prefix, convId, limit).then(
        (list) => alive && setFound({ prefix, users: list }),
        () => {}, // keep showing the known ones
      );
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [prefix, convId, limit]);

  if (prefix === null) return [];
  if (found?.prefix === prefix) return found.users;
  return Object.values(users)
    .filter((u) => u.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
