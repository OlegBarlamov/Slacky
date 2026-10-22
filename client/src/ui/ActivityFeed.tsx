import type { ActivityItem } from '@shared/types';
import { href, navigate, replaceRoute, type ActivityFilter } from '../state/route';
import { markActivityRead, useStore } from '../state/store';
import { Avatar } from './Avatar';
import { ago, conversationName, listNames, userName } from './format';
import { RichText } from './RichText';

const FILTERS: Record<ActivityFilter, string> = { all: 'All', mentions: 'Mentions', threads: 'Threads' };
type Filter = ActivityFilter;

const matches = (i: ActivityItem, f: Filter) => f === 'all' || (f === 'mentions' && i.kind === 'mention') || (f === 'threads' && i.kind === 'thread');

/** Filters live in the URL so Back returns to the same view. */
export function ActivityFeed({ filter, unreadOnly }: { filter: Filter; unreadOnly: boolean }) {
  const activity = useStore((s) => s.activity);
  const inTab = Object.values(activity).filter((i) => matches(i, filter));

  // All tab only: a mention inside a thread is shown in that thread's row instead of as a
  // second row for the same message. The two items keep their own read state and badges;
  // this only changes how they're listed.
  const threadRoots = new Set(inTab.flatMap((i) => (i.kind === 'thread' ? [i.threadRootId] : [])));
  const foldsIntoThread = (i: ActivityItem) => filter === 'all' && i.kind === 'mention' && !!i.threadRootId && threadRoots.has(i.threadRootId);
  const rows = inTab
    .filter((i) => !foldsIntoThread(i))
    .map((item) => ({ item, mentions: item.kind === 'thread' ? inTab.filter((m) => foldsIntoThread(m) && m.threadRootId === item.threadRootId) : [] }));
  const rowUnread = (r: Row) => !r.item.read || r.mentions.some((m) => !m.read);
  const rowUpdated = (r: Row) => Math.max(r.item.updatedAt, ...r.mentions.map((m) => m.updatedAt));
  const items = rows.filter((r) => !unreadOnly || rowUnread(r)).sort((a, b) => rowUpdated(b) - rowUpdated(a));
  const unreadIds = inTab.filter((i) => !i.read).map((i) => i.id); // "mark all" covers the current tab

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-5">
        <h2 className="mr-3 font-bold">Activity</h2>
        {(Object.keys(FILTERS) as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => replaceRoute(href.activity(f, unreadOnly))}
            className={`rounded-full px-3 py-1 text-sm ${filter === f ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            {FILTERS[f]}
          </button>
        ))}
        <div className="flex-1" />
        <label className="mr-4 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-600">
          Unread only
          <button
            role="switch"
            aria-checked={unreadOnly}
            onClick={() => replaceRoute(href.activity(filter, !unreadOnly))}
            className={`relative h-5 w-9 rounded-full transition-colors ${unreadOnly ? 'bg-sky-600' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${unreadOnly ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
        {unreadIds.length > 0 && (
          <button className="text-sm text-sky-700 hover:underline" onClick={() => markActivityRead(unreadIds)}>
            Mark all as read
          </button>
        )}
      </header>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <p className="p-10 text-center text-gray-500">{unreadOnly ? 'You’re all caught up 🎉' : 'Nothing here yet.'}</p>
        )}
        {items.map(({ item, mentions }) => (
          <ActivityRow key={item.id} item={item} mentions={mentions} />
        ))}
      </div>
    </section>
  );
}

type Row = { item: ActivityItem; mentions: ActivityItem[] };

/** One feed row. `mentions` are mention items folded into a thread row (All tab). */
function ActivityRow({ item, mentions = [] }: Row) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  // Mentions can come from channels you haven't joined yet.
  const conv = useStore((s) => s.convs[item.convId]?.conversation ?? s.otherChannels.find((c) => c.id === item.convId));
  const knownDeleted = useStore((s) => !!s.messages[item.entries[0]?.messageId]?.deletedAt);
  const rootText = useStore((s) => (item.threadRootId ? s.messages[item.threadRootId]?.text : undefined));

  const last = item.entries[item.entries.length - 1];
  const where = conversationName(conv, users, me.id);
  const authors = [...new Set(item.entries.map((e) => e.authorId).reverse())].map((id) => userName(users, id));
  // Don't trust a lagging projection over what we already know: deleted is deleted.
  const state = item.kind !== 'dm' && item.kind !== 'thread' && knownDeleted ? 'deleted' : item.state;
  const n = item.entries.length;

  const unread = !item.read || mentions.some((m) => !m.read);
  const updatedAt = Math.max(item.updatedAt, ...mentions.map((m) => m.updatedAt));

  let icon = '@';
  let title: string;
  if (mentions.length) {
    const mentionedBy = [...new Set(mentions.map((m) => m.entries[0]?.authorId).filter(Boolean))].map((id) => userName(users, id!));
    title = `${listNames(mentionedBy)} mentioned you in a thread in ${where}${n > 1 ? ` · ${n} new replies` : ''}`;
  } else if (item.kind === 'mention') {
    title = `${authors[0]} mentioned ${item.channelWide ? '@channel' : 'you'}${item.threadRootId ? ' in a thread' : ''} in ${where}`;
  } else if (item.kind === 'dm') {
    icon = '✉';
    title = `${where}${n > 1 ? ` · ${n} new messages` : ''}`;
  } else {
    icon = '🧵';
    title = `${listNames(authors)} replied to a thread in ${where}${n > 1 ? ` · ${n} new replies` : ''}`;
  }

  function open() {
    markActivityRead([item.id]);
    const target = item.kind === 'dm' || item.kind === 'thread' ? item.entries[0] : last;
    navigate(href.conv(item.convId, item.threadRootId, state === 'deleted' ? null : target?.messageId));
  }

  return (
    <button onClick={open} className={`flex w-full gap-3 border-b px-5 py-3 text-left hover:bg-gray-50 ${state !== 'active' ? 'opacity-60' : ''}`}>
      <div className="flex w-3 shrink-0 justify-center pt-3">{unread && <span className="h-2 w-2 rounded-full bg-sky-600" />}</div>
      <div className="relative shrink-0">
        <Avatar user={users[last?.authorId ?? '']} />
        <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border bg-white text-[11px]">{icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`truncate text-sm ${unread ? 'font-semibold' : 'text-gray-600'} ${item.channelWide ? 'text-gray-500' : ''}`}>{title}</span>
          <span className="ml-auto shrink-0 text-xs text-gray-400">{ago(updatedAt)}</span>
        </div>
        {item.kind === 'thread' && rootText && <div className="truncate text-xs text-gray-400">Re: {rootText}</div>}
        <div className="mt-0.5 line-clamp-2 text-sm text-gray-800">
          {state === 'deleted' ? (
            <span className="italic text-gray-400">This message was deleted.</span>
          ) : (
            <>
              {state === 'retracted' && <span className="mr-1 rounded bg-gray-100 px-1 text-xs text-gray-500">No longer mentions you</span>}
              <b className="font-medium">{userName(users, last.authorId)}: </b>
              <span className={state === 'retracted' ? 'line-through' : ''}>
                <RichText text={last.text} />
              </span>
              {last.edited && <span className="ml-1 text-xs text-gray-400">(edited)</span>}
            </>
          )}
        </div>
      </div>
    </button>
  );
}
