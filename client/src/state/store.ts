import { create } from 'zustand';
import {
  mentionsUser,
  type ActivityItem,
  type Bootstrap,
  type Conversation,
  type ConversationView,
  type Id,
  type Message,
  type MessagePage,
  type StreamEvent,
  type ThreadView,
  type User,
} from '@shared/types';
import { api, ApiError, setUnauthorizedHandler } from '../transport/api';
import { openStream } from '../transport/sse';
import { loadHidden, saveHidden } from './prefs';

export interface Pending {
  clientMsgId: string;
  convId: Id;
  threadRootId: Id | null;
  text: string;
  status: 'sending' | 'failed';
  createdAt: number;
}

interface State {
  status: 'loading' | 'anon' | 'ready';
  conn: 'connecting' | 'open' | 'reconnecting';
  me: User | null;
  users: Record<Id, User>;
  convs: Record<Id, ConversationView>;
  otherChannels: Conversation[];
  messages: Record<Id, Message>;
  timelines: Record<Id, { ids: Id[]; hasMore: boolean }>; // top-level messages per conversation
  threads: Record<Id, { replyIds: Id[] }>;
  activity: Record<string, ActivityItem>;
  pending: Record<string, Pending>; // optimistic sends, by clientMsgId
  viewingConvId: Id | null; // the open conversation; its new messages are read on arrival
  editingId: Id | null;
  toast: string | null;
  hidden: Record<Id, true>; // conversations hidden from the sidebar (client-only preference)
}

const blank: State = {
  status: 'loading',
  conn: 'connecting',
  me: null,
  users: {},
  convs: {},
  otherChannels: [],
  messages: {},
  timelines: {},
  threads: {},
  activity: {},
  pending: {},
  viewingConvId: null,
  editingId: null,
  toast: null,
  hidden: {},
};

export const useStore = create<State>()(() => blank);
const set = useStore.setState;
const get = useStore.getState;

const keyBy = <T,>(xs: T[], key: (x: T) => string) => Object.fromEntries(xs.map((x) => [key(x), x]));

const mergeIds = (ids: Id[], add: Id[], messages: Record<Id, Message>) =>
  [...new Set([...ids, ...add])].sort((a, b) => messages[a].seq - messages[b].seq);

export function toast(message: string) {
  set({ toast: message });
  setTimeout(() => set((s) => (s.toast === message ? { toast: null } : {})), 4000);
}

const toastError = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Network error, please try again');

// ---------- session & sync ----------

let lastEventId = 0;
let closeStream: (() => void) | null = null;

function signOutLocally() {
  closeStream?.();
  closeStream = null;
  requestedUsers.clear();
  set({ ...blank, status: 'anon' });
}
setUnauthorizedHandler(signOutLocally);

// Users who registered after our bootstrap aren't in `users`; fetch them the first time an
// id shows up. Each id is requested once (again only if the request failed on the network).
const requestedUsers = new Set<Id>();

function ensureUsers(ids: Iterable<Id>) {
  const { users } = get();
  for (const id of new Set(ids)) {
    if (users[id] || requestedUsers.has(id)) continue;
    requestedUsers.add(id);
    api<User>('GET', `/users/${id}`).then(
      (u) => set((s) => ({ users: { ...s.users, [u.id]: u } })),
      (e) => !(e instanceof ApiError && e.status === 404) && requestedUsers.delete(id),
    );
  }
}

const userIdsIn = (m: Message) => [m.authorId, ...m.mentions.flatMap((x) => (x.kind === 'user' ? [x.userId] : [])), ...(m.thread?.participantIds ?? [])];

