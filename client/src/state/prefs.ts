import type { Id } from '@shared/types';

// Per-user UI preferences kept in a cookie on this device. The server never reads them:
// hiding a conversation only changes this user's sidebar, not membership.

const cookieName = (userId: Id) => `slacky-hidden-${userId}`;

export function loadHidden(userId: Id): Record<Id, true> {
  const pair = document.cookie.split('; ').find((c) => c.startsWith(`${cookieName(userId)}=`));
  try {
    const ids: Id[] = pair ? JSON.parse(decodeURIComponent(pair.split('=')[1])) : [];
    return Object.fromEntries(ids.map((id) => [id, true]));
  } catch {
    return {};
  }
}

export function saveHidden(userId: Id, hidden: Record<Id, true>) {
  const value = encodeURIComponent(JSON.stringify(Object.keys(hidden)));
  document.cookie = `${cookieName(userId)}=${value}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
}
