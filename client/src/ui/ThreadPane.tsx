import { useState } from 'react';
import type { Id } from '@shared/types';
import { href } from '../state/route';
import { markThreadReadUpTo, useStore } from '../state/store';
import { threadKey } from '../state/windows';
import { Composer } from './Composer';
import { conversationName } from './format';
import { Divider, MessageItem } from './MessageItem';
import { MessageList } from './MessageList';

export function ThreadPane({ convId, rootId, msgId }: { convId: Id; rootId: Id; msgId: Id | null }) {
  const root = useStore((s) => s.messages[rootId]);
  const pending = useStore((s) => s.pending);
  const conv = useStore((s) => s.convs[convId]?.conversation);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  // Snapshot of my read position when the thread opened, for the "New" divider. Known once
  // the first page arrives (null: I don't follow the thread).
  const lastRead = useStore((s) => s.threadReads[rootId]);
  const [readMark, setReadMark] = useState<number | null | undefined>(lastRead);
  if (readMark === undefined && lastRead !== undefined) setReadMark(lastRead);

  const myPending = Object.values(pending)
    .filter((p) => p.threadRootId === rootId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const replyCount = root?.thread?.replyCount ?? 0;

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
      <MessageList
        tkey={threadKey(rootId)}
        inThread
        target={msgId === rootId ? null : msgId}
        readMark={readMark ?? null}
        pending={myPending}
        onReadUpTo={(seq) => markThreadReadUpTo(rootId, seq)}
        header={(hasBefore) =>
          root && (
            <>
              <MessageItem m={root} showHeader highlighted={false} inThread />
              <Divider label={`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`} />
              {hasBefore && <p className="px-5 py-2 text-center text-sm text-gray-400">Loading earlier replies…</p>}
            </>
          )
        }
      />
      <Composer convId={convId} threadRootId={rootId} placeholder="Reply…" autoFocus />
    </aside>
  );
}
