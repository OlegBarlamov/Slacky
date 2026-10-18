import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { isEmptyQuery, parseQuery } from '@shared/search';
import type { Message, SearchResult } from '@shared/types';
import { href, navigate } from '../state/route';
import { useStore } from '../state/store';
import { api } from '../transport/api';
import { Avatar } from './Avatar';
import { conversationName, userName } from './format';
import { RichText } from './RichText';

const RECENT_KEY = 'slacky-recent-searches';

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function rememberSearch(q: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...loadRecent().filter((x) => x !== q)].slice(0, 5)));
}

interface Suggestion {
  key: string;
  label: ReactNode;
  hint?: string;
  run: () => void;
}

/**
 * Top-bar search. While typing it suggests people after `from:`, channels after `in:`, and
 * the top few matching messages; when empty it offers recent searches and filter hints.
 * Ctrl/⌘+K focuses it.
 */
export function SearchBox({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<Message[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const users = useStore((s) => s.users);
  const convs = useStore((s) => s.convs);
  const otherChannels = useStore((s) => s.otherChannels);
  const me = useStore((s) => s.me)!;

  useEffect(() => setQ(initial), [initial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const lastToken = q.split(/\s+/).pop() ?? '';
  const fromMatch = /^from:@?(.*)$/i.exec(lastToken);
  const inMatch = /^in:#?(.*)$/i.exec(lastToken);
  const hashMatch = /^#(.*)$/.exec(lastToken);
  const parsed = parseQuery(q);

  // Quick results, debounced so we don't hit the search service on every keystroke.
  useEffect(() => {
    if (!open || fromMatch || inMatch || hashMatch || isEmptyQuery(parsed)) return setHits([]);
    let alive = true;
    const t = setTimeout(() => {
      api<SearchResult>('GET', `/search?q=${encodeURIComponent(q)}&limit=5`).then(
        (r) => alive && setHits(r.messages),
        () => alive && setHits([]),
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, open]);

  function close() {
    setOpen(false);
    input.current?.blur();
  }

  function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    rememberSearch(t);
    navigate(href.search(t));
    close();
  }

  /** Replaces the token being typed, e.g. `from:@be` -> `from:@ben `. */
  function complete(token: string, space = true) {
    setQ(q.slice(0, q.length - lastToken.length) + token + (space ? ' ' : ''));
    setIndex(0);
    input.current?.focus();
  }

  let suggestions: Suggestion[];
  if (fromMatch) {
    const prefix = fromMatch[1].toLowerCase();
    suggestions = Object.values(users)
      .filter((u) => u.name.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((u) => ({
        key: u.id,
        label: (
          <span className="flex items-center gap-2">
            <Avatar user={u} size={20} /> {u.name}
            {u.id === me.id && <span className="opacity-60">(you)</span>}
          </span>
        ),
        hint: 'from',
        run: () => complete(`from:@${u.name}`),
      }));
  } else if (inMatch) {
    const prefix = inMatch[1].toLowerCase();
    suggestions = Object.values(convs)
      .map((v) => v.conversation)
      .filter((c) => c.kind === 'channel' && c.name!.startsWith(prefix))
      .sort((a, b) => a.name!.localeCompare(b.name!))
      .slice(0, 6)
      .map((c) => ({ key: c.id, label: `#${c.name}`, hint: 'in', run: () => complete(`in:#${c.name}`) }));
  } else if (hashMatch) {
    // `#gen` suggests channels to jump to; Enter on the first row searches inside it instead.
    const prefix = hashMatch[1].toLowerCase();
    const channels = [...Object.values(convs).map((v) => v.conversation), ...otherChannels]
      .filter((c) => c.kind === 'channel' && c.name!.startsWith(prefix))
      .sort((a, b) => Number(b.name === prefix) - Number(a.name === prefix) || a.name!.localeCompare(b.name!))
      .slice(0, 6);
    suggestions = [
      ...(q.trim() !== '#' ? [{ key: 'search', label: <>Search messages in “{q.trim()}”</>, hint: 'Enter', run: () => submit(q) }] : []),
      ...channels.map((c) => ({
        key: c.id,
        label: `#${c.name}`,
        hint: convs[c.id] ? 'Open channel' : 'Not joined',
        run: () => {
          navigate(href.conv(c.id));
          close();
        },
      })),
    ];
  } else if (!q.trim()) {
    suggestions = [
      ...loadRecent().map((r) => ({ key: `recent:${r}`, label: r, hint: 'Recent', run: () => submit(r) })),
      { key: 'from', label: 'from:@person', hint: 'Messages by someone', run: () => complete('from:@', false) },
      { key: 'in', label: 'in:#channel', hint: 'Messages in a channel', run: () => complete('in:#', false) },
      { key: 'phrase', label: '"exact phrase"', hint: 'Match words in order', run: () => complete('""', false) },
    ];
  } else {
    suggestions = [
      { key: 'search', label: <>Search for “{q.trim()}”</>, hint: 'Enter', run: () => submit(q) },
      ...hits.map((m) => ({
        key: m.id,
        label: (
          <span className="block truncate">
            <RichText text={m.text} highlightTerms={parsed.terms} />
          </span>
        ),
        hint: `${userName(users, m.authorId)} · ${conversationName(convs[m.convId]?.conversation, users, me.id)}`,
        run: () => {
          navigate(href.conv(m.convId, m.threadRootId, m.id));
          close();
        },
      })),
    ];
  }
  const active = Math.min(index, suggestions.length - 1);

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') setIndex((active + 1) % suggestions.length);
    else if (e.key === 'ArrowUp') setIndex((active - 1 + suggestions.length) % suggestions.length);
    else if (e.key === 'Enter') (suggestions[active]?.run ?? (() => submit(q)))();
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  }

  return (
    <div className="relative mx-auto w-full max-w-xl">
      <input
        ref={input}
        className="w-full rounded-md bg-white/20 px-3 py-1 text-sm text-white placeholder-white/60 outline-none focus:bg-white focus:text-gray-900"
        placeholder="Search messages (Ctrl+K)"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && suggestions.length > 0 && (
        // preventDefault on mousedown keeps focus in the input so clicks register before blur
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border bg-white py-1 text-sm text-gray-900 shadow-xl" onMouseDown={(e) => e.preventDefault()}>
          {suggestions.map((s, i) => (
            <li key={s.key}>
              <button
                className={`flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left ${i === active ? 'bg-sky-600 text-white' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={s.run}
              >
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {s.hint && <span className="shrink-0 text-xs opacity-60">{s.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
