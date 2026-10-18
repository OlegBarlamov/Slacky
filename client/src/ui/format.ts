import type { Conversation, Id, User } from '@shared/types';

export function conversationName(c: Conversation | undefined, users: Record<Id, User>, meId: Id | undefined) {
  if (!c) return 'unknown';
  if (c.kind === 'channel') return `#${c.name}`;
  const other = c.memberIds.find((id) => id !== meId);
  return other ? (users[other]?.name ?? 'unknown') : `${users[meId!]?.name ?? 'me'} (you)`;
}

export const userName = (users: Record<Id, User>, id: Id) => users[id]?.name ?? 'unknown';

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function fmtDay(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function listNames(names: string[], max = 2) {
  if (names.length <= max) return names.join(' and ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} other${names.length - max > 1 ? 's' : ''}`;
}
