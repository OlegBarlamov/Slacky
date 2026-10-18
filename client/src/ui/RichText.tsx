import { Fragment, type ReactNode } from 'react';
import { normalizeWord } from '@shared/search';
import { useStore } from '../state/store';

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|@[a-z0-9._-]+|https?:\/\/[^\s]+)/gi;

/** Marks words that match a search term the same way the index does (normalized, prefix). */
function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;
  return text.split(/([\p{L}\p{N}_]+)/u).map((part, i) => {
    const hit = i % 2 === 1 && terms.some((t) => normalizeWord(part).startsWith(t));
    return hit ? <mark key={i} className="rounded-sm bg-yellow-200 px-px">{part}</mark> : part;
  });
}

/** Minimal formatting: `code`, **bold**, links and @mentions; optional search highlighting. */
export function RichText({ text, highlightTerms = [] }: { text: string; highlightTerms?: string[] }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me);
  return (
    <>
      {text.split(TOKEN).map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{highlight(part, highlightTerms)}</Fragment>;
        if (part.startsWith('`')) return <code key={i} className="px-1 rounded bg-gray-100 text-rose-700 text-[0.9em]">{part.slice(1, -1)}</code>;
        if (part.startsWith('**')) return <strong key={i}>{highlight(part.slice(2, -2), highlightTerms)}</strong>;
        if (part.startsWith('http')) return <a key={i} href={part} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">{part}</a>;
        const name = part.slice(1).toLowerCase().replace(/[._-]+$/, '');
        const isBroadcast = name === 'channel' || name === 'here';
        const known = isBroadcast || Object.values(users).some((u) => u.name === name);
        if (!known) return <Fragment key={i}>{part}</Fragment>;
        const isMe = isBroadcast || name === me?.name;
        return (
          <span key={i} className={`rounded px-0.5 ${isMe ? 'bg-amber-100 text-amber-900' : 'bg-sky-50 text-sky-700'}`}>
            {part}
          </span>
        );
      })}
    </>
  );
}
