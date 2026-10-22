import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type IndexLocationWithAlign, type ListItem, type VirtuosoHandle } from 'react-virtuoso';
import type { Id } from '@shared/types';
import type { ScrollPos } from '../state/scroll';
import { loadMore, openWindow, refreshWindow, setFollowing, useStore, type Pending } from '../state/store';
import type { TimelineKey } from '../state/windows';
import { fmtDay } from './format';
import { Divider, MessageItem, PendingItem, sameGroup } from './MessageItem';

// Defined once, not per render, so Virtuoso doesn't remount them; content comes through `context`.
type Context = { header: ReactNode; footer: ReactNode };
const Header = ({ context }: { context: Context }) => <div className="pt-3">{context.header}</div>;
const Footer = ({ context }: { context: Context }) => <div className="pb-3">{context.footer}</div>;

interface Props {
  tkey: TimelineKey;
  inThread: boolean;
  /** A message to jump to and highlight; loads a window around it if it isn't in this one. */
  target: Id | null;
  /** Read up to this seq when opened: the "New" divider goes above the next message by someone else. */
  readMark: number | null;
  /** Where the user last was (channels): restored when there's no target. */
  savedPos?: ScrollPos;
  /** Above the first message: `hasBefore` says whether older ones are still to load. */
  header: (hasBefore: boolean) => ReactNode;
  pending: Pending[];
  onReadUpTo: (seq: number) => void;
  onPosition?: (pos: ScrollPos) => void;
}

/**
 * One timeline window, virtualized: only what's on screen is in the DOM. Scrolling near the
 * top or bottom loads the next page; live messages append only at the live edge.
 */
