import { useEffect } from 'react';
import type { Id } from '@shared/types';
import { href } from '../state/route';
import { loadThread, markThreadRead, useStore } from '../state/store';
import { Composer } from './Composer';
import { Divider } from './ConversationView';
import { conversationName } from './format';
import { MessageItem, PendingItem, sameGroup } from './MessageItem';
import { useJumpTo } from './useJumpTo';

export function ThreadPane({ convId, rootId, msgId }: { convId: Id; rootId: Id; msgId: Id | null }) {
  const thread = useStore((s) => s.threads[rootId]);
  const root = useStore((s) => s.messages[rootId]);
  const messages = useStore((s) => s.messages);
  const pending = useStore((s) => s.pending);
  const conv = useStore((s) => s.convs[convId]?.conversation);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const unread = useStore((s) => Object.values(s.activity).some((i) => i.threadRootId === rootId && !i.read));
  const loaded = !!thread;
  const replyIds = thread?.replyIds ?? [];
  const highlighted = useJumpTo(msgId, replyIds, false, async () => {});

  useEffect(() => {
    if (!loaded) void loadThread(rootId);
  }, [rootId, loaded]);

  useEffect(() => {
    if (loaded && unread) markThreadRead(rootId);
  }, [rootId, loaded, unread]);

  const myPending = Object.values(pending)
    .filter((p) => p.threadRootId === rootId)
    .sort((a, b) => a.createdAt - b.createdAt);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="shrink-0 font-bold">Thread</h2>
        <span className="min-w-0 truncate text-xs text-gray-500">{conversationName(conv, users, me.id)}</span>
        <div className="flex-1" />
        <a href={href.conv(convId)} className="px-1 text-lg text-gray-500 hover:text-gray-900" title="Close">
          ×
        </a>
      </header>
      <div className="flex-1 overflow-y-auto py-3">
        {!root ? (
          <p className="px-5 text-gray-400">Loading…</p>
        ) : (
          <>
            <MessageItem m={root} showHeader highlighted={highlighted === root.id} inThread />
            <Divider label={`${replyIds.length} ${replyIds.length === 1 ? 'reply' : 'replies'}`} />
            {replyIds.map((id, i) => (
              <MessageItem key={id} m={messages[id]} showHeader={!sameGroup(messages[replyIds[i - 1]], messages[id])} highlighted={highlighted === id} inThread />
            ))}
            {myPending.map((p, i) => (
              <PendingItem key={p.clientMsgId} p={p} showHeader={i === 0} />
            ))}
          </>
        )}
      </div>
      <Composer convId={convId} threadRootId={rootId} placeholder="Reply…" autoFocus />
    </aside>
  );
}
