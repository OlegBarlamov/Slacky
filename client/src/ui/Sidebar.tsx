import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Route } from '../state/route';
import { href, navigate } from '../state/route';
import { setHidden, signOut, useStore } from '../state/store';
import { Avatar } from './Avatar';
import { conversationName } from './format';
import { ChannelModal, NewDmModal } from './NewConversation';

const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const WIDTH_KEY = 'slacky-sidebar-width';
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

function Item(props: { to: string; active: boolean; bold?: boolean; badge?: number; icon?: ReactNode; onHide?: () => void; children: ReactNode }) {
  const { active, bold, badge, onHide } = props;
  return (
    <div
      className={`group mx-2 flex items-center rounded-md ${
        active ? 'bg-[#1164a3] text-white' : bold ? 'font-bold text-white hover:bg-white/10' : 'text-white/70 hover:bg-white/10'
      }`}
    >
      <a href={props.to} className="flex min-w-0 flex-1 items-center justify-between py-1 pl-3 pr-1">
        {props.icon && <span className="mr-2 shrink-0">{props.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{props.children}</span>
        {!!badge && <span className="ml-2 shrink-0 rounded-full bg-rose-600 px-1.5 text-xs font-bold text-white">{badge}</span>}
      </a>
      {onHide && (
        <button className="invisible mr-1 shrink-0 rounded px-1 text-white/60 hover:bg-white/20 hover:text-white group-hover:visible" title="Hide from sidebar" onClick={onHide}>
          ×
        </button>
      )}
      {!onHide && <span className="w-2" />}
    </div>
  );
}

function SectionHeader({ label, onAdd, addTitle }: { label: string; onAdd: () => void; addTitle: string }) {
  return (
    <div className="mt-4 flex items-center justify-between px-5 pb-1 text-sm text-white/60">
      <span className="min-w-0 truncate">{label}</span>
      <button className="shrink-0 rounded px-1 hover:bg-white/10" title={addTitle} onClick={onAdd}>
        +
      </button>
    </div>
  );
}

export function Sidebar({ route }: { route: Route }) {
  const convs = useStore((s) => s.convs);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const hidden = useStore((s) => s.hidden);
  const unreadActivity = useStore((s) => Object.values(s.activity).filter((i) => !i.read).length);
  const unreadThreads = useStore((s) => Object.keys(s.unreadThreads).length);
  const [dialog, setDialog] = useState<'channel' | 'dm' | null>(null);
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 256));

  // Drag the right edge to resize within [MIN_WIDTH, MAX_WIDTH]; the width is remembered.
  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    const startX = e.clientX;
    const startWidth = width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => setWidth(clampWidth(startWidth + ev.clientX - startX));
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      localStorage.setItem(WIDTH_KEY, String(clampWidth(startWidth + ev.clientX - startX)));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  const activeConv = route.name === 'conv' ? route.convId : null;
  // Hidden conversations come back while open or when something needs you (DM unread, channel mention).
  const views = Object.values(convs).filter(
    (v) => !hidden[v.conversation.id] || v.conversation.id === activeConv || (v.conversation.kind === 'dm' ? v.unreadCount : v.mentionCount) > 0,
  );

  function hide(convId: string) {
    setHidden(convId, true);
    if (convId === activeConv) navigate('#/');
  }

  const channels = views.filter((v) => v.conversation.kind === 'channel').sort((a, b) => a.conversation.name!.localeCompare(b.conversation.name!));
  const dms = views
    .filter((v) => v.conversation.kind === 'dm')
    .map((v) => ({ v, name: conversationName(v.conversation, users, me.id), other: v.conversation.memberIds.find((id) => id !== me.id) ?? me.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav className="relative flex shrink-0 flex-col bg-[#3f0e40] text-[15px]" style={{ width }}>
      <div
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-sky-500/50"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(256);
          localStorage.removeItem(WIDTH_KEY);
        }}
        title="Drag to resize · double-click to reset"
      />
      <div className="flex h-12 items-center border-b border-white/10 px-5 font-bold text-white">
        <span className="min-w-0 truncate">Slacky</span>
      </div>
      <div className="flex-1 overflow-y-auto py-3">
        <Item to={href.activity()} active={route.name === 'activity'} bold={unreadActivity > 0} badge={unreadActivity}>
          🔔 Activity
        </Item>
        <Item to={href.threads()} active={route.name === 'threads'} bold={unreadThreads > 0} badge={unreadThreads}>
          🧵 Threads
        </Item>

        <SectionHeader label="Channels" onAdd={() => setDialog('channel')} addTitle="Join or create a channel" />
        {channels.map(({ conversation: c, unreadCount, mentionCount }) => (
          <Item key={c.id} to={href.conv(c.id)} active={activeConv === c.id} bold={unreadCount > 0} badge={mentionCount} onHide={() => hide(c.id)}>
            # {c.name}
          </Item>
        ))}

        <SectionHeader label="Direct messages" onAdd={() => setDialog('dm')} addTitle="New message" />
        {dms.map(({ v, name, other }) => (
          <Item
            key={v.conversation.id}
            to={href.conv(v.conversation.id)}
            active={activeConv === v.conversation.id}
            bold={v.unreadCount > 0}
            badge={v.unreadCount}
            onHide={() => hide(v.conversation.id)}
            icon={<Avatar user={users[other]} size={20} />}
          >
            {name}
          </Item>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3 text-white">
        <Avatar user={me} size={28} />
        <span className="flex-1 truncate font-semibold">{me.name}</span>
        <button className="text-xs text-white/60 hover:text-white" onClick={signOut}>
          Sign out
        </button>
      </div>
      {dialog === 'channel' && <ChannelModal onClose={() => setDialog(null)} />}
      {dialog === 'dm' && <NewDmModal onClose={() => setDialog(null)} />}
    </nav>
  );
}
