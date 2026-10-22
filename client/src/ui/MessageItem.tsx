import { useRef, useState, type ReactNode } from 'react';
import type { Message } from '@shared/types';
import { href } from '../state/route';
import {
  deleteMessage,
  deliverPending,
  discardPending,
  editMessage,
  setEditing,
  useStore,
  type Pending,
} from '../state/store';
import { Avatar } from './Avatar';
import { ago, fmtTime } from './format';
import { RichText } from './RichText';
import { isTooLong, LengthHint, useAutoGrow } from './textInput';

function Row(props: { authorId: string; at: number; showHeader: boolean; highlighted?: boolean; id?: string; dim?: boolean; children: ReactNode }) {
  const author = useStore((s) => s.users[props.authorId]);
  return (
    <div
      id={props.id}
      className={`group relative flex gap-2 px-5 py-0.5 hover:bg-gray-50 transition-colors duration-700 ${props.showHeader ? 'mt-2' : ''} ${
        props.highlighted ? 'bg-amber-100' : ''
      } ${props.dim ? 'opacity-60' : ''}`}
    >
      <div className="w-9 shrink-0">
        {props.showHeader ? (
          <Avatar user={author} />
        ) : (
          <span className="invisible group-hover:visible whitespace-nowrap text-[10px] text-gray-400 leading-6">{fmtTime(props.at)}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {props.showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="font-bold">{author?.name ?? 'unknown'}</span>
            <span className="text-xs text-gray-500">{fmtTime(props.at)}</span>
          </div>
        )}
        {props.children}
      </div>
    </div>
  );
}

export function MessageItem({ m, showHeader, highlighted, inThread }: { m: Message; showHeader: boolean; highlighted: boolean; inThread: boolean }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const editing = useStore((s) => s.editingId === m.id);
  const mine = m.authorId === me.id;

  return (
    <Row id={`msg-${m.id}`} authorId={m.authorId} at={m.createdAt} showHeader={showHeader} highlighted={highlighted}>
      {m.deletedAt ? (
        <div className="italic text-gray-400">This message was deleted.</div>
      ) : editing ? (
        <EditBox m={m} />
      ) : (
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          <RichText text={m.text} />
          {m.editedAt && <span className="ml-1 text-xs text-gray-400">(edited)</span>}
        </div>
      )}

      {!inThread && m.thread && (
        <a href={href.conv(m.convId, m.id)} className="mt-1 flex w-fit items-center gap-1.5 rounded border border-transparent px-1 py-0.5 text-xs hover:border-gray-200 hover:bg-white">
          {m.thread.participantIds.slice(0, 4).map((id) => (
            <Avatar key={id} user={users[id]} size={20} />
          ))}
          <span className="font-semibold text-sky-700">
            {m.thread.replyCount} {m.thread.replyCount === 1 ? 'reply' : 'replies'}
          </span>
          <span className="text-gray-500">Last reply {ago(m.thread.lastReplyAt)}</span>
        </a>
      )}

      {!m.deletedAt && !editing && (!inThread || mine) && (
        <div className="absolute -top-3 right-4 hidden items-center rounded-md border bg-white shadow-sm group-hover:flex">
          {!inThread && (
            <a href={href.conv(m.convId, m.id)} className="px-2 py-0.5 text-xs hover:bg-gray-100" title="Reply in thread">
              💬 Reply
            </a>
          )}
          {mine && (
            <>
              <button className="px-2 py-0.5 text-xs hover:bg-gray-100" onClick={() => setEditing(m.id)}>
                Edit
              </button>
              <button
                className="px-2 py-0.5 text-xs text-rose-600 hover:bg-gray-100"
                onClick={() => confirm('Delete this message? This can’t be undone.') && deleteMessage(m.id)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </Row>
  );
}

function EditBox({ m }: { m: Message }) {
  const [text, setText] = useState(m.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  const save = async () => {
    if (text.trim() && !isTooLong(text) && (await editMessage(m.id, text))) setEditing(null);
  };
  return (
    <div className="my-1 rounded-md border bg-white p-2">
      <textarea
        ref={ref}
        autoFocus
        className="w-full resize-none outline-none"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') setEditing(null);
        }}
      />
      <div className="flex items-center justify-end gap-2 text-xs">
        <span className="mr-auto">
          <LengthHint text={text} />
        </span>
        <button className="rounded border px-2 py-1" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <button className="rounded bg-[#007a5a] px-2 py-1 text-white disabled:opacity-40" disabled={isTooLong(text)} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

export function PendingItem({ p, showHeader }: { p: Pending; showHeader: boolean }) {
  const me = useStore((s) => s.me)!;
  return (
    <Row authorId={me.id} at={p.createdAt} showHeader={showHeader} dim={p.status === 'sending'}>
      <div className="whitespace-pre-wrap break-words leading-relaxed">
        <RichText text={p.text} />
      </div>
      {p.status === 'sending' ? (
        <div className="text-xs text-gray-400">Sending…</div>
      ) : (
        <div className="text-xs text-rose-600">
          Not sent.{' '}
          <button className="underline" onClick={() => deliverPending(p.clientMsgId)}>
            Retry
          </button>{' '}
          ·{' '}
          <button className="underline" onClick={() => discardPending(p.clientMsgId)}>
            Discard
          </button>
        </div>
      )}
    </Row>
  );
}

/** Slack-style grouping: consecutive messages by the same author within 5 minutes share a header. */
export function sameGroup(prev: { authorId: string; createdAt: number; deletedAt?: number | null } | undefined, next: { authorId: string; createdAt: number }) {
  return !!prev && !prev.deletedAt && prev.authorId === next.authorId && next.createdAt - prev.createdAt < 5 * 60_000 && new Date(prev.createdAt).toDateString() === new Date(next.createdAt).toDateString();
}

export function Divider({ label, red }: { label: string; red?: boolean }) {
  return (
    <div className={`my-2 flex items-center gap-2 px-5 text-xs font-semibold ${red ? 'text-rose-600' : 'text-gray-500'}`}>
      <div className={`h-px flex-1 ${red ? 'bg-rose-300' : 'bg-gray-200'}`} />
      {label}
      <div className={`h-px flex-1 ${red ? 'bg-rose-300' : 'bg-gray-200'}`} />
    </div>
  );
}
