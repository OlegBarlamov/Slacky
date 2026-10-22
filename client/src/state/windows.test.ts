import { describe, expect, it } from 'vitest';
import type { Message, MessagePage } from '@shared/types';
import { CACHE_SIZE, extendWindow, placeMessage, replaceWindow, touch, unreferenced, WINDOW_CAP, type TimelineKey, type Window } from './windows';

const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  clientMsgId: `c${seq}`,
  convId: 'c1',
  seq,
  authorId: 'u1',
  text: `message ${seq}`,
  mentions: [],
  threadRootId: null,
  thread: null,
  version: 1,
  createdAt: seq,
  editedAt: null,
  deletedAt: null,
  ...extra,
});
const page = (from: number, to: number, hasBefore: boolean, hasAfter: boolean): MessagePage => ({
  messages: Array.from({ length: to - from + 1 }, (_, i) => msg(from + i)),
  hasBefore,
  hasAfter,
});
const seqOf = (id: string) => Number(id.slice(1));
const seqs = (w: Window) => w.ids.map(seqOf);

describe('window', () => {
  it('prepends older pages, moving the first index by what was added', () => {
    const w = extendWindow(replaceWindow(page(51, 100, true, false)), page(1, 50, false, true), 'before');
    expect(seqs(w)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect([w.hasBefore, w.hasAfter]).toEqual([false, false]);
    expect(w.firstIndex).toBe(replaceWindow(page(1, 1, false, false)).firstIndex - 50);
  });

  it('stays bounded while scrolling, and remembers what it trimmed', () => {
    let w = replaceWindow(page(1001, 1050, true, false));
    for (let top = 1001; top > 1; top -= 50) w = extendWindow(w, page(top - 50, top - 1, top - 50 > 1, true), 'before');
    expect(w.ids).toHaveLength(WINDOW_CAP);
    expect(seqs(w)[0]).toBe(1);
    expect(w.hasAfter).toBe(true); // the newest were trimmed

    const first = w.firstIndex;
    w = extendWindow(w, page(301, 350, true, true), 'after');
    expect(w.ids).toHaveLength(WINDOW_CAP);
    expect(seqs(w)[0]).toBe(51);
    expect(w.firstIndex).toBe(first + 50);
    expect(w.hasBefore).toBe(true);
  });

  it('appends live messages only at the live edge', () => {
    let w = replaceWindow(page(1, 10, false, false));
    w = placeMessage(w, msg(11), true, seqOf);
    expect(seqs(w).at(-1)).toBe(11);

    let scrolledUp = replaceWindow(page(1, 10, false, true));
    scrolledUp = placeMessage(scrolledUp, msg(500), true, seqOf);
    scrolledUp = placeMessage(scrolledUp, msg(501), true, seqOf);
    expect(seqs(scrolledUp)).toEqual(seqs(replaceWindow(page(1, 10, false, true))));
    expect(scrolledUp.missed).toBe(2);
    expect(extendWindow(scrolledUp, page(11, 501, true, false), 'after').missed).toBe(0);
  });

  it('removes deleted messages and ignores what lies above unloaded history', () => {
    let w = replaceWindow(page(50, 60, true, false));
    w = placeMessage(w, msg(55, { deletedAt: 1 }), false, seqOf);
    expect(seqs(w)).not.toContain(55);
    expect(placeMessage(w, msg(3), true, seqOf)).toBe(w);
    w = placeMessage(w, msg(55, { version: 3 }), true, seqOf); // e.g. an older copy arriving late
    expect(seqs(w)).toContain(55);
  });
});

describe('cache', () => {
  it('stays bounded after opening 20 channels, keeping the most recent', () => {
    let lru: TimelineKey[] = [];
    const evicted: TimelineKey[] = [];
    for (let i = 0; i < 20; i++) {
      const r = touch(lru, `c:${i}`);
      lru = r.lru;
      evicted.push(...r.evicted);
    }
    expect(lru).toHaveLength(CACHE_SIZE);
    expect(lru[0]).toBe('c:19');
    expect(evicted).toEqual(Array.from({ length: 10 }, (_, i) => `c:${i}`));
    expect(touch(lru, 'c:12').lru[0]).toBe('c:12');
  });

  it('collects messages no window references, keeping thread roots', () => {
    const messages = Object.fromEntries([1, 2, 3, 4].map((s) => [`m${s}`, msg(s)]));
    const windows = { 'c:c1': replaceWindow(page(1, 2, false, false)), 't:m4': replaceWindow({ messages: [], hasBefore: false, hasAfter: false }) };
    expect(unreferenced(messages, windows)).toEqual(['m3']);
    expect(unreferenced(messages, windows, ['m3'])).toEqual([]);
  });
});