export async function loadBootstrap() {
  try {
    const b = await api<Bootstrap>('GET', '/bootstrap');
    // Fetched after bootstrap so anything newer than the cursor is replayed by the stream.
    const { items } = await api<{ items: ActivityItem[] }>('GET', '/activity');
    lastEventId = b.streamCursor;
    set({
      status: 'ready',
      me: b.me,
      users: keyBy(b.users, (u) => u.id),
      hidden: loadHidden(b.me.id),
      convs: keyBy(b.conversations, (v) => v.conversation.id),
      otherChannels: b.otherChannels,
      activity: keyBy(items, (i) => i.id),
      messages: {},
      timelines: {},
      threads: {},
    });
    ensureUsers([...b.conversations.flatMap((v) => v.conversation.memberIds), ...items.flatMap((i) => i.entries.map((x) => x.authorId))]);
    if (!closeStream) connect();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // handler already showed login
    toast('Could not reach the server, retrying…');
    setTimeout(loadBootstrap, 2000);
  }
}

function connect() {
  set({ conn: 'connecting' });
  closeStream = openStream({
    lastEventId: () => lastEventId,
    onEvent: (id, event) => {
      if (id !== null) lastEventId = id;
      applyEvent(event);
    },
    onStatus: (conn) => set({ conn }),
    onUnauthorized: signOutLocally,
  });
}

export async function signIn(name: string, mode: 'login' | 'register') {
  await api('POST', `/auth/${mode}`, { name });
  set({ status: 'loading' });
  await loadBootstrap();
}

export async function signOut() {
  await api('POST', '/auth/logout').catch(() => {});
  signOutLocally();
}

function applyEvent(e: StreamEvent) {
  switch (e.type) {
    case 'resync':
      void loadBootstrap();
      return;
    case 'conversation.upserted':
      upsertConversation(e.conversation);
      return;
    case 'activity.upserted':
      set((s) => ({ activity: { ...s.activity, [e.item.id]: e.item } }));
      ensureUsers(e.item.entries.map((x) => x.authorId));
      return;
    case 'activity.removed':
      set((s) => {
        const activity = { ...s.activity };
        delete activity[e.itemId];
        return { activity };
      });
      return;
    default: {
      const prev = get().messages[e.message.id];
      const fresh = upsertMessages(e.root ? [e.root, e.message] : [e.message]);
      if (e.type === 'message.created' && fresh.includes(e.message)) countUnread(e.message);
      else if (e.type !== 'message.created') adjustUnread(prev, e.message);
    }
  }
}

/**
 * The single place messages enter the store, from HTTP responses and SSE alike. Ignores
 * anything not newer than what we have, so duplicates and out-of-order events are harmless.
 * Returns the messages that were seen for the first time.
 */
function upsertMessages(list: Message[]): Message[] {
  const fresh: Message[] = [];
  set((s) => {
    const messages = { ...s.messages };
    const timelines = { ...s.timelines };
    const threads = { ...s.threads };
    const pending = { ...s.pending };
    for (const m of list) {
      const cur = messages[m.id];
      if (cur && cur.version >= m.version) continue;
      if (!cur) fresh.push(m);
      messages[m.id] = m;
      if (m.authorId === s.me?.id) delete pending[m.clientMsgId];

      const tl = timelines[m.convId];
      if (tl) {
        const visible = !m.threadRootId && (!m.deletedAt || !!m.thread);
        const firstSeq = tl.ids.length ? messages[tl.ids[0]].seq : 0;
        const inLoadedRange = !tl.hasMore || m.seq >= firstSeq;
        const ids = visible ? (inLoadedRange ? mergeIds(tl.ids, [m.id], messages) : tl.ids) : tl.ids.filter((id) => id !== m.id);
        timelines[m.convId] = { ...tl, ids };
      }
      const th = m.threadRootId ? threads[m.threadRootId] : undefined;
      if (th) {
        const replyIds = m.deletedAt ? th.replyIds.filter((id) => id !== m.id) : mergeIds(th.replyIds, [m.id], messages);
        threads[m.threadRootId!] = { ...th, replyIds };
      }
    }
    return { messages, timelines, threads, pending };
  });
  ensureUsers(list.flatMap(userIdsIn));
  return fresh;
}

