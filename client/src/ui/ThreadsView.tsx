import { useEffect, useState } from 'react';
import type { FollowedThread, Message, ThreadList } from '@shared/types';
import { href, navigate, replaceRoute } from '../state/route';
import { useStore } from '../state/store';
import { api, ApiError } from '../transport/api';
import { Avatar } from './Avatar';
import { ago, conversationName, userName } from './format';
import { RichText } from './RichText';

const lastReplyAt = (t: FollowedThread) => t.root.thread?.lastReplyAt ?? 0;
const newestFirst = (a: FollowedThread, b: FollowedThread) => lastReplyAt(b) - lastReplyAt(a) || (a.root.id < b.root.id ? 1 : -1);

/**
 * Merges a fresh first page into what's loaded: it replaces everything down to its last
 * item; older pages already loaded stay.
 */
function mergeHead(loaded: FollowedThread[], head: ThreadList): FollowedThread[] {
  if (!head.nextCursor) return head.threads;
  const ids = new Set(head.threads.map((t) => t.root.id));
  const last = head.threads[head.threads.length - 1];
  return [...head.threads, ...loaded.filter((t) => !ids.has(t.root.id) && newestFirst(last, t) < 0)];
}

/**
 * Threads I follow, newest reply first, a page at a time. Lives outside the message store
 * (like search results) and refetches its first page when a followed thread changes.
 */
export function ThreadsView({ unreadOnly }: { unreadOnly: boolean }) {
  const version = useStore((s) => s.threadsVersion);
  const [threads, setThreads] = useState<FollowedThread[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = (cursor: string | null) => `/threads?${new URLSearchParams({ ...(unreadOnly && { unread: '1' }), ...(cursor && { cursor }) })}`;

  useEffect(() => {
    let alive = true;
    // Replies can come in bursts: refetch once they settle.
    const timer = setTimeout(
      () =>
        api<ThreadList>('GET', query(null)).then(
          (head) => {
            if (!alive) return;
            setThreads((cur) => mergeHead(cur ?? [], head));
            // Older pages already loaded stay, and so does the cursor past them.
            setNextCursor((cur) => (head.nextCursor === null ? null : (cur ?? head.nextCursor)));
            setError(null);
          },
          (e) => alive && setError(e instanceof ApiError ? e.message : 'Network error. Try again.'),
        ),
      threads ? 300 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [version]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<ThreadList>('GET', query(nextCursor));
      setThreads((cur) => {
        const ids = new Set((cur ?? []).map((t) => t.root.id));
        return [...(cur ?? []), ...page.threads.filter((t) => !ids.has(t.root.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Network error. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-5">
        <h2 className="mr-3 font-bold">Threads</h2>
        <div className="flex-1" />
        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-gray-600">
          Unread only
          <button
            role="switch"
            aria-checked={unreadOnly}
            onClick={() => replaceRoute(href.threads(!unreadOnly))}
            className={`relative h-5 w-9 rounded-full transition-colors ${unreadOnly ? 'bg-sky-600' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${unreadOnly ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
      </header>
      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-5 text-sm text-rose-600">{error}</p>}
        {!threads && !error && <p className="p-5 text-gray-400">Loading…</p>}
        {threads?.length === 0 && (
          <p className="p-10 text-center text-gray-500">{unreadOnly ? 'You’re all caught up 🎉' : 'Threads you start, reply to or are mentioned in show up here.'}</p>
        )}
        {threads?.map((t) => <ThreadRow key={t.root.id} t={t} />)}
        {nextCursor && (
          <div className="py-4 text-center">
            <button className="text-sm text-sky-700 hover:underline disabled:opacity-50" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Show more threads'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ThreadRow({ t }: { t: FollowedThread }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const conv = useStore((s) => s.convs[t.root.convId]?.conversation);
  const replyCount = t.root.thread?.replyCount ?? 0;
  const hidden = replyCount - t.latestReplies.length;

  return (
    <button onClick={() => navigate(href.conv(t.root.convId, t.root.id))} className="block w-full border-b px-5 py-3 text-left hover:bg-gray-50">
      <div className="mb-1 flex items-baseline gap-2 text-sm">
        <span className={`truncate ${t.unreadCount ? 'font-bold' : 'font-semibold text-gray-700'}`}>{conversationName(conv, users, me.id)}</span>
        {t.unreadCount > 0 && <span className="shrink-0 rounded-full bg-rose-600 px-1.5 text-xs font-bold text-white">{t.unreadCount} new</span>}
        <span className="ml-auto shrink-0 text-xs text-gray-400">{ago(lastReplyAt(t))}</span>
      </div>
      <Line m={t.root} />
      {hidden > 0 && (
        <div className="my-1 pl-9 text-xs font-semibold text-sky-700">
          {hidden} more {hidden === 1 ? 'reply' : 'replies'}
        </div>
      )}
      <div className="mt-1 space-y-1 border-l-2 border-gray-100 pl-3">
        {t.latestReplies.map((r) => (
          <Line key={r.id} m={r} unread={r.seq > t.lastReadSeq && r.authorId !== me.id} small />
        ))}
      </div>
    </button>
  );
}

function Line({ m, unread = false, small = false }: { m: Message; unread?: boolean; small?: boolean }) {
  const users = useStore((s) => s.users);
  return (
    <div className="flex gap-2">
      <Avatar user={users[m.authorId]} size={small ? 20 : 28} />
      <div className={`min-w-0 flex-1 text-sm ${unread ? 'font-medium text-gray-900' : 'text-gray-700'}`}>
        <b className="mr-1">{userName(users, m.authorId)}</b>
        <span className="line-clamp-2 inline whitespace-pre-wrap break-words">
          <RichText text={m.text} />
        </span>
        {m.editedAt && <span className="ml-1 text-xs text-gray-400">(edited)</span>}
      </div>
    </div>
  );
}
