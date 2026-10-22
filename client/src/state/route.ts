import { useSyncExternalStore } from 'react';
import type { Id } from '@shared/types';

export type ActivityFilter = 'all' | 'mentions' | 'threads';

export type Route =
  | { name: 'conv'; convId: Id; threadId: Id | null; msgId: Id | null }
  | { name: 'activity'; filter: ActivityFilter; unreadOnly: boolean }
  | { name: 'threads'; unreadOnly: boolean }
  | { name: 'search'; q: string }
  | { name: 'home' };

const FILTERS: ActivityFilter[] = ['all', 'mentions', 'threads'];

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const [section, id, sub, subId] = path.split('/').filter(Boolean);
  if (section === 'c' && id) return { name: 'conv', convId: id, threadId: sub === 't' ? (subId ?? null) : null, msgId: params.get('m') };
  if (section === 'activity') {
    const f = params.get('f') as ActivityFilter;
    return { name: 'activity', filter: FILTERS.includes(f) ? f : 'all', unreadOnly: params.get('unread') === '1' };
  }
  if (section === 'threads') return { name: 'threads', unreadOnly: params.get('unread') === '1' };
  if (section === 'search') return { name: 'search', q: params.get('q') ?? '' };
  return { name: 'home' };
}

// In-app history: every entry is stamped with its position (so we know whether Back and
// Forward have somewhere to go) and a unique key (so per-entry state like scroll position
// never leaks into a new entry that reuses the same position). Plain hash links get
// stamped when they land.
const newKey = () => Math.random().toString(36).slice(2, 10);
let index: number = history.state?.idx ?? 0;
let maxIndex = index;
let entryKey: string = history.state?.key ?? newKey();
if (history.state?.key === undefined) history.replaceState({ idx: index, key: entryKey }, '');

const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

addEventListener('hashchange', () => {
  const idx = history.state?.idx;
  if (idx === undefined) {
    index += 1; // a new entry: anything "forward" is gone
    maxIndex = index;
    entryKey = newKey();
    history.replaceState({ idx: index, key: entryKey }, '');
  } else {
    index = idx; // back / forward
    entryKey = history.state.key;
  }
  notify();
});

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const useRoute = () => {
  useSyncExternalStore(subscribe, () => version);
  return parseRoute(location.hash);
};

export const useHistoryNav = () => {
  useSyncExternalStore(subscribe, () => version);
  return { canGoBack: index > 0, canGoForward: index < maxIndex, entryKey };
};

export const href = {
  conv: (convId: Id, threadId?: Id | null, msgId?: Id | null) =>
    `#/c/${convId}${threadId ? `/t/${threadId}` : ''}${msgId ? `?m=${msgId}` : ''}`,
  activity: (filter: ActivityFilter = 'all', unreadOnly = false) => {
    const params = new URLSearchParams({ ...(filter !== 'all' && { f: filter }), ...(unreadOnly && { unread: '1' }) }).toString();
    return `#/activity${params ? `?${params}` : ''}`;
  },
  threads: (unreadOnly = false) => `#/threads${unreadOnly ? '?unread=1' : ''}`,
  search: (q: string) => `#/search?q=${encodeURIComponent(q)}`,
};

export const navigate = (hash: string) => {
  location.hash = hash;
};

/** Changes the route without adding a history entry (redirects, filter tweaks). */
export function replaceRoute(hash: string) {
  history.replaceState({ idx: index, key: entryKey }, '', hash);
  notify();
}