function countUnread(m: Message) {
  const { me, viewingConvId, convs } = get();
  if (!me || m.authorId === me.id || m.threadRootId || !convs[m.convId]) return;
  if (viewingConvId === m.convId && document.visibilityState === 'visible') return markConversationRead(m.convId);
  set((s) => {
    const v = s.convs[m.convId];
    const mention = mentionsUser(m, me.id) ? 1 : 0;
    return { convs: { ...s.convs, [m.convId]: { ...v, unreadCount: v.unreadCount + 1, mentionCount: v.mentionCount + mention } } };
  });
}

/**
 * Keeps unread/mention badges right when an unread message is deleted, or edited to add or
 * drop a mention of me. (The server's counts already skip deleted messages; this keeps the
 * live badge in line without a reload.)
 */
function adjustUnread(prev: Message | undefined, m: Message) {
  const { me, convs } = get();
  const v = convs[m.convId];
  if (!me || !v || m.threadRootId || m.authorId === me.id || m.seq <= v.lastReadSeq || prev?.deletedAt) return;
  const unreadDelta = m.deletedAt ? -1 : 0;
  // Without the previous version we can't tell whether it mentioned me, so leave mentions alone.
  const mentionDelta = prev ? Number(!m.deletedAt && mentionsUser(m, me.id)) - Number(mentionsUser(prev, me.id)) : 0;
  if (!unreadDelta && !mentionDelta) return;
  set((s) => {
    const cur = s.convs[m.convId];
    const unreadCount = Math.max(0, cur.unreadCount + unreadDelta);
    const mentionCount = Math.min(unreadCount, Math.max(0, cur.mentionCount + mentionDelta));
    return { convs: { ...s.convs, [m.convId]: { ...cur, unreadCount, mentionCount } } };
  });
}

function upsertConversation(c: Conversation, view?: ConversationView) {
  const me = get().me;
  if (!me) return;
  ensureUsers(c.memberIds);
  set((s) => {
    const convs = { ...s.convs };
    let otherChannels = s.otherChannels.filter((x) => x.id !== c.id);
    if (c.memberIds.includes(me.id)) {
      convs[c.id] = view ?? (convs[c.id] ? { ...convs[c.id], conversation: c } : { conversation: c, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 });
    } else {
      delete convs[c.id]; // left (or was never in it)
      if (c.kind === 'channel') otherChannels = [...otherChannels, c];
    }
    return { convs, otherChannels };
  });
}

// ---------- reads ----------


/** Opening a conversation also brings it back into the sidebar if it was hidden. */
export function setViewing(viewingConvId: Id | null) {
  set({ viewingConvId });
  if (viewingConvId) setHidden(viewingConvId, false);
}

export function setHidden(convId: Id, hide: boolean) {
  const { me, hidden } = get();
  if (!me || !!hidden[convId] === hide) return;
  const next = { ...hidden };
  if (hide) next[convId] = true;
  else delete next[convId];
  set({ hidden: next });
  saveHidden(me.id, next);
}

export async function loadTimeline(convId: Id, older = false) {
  const s = get();
  const cur = s.timelines[convId];
  const before = older && cur?.ids.length ? s.messages[cur.ids[0]].seq : null;
  try {
    const page = await api<MessagePage>('GET', `/conversations/${convId}/messages${before ? `?before=${before}` : ''}`);
    upsertMessages(page.messages);
    set((st) => {
      const tl = st.timelines[convId];
      const ids = mergeIds(tl?.ids ?? [], page.messages.map((m) => m.id), st.messages);
      return { timelines: { ...st.timelines, [convId]: { ids, hasMore: older || !tl ? page.hasMore : tl.hasMore } } };
    });
  } catch (e) {
    toastError(e);
  }
}

export async function loadThread(rootId: Id) {
  try {
    const t = await api<ThreadView>('GET', `/threads/${rootId}`);
    upsertMessages([t.root, ...t.replies]);
    set((s) => ({
      threads: {
        ...s.threads,
        [rootId]: { replyIds: mergeIds(s.threads[rootId]?.replyIds ?? [], t.replies.map((r) => r.id), s.messages) },
      },
    }));
  } catch (e) {
    toastError(e);
  }
}

