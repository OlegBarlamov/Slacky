import type { Id } from '@shared/types';

// Remembered scroll positions, in sessionStorage so they survive a reload of this tab.
//  - per history entry: Back/Forward return exactly where that entry was
//  - per conversation: reopening a channel from the sidebar returns to where you left it
// A position is "this message, this many px from the top", not raw scrollTop, so it stays
// right when messages arrive or a page of older history is loaded.

export type ScrollPos = { atBottom: true } | { atBottom: false; anchorId: Id; offset: number };

const KEY = 'slacky-scroll';
type Saved = { entries: Record<string, ScrollPos>; convs: Record<Id, ScrollPos> };

const saved: Saved = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '') as Saved;
  } catch {
    return { entries: {}, convs: {} };
  }
})();

let timer: ReturnType<typeof setTimeout> | undefined;

export function saveScroll(convId: Id, entryKey: string, pos: ScrollPos) {
  saved.entries[`${entryKey}:${convId}`] = pos;
  saved.convs[convId] = pos;
  clearTimeout(timer);
  timer = setTimeout(() => sessionStorage.setItem(KEY, JSON.stringify(saved)), 300);
}

export const entryScroll = (convId: Id, entryKey: string): ScrollPos | undefined => saved.entries[`${entryKey}:${convId}`];
export const conversationScroll = (convId: Id): ScrollPos | undefined => saved.convs[convId];
