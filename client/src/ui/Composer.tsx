import { useRef, useState, type KeyboardEvent } from 'react';
import type { Id } from '@shared/types';
import { sendMessage, setEditing, useStore } from '../state/store';
import { convKey, threadKey } from '../state/windows';
import { Avatar } from './Avatar';
import { isTooLong, LengthHint, useAutoGrow } from './textInput';
import { useUserSearch } from './useUserSearch';

export function Composer({ convId, threadRootId = null, placeholder, autoFocus = false }: { convId: Id; threadRootId?: Id | null; placeholder: string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  const conv = useStore((s) => s.convs[convId]?.conversation);
  const me = useStore((s) => s.me)!;
  // Everyone is taggable; the server puts people in this conversation first.
  const found = useUserSearch(mention?.query ?? null, convId);

  const members = new Set(conv?.memberIds);
  const candidates = mention
    ? [
        ...found
          .sort((a, b) => Number(!members.has(a.id)) - Number(!members.has(b.id)))
          .map((u) => ({ name: u.name, user: u, note: u.id === me.id ? 'you' : members.has(u.id) ? '' : 'not in this conversation' })),
        // @channel notifies everyone, so it's offered only at the top level of a channel, not in replies.
        ...(conv?.kind === 'channel' && !threadRootId ? [{ name: 'channel', user: null, note: 'notify everyone' }] : []),
      ]
        .filter((c) => c.name.startsWith(mention.query))
        .slice(0, 8)
    : [];

  function onChange(value: string) {
    setText(value);
    const caret = ref.current?.selectionStart ?? value.length;
    const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(value.slice(0, caret));
    setMention(m ? { query: m[2].toLowerCase(), index: 0 } : null);
  }

  function complete(name: string) {
    const caret = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([a-z0-9._-]*)$/i, `@${name} `);
    setText(before + text.slice(caret));
    setMention(null);
    requestAnimationFrame(() => ref.current?.setSelectionRange(before.length, before.length));
  }

  function submit() {
    if (!text.trim() || isTooLong(text)) return;
    sendMessage(convId, text.trim(), threadRootId);
    setText('');
    setMention(null);
  }

  function editLastOwn() {
    const s = useStore.getState();
    const ids = s.windows[threadRootId ? threadKey(threadRootId) : convKey(convId)]?.ids;
    const last = [...(ids ?? [])].reverse().find((id) => s.messages[id].authorId === me.id && !s.messages[id].deletedAt);
    if (last) setEditing(last);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && candidates.length) {
      const move = (d: number) => setMention({ ...mention, index: (mention.index + d + candidates.length) % candidates.length });
      if (e.key === 'ArrowDown') move(1);
      else if (e.key === 'ArrowUp') move(-1);
      else if (e.key === 'Enter' || e.key === 'Tab') complete(candidates[mention.index].name);
      else if (e.key === 'Escape') setMention(null);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      editLastOwn();
    }
  }

  return (
    <div className="relative px-5 pb-4">
      {mention && candidates.length > 0 && (
        <ul className="absolute bottom-full left-5 mb-1 w-64 overflow-hidden rounded-md border bg-white shadow-lg">
          {candidates.map(({ name, user, note }, i) => (
            <li key={name}>
              <button
                className={`flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm ${i === mention.index ? 'bg-sky-600 text-white' : 'hover:bg-gray-100'}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(name);
                }}
              >
                {user ? (
                  <Avatar user={user} size={20} />
                ) : (
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-gray-200 text-xs text-gray-600">@</span>
                )}
                <span className="min-w-0 truncate">@{name}</span>
                {note && <span className="shrink-0 opacity-70">· {note}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-gray-300 focus-within:border-gray-500">
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          className="block w-full resize-none rounded-lg px-3 py-2 outline-none"
          rows={1}
          placeholder={placeholder}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[11px] text-gray-400">
        <span className="truncate">Enter to send · Shift+Enter for a new line · ↑ to edit your last message</span>
        <LengthHint text={text} />
      </div>
    </div>
  );
}