export function markConversationRead(convId: Id) {
  const s = get();
  const view = s.convs[convId];
  const ids = s.timelines[convId]?.ids;
  if (!view || !ids) return;
  if (!ids.length) {
    // Nothing left to read (e.g. the only message was deleted): just clear the badge.
    if (view.unreadCount || view.mentionCount) set((st) => ({ convs: { ...st.convs, [convId]: { ...view, unreadCount: 0, mentionCount: 0 } } }));
    return;
  }
  const seq = s.messages[ids[ids.length - 1]].seq;
  if (view.unreadCount || view.mentionCount || view.lastReadSeq < seq) {
    set((st) => ({ convs: { ...st.convs, [convId]: { ...view, unreadCount: 0, mentionCount: 0, lastReadSeq: Math.max(view.lastReadSeq, seq) } } }));
    void api('POST', `/conversations/${convId}/read`, { seq }).catch(() => {});
  }
  // Seeing the channel covers mentions and DMs in it; thread items stay until the thread is seen.
  markActivityRead(Object.values(s.activity).filter((i) => i.convId === convId && !i.threadRootId).map((i) => i.id));
}

export function markThreadRead(rootId: Id) {
  markActivityRead(Object.values(get().activity).filter((i) => i.threadRootId === rootId).map((i) => i.id));
}

export function markActivityRead(ids: string[]) {
  const { activity } = get();
  const unread = ids.filter((id) => activity[id] && !activity[id].read);
  if (!unread.length) return;
  set((s) => {
    const next = { ...s.activity };
    for (const id of unread) next[id] = { ...next[id], read: true };
    return { activity: next };
  });
  void api('POST', '/activity/read', { ids: unread }).catch(() => {});
}

// ---------- writes ----------

export function sendMessage(convId: Id, text: string, threadRootId: Id | null = null) {
  const clientMsgId = crypto.randomUUID();
  const p: Pending = { clientMsgId, convId, threadRootId, text, status: 'sending', createdAt: Date.now() };
  set((s) => ({ pending: { ...s.pending, [clientMsgId]: p } }));
  void deliverPending(clientMsgId);
}

/** Sends (or re-sends) an optimistic message. Same clientMsgId, so retries never duplicate. */
export async function deliverPending(clientMsgId: string) {
  const p = get().pending[clientMsgId];
  if (!p) return;
  const patch = (status: Pending['status']) =>
    set((s) => (s.pending[clientMsgId] ? { pending: { ...s.pending, [clientMsgId]: { ...s.pending[clientMsgId], status } } } : {}));
  patch('sending');
  try {
    const { convId, text, threadRootId } = p;
    const m = await api<Message>('POST', `/conversations/${convId}/messages`, { clientMsgId, text, threadRootId });
    upsertMessages([m]);
    discardPending(clientMsgId);
  } catch (e) {
    if (e instanceof ApiError) toastError(e);
    patch('failed');
  }
}

export function discardPending(clientMsgId: string) {
  set((s) => {
    const pending = { ...s.pending };
    delete pending[clientMsgId];
    return { pending };
  });
}

async function mutate(request: () => Promise<Message>) {
  try {
    upsertMessages([await request()]);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export const editMessage = (id: Id, text: string) => mutate(() => api<Message>('PATCH', `/messages/${id}`, { text }));
export const deleteMessage = (id: Id) => mutate(() => api<Message>('DELETE', `/messages/${id}`));

export const setEditing = (editingId: Id | null) => set({ editingId });

async function conversationRequest(method: string, path: string, body?: unknown) {
  try {
    const view = await api<ConversationView>(method, path, body);
    upsertConversation(view.conversation, view);
    setHidden(view.conversation.id, false);
    return view.conversation;
  } catch (e) {
    toastError(e);
    return null;
  }
}

export const createChannel = (name: string) => conversationRequest('POST', '/conversations', { name });
export const joinChannel = (convId: Id) => conversationRequest('POST', `/conversations/${convId}/join`);
export const openDm = (userId: Id) => conversationRequest('POST', '/dms', { userId });
