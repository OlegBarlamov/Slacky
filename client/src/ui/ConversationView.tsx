import { useEffect, useState } from 'react';
import type { Id } from '@shared/types';
import { useHistoryNav } from '../state/route';
import { conversationScroll, entryScroll, saveScroll } from '../state/scroll';
import { joinChannel, markReadUpTo, setViewing, useStore } from '../state/store';
import { convKey } from '../state/windows';
import { Composer } from './Composer';
import { conversationName } from './format';
import { MessageList } from './MessageList';

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
  const pending = useStore((s) => s.pending);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  // Snapshot at open time, so the "New" divider doesn't vanish the moment we mark as read.
  const [readMark] = useState(() => view.lastReadSeq);
  const { entryKey } = useHistoryNav();
  // Back/Forward return to that entry's position; opening from elsewhere returns to where
  // you last were in this conversation; a jump target wins over both.
  const [savedPos] = useState(() => entryScroll(convId, entryKey) ?? (msgId ? undefined : conversationScroll(convId)));
  const returning = !!entryScroll(convId, entryKey);

  useEffect(() => {
    setViewing(convId);
    return () => setViewing(null);
  }, [convId]);

  const myPending = Object.values(pending)
    .filter((p) => p.convId === convId && !p.threadRootId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const name = conversationName(view.conversation, users, me.id);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h2 className="min-w-0 truncate font-bold">{name}</h2>
        {view.conversation.kind === 'channel' && <span className="shrink-0 text-xs text-gray-500">{view.conversation.memberIds.length} members</span>}
      </header>

      <MessageList
        tkey={convKey(convId)}
        inThread={false}
        target={returning ? null : msgId}
        readMark={readMark}
        savedPos={savedPos}
        pending={myPending}
        onReadUpTo={(seq) => markReadUpTo(convId, seq)}
        onPosition={(pos) => saveScroll(convId, entryKey, pos)}
        header={(hasBefore) =>
          hasBefore ? (
            <p className="px-5 py-2 text-center text-sm text-gray-400">Loading older messages…</p>
          ) : (
            <div className="px-5 pb-4 text-sm text-gray-500">
              This is the very beginning of <b>{name}</b>.
            </div>
          )
        }
      />

      <Composer convId={convId} placeholder={`Message ${name}`} />
    </section>
  );
}
