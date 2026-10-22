import { useState, type KeyboardEvent } from 'react';
import type { Conversation, User } from '@shared/types';
import { CHANNEL_NAME_RULES, isValidChannelName, toChannelName } from '@shared/names';
import { href, navigate } from '../state/route';
import { createChannel, joinChannel, openDm, useStore } from '../state/store';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { useUserSearch } from './useUserSearch';

type ChannelOption =
  | { kind: 'open' | 'join'; channel: Conversation; hint: string }
  | { kind: 'create'; name: string; hint: string };

/** Arrow keys move through a list, Enter picks the active item. */
function listKeys(e: KeyboardEvent<HTMLInputElement>, count: number, active: number, setIndex: (i: number) => void, pick: () => void) {
  if (!count) return;
  if (e.key === 'ArrowDown') setIndex((active + 1) % count);
  else if (e.key === 'ArrowUp') setIndex((active - 1 + count) % count);
  else if (e.key === 'Enter') pick();
  else return;
  e.preventDefault();
}

/** Join an existing channel or create a new one; suggestions appear as you type. */
export function ChannelModal({ onClose }: { onClose: () => void }) {
  const [raw, setRaw] = useState('');
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const convs = useStore((s) => s.convs);
  const otherChannels = useStore((s) => s.otherChannels);
  const hidden = useStore((s) => s.hidden);

  const name = toChannelName(raw);
  const invalid = name !== '' && !isValidChannelName(name);
  const joined = Object.values(convs)
    .map((v) => v.conversation)
    .filter((c) => c.kind === 'channel');
  const all = [...joined.map((c) => ({ kind: 'open' as const, c })), ...otherChannels.map((c) => ({ kind: 'join' as const, c }))];
  const options: ChannelOption[] = all
    .filter(({ c }) => c.name!.includes(name))
    .sort((a, b) => Number(b.c.name === name) - Number(a.c.name === name) || Number(b.c.name!.startsWith(name)) - Number(a.c.name!.startsWith(name)) || a.c.name!.localeCompare(b.c.name!))
    .slice(0, 8)
    .map(({ kind, c }) => ({
      kind,
      channel: c,
      hint: kind === 'join' ? `${c.memberIds.length} members · Join` : hidden[c.id] ? 'Hidden · show in sidebar' : 'Joined',
    }));
  if (name && !invalid && !all.some(({ c }) => c.name === name)) options.push({ kind: 'create', name, hint: 'Create new channel' });
  const active = Math.min(index, options.length - 1);

  async function pick(o: ChannelOption | undefined) {
    if (!o || busy) return;
    setBusy(true);
    const c = o.kind === 'create' ? await createChannel(o.name) : o.kind === 'join' ? await joinChannel(o.channel.id) : o.channel;
    setBusy(false);
    if (!c) return; // error already shown as a toast
    navigate(href.conv(c.id));
    onClose();
  }

  return (
    <Modal title="Join or create a channel" onClose={onClose}>
      <div className={`flex items-center rounded-md border px-3 focus-within:ring-2 ${invalid ? 'border-rose-400 ring-rose-200' : 'ring-sky-200'}`}>
        <span className="text-gray-400">#</span>
        <input
          autoFocus
          className="w-full px-1 py-2 outline-none"
          placeholder="Search or name a new channel"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => listKeys(e, options.length, active, setIndex, () => void pick(options[active]))}
        />
      </div>
      {invalid && <p className="mt-1.5 text-xs text-rose-600">{CHANNEL_NAME_RULES}</p>}
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {options.length === 0 && !invalid && <li className="px-3 py-6 text-center text-sm text-gray-500">Type a name to create a channel</li>}
        {options.map((o, i) => (
          <li key={o.kind === 'create' ? '+create' : o.channel.id} ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
            <button
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left ${i === active ? 'bg-sky-600 text-white' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(o)}
            >
              <span className="min-w-0 truncate font-medium">
                {o.kind === 'create' ? '+ ' : ''}#{o.kind === 'create' ? o.name : o.channel.name}
              </span>
              <span className="ml-auto shrink-0 text-xs opacity-70">{o.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-400">↑↓ to move · Enter to open · Esc to close</p>
    </Modal>
  );
}

export function NewDmModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;

  const q = query.trim().toLowerCase().replace(/^@/, '');
  // People I know match anywhere in the name; the server finds everyone else by prefix.
  const found = useUserSearch(q, null, 20);
  const matches = [...new Map([...Object.values(users).filter((u) => u.name.includes(q)), ...found].map((u) => [u.id, u])).values()]
    .sort(
      (a, b) =>
        Number(b.id === me.id) - Number(a.id === me.id) || // yourself first, like Slack
        Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) ||
        a.name.localeCompare(b.name),
    );
  const active = Math.min(index, matches.length - 1);

  async function start(u: User | undefined) {
    if (!u) return;
    onClose();
    const c = await openDm(u.id);
    if (c) navigate(href.conv(c.id));
  }

  return (
    <Modal title="New message" onClose={onClose}>
      <input
        autoFocus
        className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2 ring-sky-200"
        placeholder="Search people"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => listKeys(e, matches.length, active, setIndex, () => void start(matches[active]))}
      />
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {matches.length === 0 && <li className="px-3 py-6 text-center text-sm text-gray-500">No one matches “{query.trim()}”</li>}
        {matches.map((u, i) => (
          <li key={u.id} ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
            <button
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left ${i === active ? 'bg-sky-600 text-white' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => start(u)}
            >
              <Avatar user={u} size={24} />
              <span className="min-w-0 truncate">{u.name}</span>
              {u.id === me.id && <span className="shrink-0 opacity-70">(you)</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-400">↑↓ to move · Enter to open · Esc to close</p>
    </Modal>
  );
}