export function MessageList({ tkey, inThread, target, readMark, savedPos, header, pending, onReadUpTo, onPosition }: Props) {
  const w = useStore((s) => s.windows[tkey]);
  const messages = useStore((s) => s.messages);
  const me = useStore((s) => s.me)!;
  const list = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlighted, setHighlighted] = useState<Id | null>(null);
  const rendered = useRef<ListItem<Id>[]>([]);
  const jumpedTo = useRef<Id | null>(null);
  const startedAt = useRef<Id | null>(null); // the target a fresh list opened centered on

  // Open: around the target, else a cached window as it was (caught up), else around where
  // the user last was, else at the first unread.
  useEffect(() => {
    const cur = useStore.getState().windows[tkey];
    if (target && !cur?.ids.includes(target)) void openWindow(tkey, { around: target });
    else if (cur) refreshWindow(tkey);
    else void openWindow(tkey, savedPos && !savedPos.atBottom ? { around: savedPos.anchorId } : { firstUnread: true });
  }, [tkey, target]);

  const ids = w?.ids ?? [];
  const index = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
  const firstUnread = readMark === null ? undefined : ids.find((id) => messages[id].seq > readMark && messages[id].authorId !== me.id);

  // Where a fresh list (first load or a jump) starts. Computed once per window generation.
  const initial = useMemo((): IndexLocationWithAlign | undefined => {
    startedAt.current = null;
    if (!w) return undefined;
    if (target && index.has(target)) {
      startedAt.current = target;
      return { index: index.get(target)!, align: 'center' };
    }
    if (savedPos && !savedPos.atBottom && index.has(savedPos.anchorId)) return { index: index.get(savedPos.anchorId)!, align: 'start', offset: -savedPos.offset };
    if (firstUnread) return { index: index.get(firstUnread)!, align: 'start', offset: -48 };
    return { index: Math.max(0, ids.length - 1), align: 'end' };
  }, [w?.generation, !!w]);

  // Highlight the target once it's on screen: right away in a fresh list, by scrolling otherwise.
  useEffect(() => {
    if (!target || !index.has(target) || jumpedTo.current === target) return;
    if (startedAt.current !== target) list.current?.scrollToIndex({ index: index.get(target)!, align: 'center' });
    jumpedTo.current = target;
    setHighlighted(target);
    const t = setTimeout(() => setHighlighted(null), 2000);
    return () => clearTimeout(t);
  }, [target, index]);
  useEffect(() => {
    if (!target) jumpedTo.current = null;
  }, [target]);

  // Reading: up to the newest message actually on screen, while the tab is visible.
  function onRendered(items: ListItem<Id>[] | null) {
    if (items) rendered.current = items;
    if (document.visibilityState !== 'visible') return;
    const seqs = rendered.current.flatMap((x) => (x.data && messages[x.data] ? [messages[x.data].seq] : []));
    if (seqs.length) onReadUpTo(Math.max(...seqs));
  }
  useEffect(() => {
    const onVisible = () => onRendered(null);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });
  // An empty, complete timeline has nothing to scroll into view: it's read as is.
  useEffect(() => {
    if (w && !ids.length && !w.hasAfter && document.visibilityState === 'visible') onReadUpTo(0);
  }, [w, ids.length]);

  // Sitting at the live bottom: new messages are read as they arrive.
  const live = atBottom && !!w && !w.hasAfter;
  useEffect(() => {
    setFollowing(live ? tkey : null);
    return () => {
      if (useStore.getState().following === tkey) setFollowing(null);
    };
  }, [live, tkey]);

  // My own sends show below the list; keep them in view at the bottom.
  useEffect(() => {
    if (live && pending.length) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [pending.length]);

  /** Remembers the first visible message and its offset (or "at the bottom"). */
  const remember = useRef(() => {});
  remember.current = () => {
    const el = scroller.current;
    if (!el || !onPosition || !w) return;
    if (live && el.scrollHeight - el.scrollTop - el.clientHeight < 80) return onPosition({ atBottom: true });
    const top = el.getBoundingClientRect().top;
    const first = [...el.querySelectorAll<HTMLElement>('[data-msg]')].find((x) => x.getBoundingClientRect().bottom > top);
    if (first) onPosition({ atBottom: false, anchorId: first.dataset.msg!, offset: first.getBoundingClientRect().top - top });
  };
  const onScroll = useCallback(() => remember.current(), []);
  const scrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      scroller.current?.removeEventListener('scroll', onScroll);
      scroller.current = el instanceof HTMLElement ? el : null;
      scroller.current?.addEventListener('scroll', onScroll, { passive: true });
    },
    [onScroll],
  );

  function jumpToLatest() {
    if (w?.hasAfter) void openWindow(tkey, { latest: true });
    else list.current?.scrollToIndex({ index: ids.length - 1, align: 'end', behavior: 'smooth' });
  }

  if (!w) return <p className="flex-1 px-5 py-3 text-gray-400">Loading…</p>;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Virtuoso
        key={w.generation}
        ref={list}
        className="flex-1"
        scrollerRef={scrollerRef}
        data={ids}
        firstItemIndex={w.firstIndex}
        initialTopMostItemIndex={initial}
        computeItemKey={(_, id) => id}
        startReached={() => void loadMore(tkey, 'before')}
        endReached={() => void loadMore(tkey, 'after')}
        followOutput={(bottom) => (bottom && !w.hasAfter ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={40}
        itemsRendered={onRendered}
        components={{ Header, Footer }}
        context={{
          header: header(w.hasBefore),
          footer: w.hasAfter ? (
            <p className="px-5 py-2 text-center text-sm text-gray-400">Loading newer messages…</p>
          ) : (
            pending.map((p, i) => (
              <PendingItem key={p.clientMsgId} p={p} showHeader={i === 0 && !sameGroup(messages[ids[ids.length - 1]], { authorId: me.id, createdAt: p.createdAt })} />
            ))
          ),
        }}
        itemContent={(_, id) => {
          const m = messages[id];
          const i = index.get(id)!;
          const prev = i > 0 ? messages[ids[i - 1]] : undefined;
          const newDay = !prev || fmtDay(prev.createdAt) !== fmtDay(m.createdAt);
          const isFirstUnread = id === firstUnread;
          return (
            <div data-msg={id}>
              {newDay && <Divider label={fmtDay(m.createdAt)} />}
              {isFirstUnread && <Divider label="New" red />}
              <MessageItem m={m} showHeader={newDay || isFirstUnread || !sameGroup(prev, m)} highlighted={highlighted === id} inThread={inThread} />
            </div>
          );
        }}
      />
      {(w.missed > 0 || !atBottom || w.hasAfter) && (
        <button
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-sky-700 px-4 py-1.5 text-sm font-semibold text-white shadow-lg hover:bg-sky-800"
          onClick={jumpToLatest}
        >
          {w.missed > 0 ? `${w.missed} new message${w.missed === 1 ? '' : 's'} ↓` : '↓ Jump to latest'}
        </button>
      )}
    </div>
  );
}
