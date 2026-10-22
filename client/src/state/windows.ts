// Windows: the loaded slice of each open timeline (a channel's top-level messages, or one
// thread's replies), and the bounded cache of recent ones. Pure, so it's testable alone;
// store.ts applies these to state.
import type { Id, Message, MessagePage } from '@shared/types';

export const WINDOW_CAP = 300; // messages kept per window; the far end is trimmed past it
export const CACHE_SIZE = 10; // windows kept; older ones are dropped with their messages
const START_INDEX = 1_000_000; // the list index of a fresh window's first message: room to prepend

/** `c:<conversation id>` for a channel timeline, `t:<root id>` for a thread. */
export type TimelineKey = `c:${string}` | `t:${string}`;

export const convKey = (convId: Id): TimelineKey => `c:${convId}`;
export const threadKey = (rootId: Id): TimelineKey => `t:${rootId}`;

export interface Window {
  ids: Id[]; // one contiguous run of the timeline, oldest first
  hasBefore: boolean; // more exists above, not loaded
  hasAfter: boolean; // more exists below: the window isn't at the live edge
  firstIndex: number; // list index of ids[0]; moves by exactly what's prepended or trimmed at the top
  generation: number; // bumps when the window is replaced (a jump), so the list starts over
  missed: number; // new messages that arrived below while the window wasn't at the live edge
}

type SeqOf = (id: Id) => number;

/** A new window from one page, replacing whatever was there (e.g. a jump far away). */
export function replaceWindow(page: MessagePage, prev?: Window): Window {
  return {
    ids: page.messages.map((m) => m.id),
    hasBefore: page.hasBefore,
    hasAfter: page.hasAfter,
    firstIndex: START_INDEX,
    generation: (prev?.generation ?? 0) + 1,
    missed: 0,
  };
}

/** Adds an older (`before`) or newer (`after`) page, then trims the opposite end to the cap. */
export function extendWindow(w: Window, page: MessagePage, side: 'before' | 'after'): Window {
  const have = new Set(w.ids);
  const add = page.messages.map((m) => m.id).filter((id) => !have.has(id));
  if (side === 'before') return trim({ ...w, ids: [...add, ...w.ids], firstIndex: w.firstIndex - add.length, hasBefore: page.hasBefore }, 'end');
  return trim({ ...w, ids: [...w.ids, ...add], hasAfter: page.hasAfter, missed: page.hasAfter ? w.missed : 0 }, 'start');
}

function trim(w: Window, end: 'start' | 'end'): Window {
  const extra = w.ids.length - WINDOW_CAP;
  if (extra <= 0) return w;
  return end === 'end'
    ? { ...w, ids: w.ids.slice(0, WINDOW_CAP), hasAfter: true }
    : { ...w, ids: w.ids.slice(extra), firstIndex: w.firstIndex + extra, hasBefore: true };
}

/**
 * Where a message seen live (or in a response) goes. Inside the window it's kept in seq
 * order; below a window that isn't at the live edge it only counts as missed; above a
 * window with unloaded history it's left out. `visible: false` removes it.
 */
export function placeMessage(w: Window, m: Message, visible: boolean, seqOf: SeqOf): Window {
  const present = w.ids.includes(m.id);
  if (!visible) return present ? { ...w, ids: w.ids.filter((id) => id !== m.id) } : w;
  if (present) return w;
  const first = w.ids.length ? seqOf(w.ids[0]) : null;
  const last = w.ids.length ? seqOf(w.ids[w.ids.length - 1]) : null;
  if (last === null || m.seq > last) {
    if (w.hasAfter) return { ...w, missed: w.missed + 1 };
    return trim({ ...w, ids: [...w.ids, m.id] }, 'start');
  }
  if (m.seq < first! && w.hasBefore) return w;
  const at = w.ids.findIndex((id) => seqOf(id) > m.seq);
  const ids = [...w.ids.slice(0, at), m.id, ...w.ids.slice(at)];
  return trim({ ...w, ids, firstIndex: at === 0 ? w.firstIndex - 1 : w.firstIndex }, 'start');
}

/** Moves `key` to the front of the cache; returns the new order and the keys that fell out. */
export function touch(lru: TimelineKey[], key: TimelineKey, size = CACHE_SIZE): { lru: TimelineKey[]; evicted: TimelineKey[] } {
  const next = [key, ...lru.filter((k) => k !== key)];
  return { lru: next.slice(0, size), evicted: next.slice(size) };
}

/** Messages no window references (a thread window also references its root), minus `keep`. */
export function unreferenced(messages: Record<Id, Message>, windows: Partial<Record<TimelineKey, Window>>, keep: Iterable<Id> = []): Id[] {
  const used = new Set<Id>(keep);
  for (const [key, w] of Object.entries(windows) as [TimelineKey, Window | undefined][]) {
    if (!w) continue;
    for (const id of w.ids) used.add(id);
    if (key.startsWith('t:')) used.add(key.slice(2));
  }
  return Object.keys(messages).filter((id) => !used.has(id));
}
