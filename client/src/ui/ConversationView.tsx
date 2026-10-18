import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Id } from '@shared/types';
import { useHistoryNav } from '../state/route';
import { conversationScroll, entryScroll, saveScroll, type ScrollPos } from '../state/scroll';
import { joinChannel, loadTimeline, markConversationRead, setViewing, useStore } from '../state/store';
import { Composer } from './Composer';
import { conversationName, fmtDay } from './format';
import { MessageItem, PendingItem, sameGroup } from './MessageItem';
import { useJumpTo } from './useJumpTo';

export function ConversationView({ convId, msgId, threadOpen }: { convId: Id; msgId: Id | null; threadOpen: boolean }) {
  const view = useStore((s) => s.convs[convId]);
  const joinable = useStore((s) => s.otherChannels.find((c) => c.id === convId));
  if (view) return <Timeline convId={convId} msgId={threadOpen ? null : msgId} />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-gray-500">
      {joinable ? (
        <>
          <p>
            You’re not a member of <b>#{joinable.name}</b>.
          </p>
          <button className="rounded-md bg-[#007a5a] px-4 py-2 font-semibold text-white" onClick={() => joinChannel(convId)}>
            Join channel
          </button>
        </>
      ) : (
        <p>This conversation doesn’t exist or you don’t have access.</p>
      )}
    </div>
  );
}

function Timeline({ convId, msgId }: { convId: Id; msgId: Id | null }) {
  const view = useStore((s) => s.convs[convId]);
  const tl = useStore((s) => s.timelines[convId]);
  const messages = useStore((s) => s.messages);
  const pending = useStore((s) => s.pending);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const unreadActivity = useStore((s) => Object.values(s.activity).some((i) => i.convId === convId && !i.threadRootId && !i.read));
  // Snapshot at open time, so the "New" divider doesn't vanish the moment we mark as read.
  const [readMark] = useState(() => view.lastReadSeq);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(false); // decided by the restore step below
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const { entryKey } = useHistoryNav();
  const loaded = !!tl;
  const ids = tl?.ids ?? [];
  // Coming back to an entry (Back/Forward) restores its position instead of re-jumping.
  const returning = !!entryScroll(convId, entryKey);
  const highlighted = useJumpTo(returning ? null : msgId, ids, tl?.hasMore ?? false, () => loadTimeline(convId, true));

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickToBottom.current = true;
    setAwayFromBottom(false);
  }

  function restore(pos: ScrollPos) {
    const el = scrollRef.current;
    const anchor = !pos.atBottom && document.getElementById(`msg-${pos.anchorId}`);
    if (!el || !anchor || pos.atBottom) return scrollToBottom();
    el.scrollTop = anchor.offsetTop - pos.offset;
    stickToBottom.current = false;
    setAwayFromBottom(true);
  }

  /** Remembers the first visible message and its offset (or "at the bottom"). */
  function rememberPosition() {
    const el = scrollRef.current;
    if (!el || !loaded) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = atBottom;
    setAwayFromBottom(!atBottom);
    if (atBottom) return saveScroll(convId, entryKey, { atBottom: true });
    const anchor = [...el.querySelectorAll<HTMLElement>('[id^="msg-"]')].find((m) => m.offsetTop + m.offsetHeight > el.scrollTop);
    if (anchor) saveScroll(convId, entryKey, { atBottom: false, anchorId: anchor.id.slice(4), offset: anchor.offsetTop - el.scrollTop });
  }

  // Where to land: this history entry's position, else the jump target (useJumpTo),
  // else where you last were in this conversation, else the latest message.
  useLayoutEffect(() => {
    if (!loaded) return;
    const pos = entryScroll(convId, entryKey) ?? (msgId ? undefined : conversationScroll(convId));
    if (pos) restore(pos);
    else if (!msgId) scrollToBottom();
  }, [loaded, entryKey]);

  useEffect(() => {
    setViewing(convId);
    return () => setViewing(null);
  }, [convId]);

  useEffect(() => {
    if (!loaded) void loadTimeline(convId);
  }, [convId, loaded]);

  useEffect(() => {
    if (loaded) markConversationRead(convId);
    const onVisible = () => document.visibilityState === 'visible' && markConversationRead(convId);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [convId, loaded, ids.length, unreadActivity]);

  const myPending = Object.values(pending)
    .filter((p) => p.convId === convId && !p.threadRootId)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Follow new messages only while you're at the bottom.
  useEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [ids.length, myPending.length]);

  async function loadOlder() {
    const el = scrollRef.current!;
    const before = el.scrollHeight;
    await loadTimeline(convId, true);
    requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - before));
  }

  const firstUnread = ids.find((id) => messages[id].seq > readMark && messages[id].authorId !== me.id);
  const name = conversationName(view.conversation, users, me.id);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h2 className="min-w-0 truncate font-bold">{name}</h2>
        {view.conversation.kind === 'channel' && <span className="shrink-0 text-xs text-gray-500">{view.conversation.memberIds.length} members</span>}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto py-3" onScroll={rememberPosition}>
          {!loaded && <p className="px-5 text-gray-400">Loading…</p>}
          {tl?.hasMore && (
            <div className="py-2 text-center">
              <button className="text-sm text-sky-700 hover:underline" onClick={loadOlder}>
                Load older messages
              </button>
            </div>
          )}
          {loaded && !tl.hasMore && (
            <div className="px-5 pb-4 text-sm text-gray-500">
              This is the very beginning of <b>{name}</b>.
            </div>
          )}
          {ids.map((id, i) => {
            const m = messages[id];
            const prev = i > 0 ? messages[ids[i - 1]] : undefined;
            const newDay = !prev || fmtDay(prev.createdAt) !== fmtDay(m.createdAt);
            const isFirstUnread = id === firstUnread;
            return (
              <Fragment key={id}>
                {newDay && <Divider label={fmtDay(m.createdAt)} />}
                {isFirstUnread && <Divider label="New" red />}
                <MessageItem m={m} showHeader={newDay || isFirstUnread || !sameGroup(prev, m)} highlighted={highlighted === id} inThread={false} />
              </Fragment>
            );
          })}
          {myPending.map((p, i) => (
            <PendingItem key={p.clientMsgId} p={p} showHeader={i === 0 && !sameGroup(messages[ids[ids.length - 1]], { authorId: me.id, createdAt: p.createdAt })} />
          ))}
        </div>
        {awayFromBottom && (
          <button
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-sky-700 px-4 py-1.5 text-sm font-semibold text-white shadow-lg hover:bg-sky-800"
            onClick={() => scrollToBottom(true)}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>

      <Composer convId={convId} placeholder={`Message ${name}`} />
    </section>
  );
}

export function Divider({ label, red }: { label: string; red?: boolean }) {
  return (
    <div className={`my-2 flex items-center gap-2 px-5 text-xs font-semibold ${red ? 'text-rose-600' : 'text-gray-500'}`}>
      <div className={`h-px flex-1 ${red ? 'bg-rose-300' : 'bg-gray-200'}`} />
      {label}
      <div className={`h-px flex-1 ${red ? 'bg-rose-300' : 'bg-gray-200'}`} />
    </div>
  );
}
