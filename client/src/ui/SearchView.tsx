import { useEffect, useState } from 'react';
import { parseQuery, withoutFilter } from '@shared/search';
import type { SearchResult } from '@shared/types';
import { href, navigate } from '../state/route';
import { useStore } from '../state/store';
import { api, ApiError } from '../transport/api';
import { Avatar } from './Avatar';
import { conversationName, fmtDay, fmtTime, userName } from './format';
import { RichText } from './RichText';

/** Results come newest first, the server's only order. */
export function SearchView({ q }: { q: string }) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const users = useStore((s) => s.users);
  const convs = useStore((s) => s.convs);
  const otherChannels = useStore((s) => s.otherChannels);
  const me = useStore((s) => s.me)!;
  const parsed = parseQuery(q);
  // Search only covers conversations you're in; explain an `in:` filter that can't match.
  const inChannel = parsed.in ? Object.values(convs).find((v) => v.conversation.name === parsed.in)?.conversation : undefined;
  const joinable = parsed.in && !inChannel ? otherChannels.find((c) => c.name === parsed.in) : undefined;

  useEffect(() => {
    let alive = true;
    setResult(null);
    setError(null);
    api<SearchResult>('GET', `/search?q=${encodeURIComponent(q)}`).then(
      (r) => alive && setResult(r),
      (e) => alive && setError(e instanceof ApiError ? e.message : 'Network error. Try again.'),
    );
    return () => {
      alive = false;
    };
  }, [q, attempt]);

  const chips = [
    parsed.from && { label: `From: ${parsed.from}`, remove: () => navigate(href.search(withoutFilter(q, 'from'))) },
    parsed.in && { label: `In: #${parsed.in}`, remove: () => navigate(href.search(withoutFilter(q, 'in'))) },
  ].filter((c) => !!c);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <h2 className="shrink-0 font-bold">Search</h2>
        <span className="min-w-0 truncate text-sm text-gray-500">
          {result ? `${result.total} result${result.total === 1 ? '' : 's'} for “${q}”` : error ? '' : `Searching “${q}”…`}
        </span>
      </header>

      {chips.length > 0 && (
        <div className="flex gap-2 border-b px-5 py-2">
          {chips.map((c) => (
            <span key={c.label} className="flex items-center gap-1 rounded-full bg-sky-50 px-3 py-0.5 text-sm text-sky-800">
              {c.label}
              <button className="text-sky-500 hover:text-sky-900" onClick={c.remove} aria-label={`Remove ${c.label}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {result && result.pendingChanges > 0 && (
        <div className="border-b bg-amber-50 px-5 py-1.5 text-sm text-amber-800">
          The search index is catching up — {result.pendingChanges} recent change(s) aren’t searchable yet.
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="p-10 text-center">
            <p className="text-rose-600">{error}</p>
            <button className="mt-3 rounded-md border px-4 py-1.5 text-sm hover:bg-gray-50" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {parsed.in && !inChannel && result && (
          <p className="p-10 text-center text-gray-500">
            {joinable ? (
              <>
                You’re not a member of <b>#{parsed.in}</b>.{' '}
                <a className="text-sky-700 hover:underline" href={href.conv(joinable.id)}>
                  Join it
                </a>{' '}
                to search its messages.
              </>
            ) : (
              <>
                There’s no channel named <b>#{parsed.in}</b>.
              </>
            )}
          </p>
        )}
        {result?.messages.length === 0 && (!parsed.in || inChannel) && (
          <div className="p-10 text-center text-gray-500">
            <p>No messages match “{q}”.</p>
            <p className="mt-2 text-sm">
              Try fewer words, a word prefix like <code>depl</code>, an <code>"exact phrase"</code>, or filters <code>from:@name</code> and{' '}
              <code>in:#channel</code>.
            </p>
          </div>
        )}
        {result?.messages.map((m) => (
          <a key={m.id} href={href.conv(m.convId, m.threadRootId, m.id)} className="flex gap-3 border-b px-5 py-3 hover:bg-gray-50">
            <Avatar user={users[m.authorId]} />
            <div className="min-w-0">
              <div className="truncate text-xs text-gray-500">
                <b className="text-gray-900">{userName(users, m.authorId)}</b> in {conversationName(convs[m.convId]?.conversation, users, me.id)}
                {m.threadRootId && ' (thread)'} · {fmtDay(m.createdAt)} {fmtTime(m.createdAt)}
              </div>
              <div className="line-clamp-3 break-words text-sm">
                <RichText text={m.text} highlightTerms={parsed.terms} />
                {m.editedAt && <span className="ml-1 text-xs text-gray-400">(edited)</span>}
              </div>
            </div>
          </a>
        ))}
        {result && result.total > result.messages.length && (
          <p className="p-4 text-center text-xs text-gray-400">
            Showing the {result.messages.length} newest of {result.total}. Add words or filters to narrow it down.
          </p>
        )}
      </div>
    </section>
  );
}
