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
  type ReadState,
  type StreamEvent,
  type ThreadReadState,
  type ThreadView,
  type User,
} from '@shared/types';
import { api, ApiError, setUnauthorizedHandler } from '../transport/api';
import { openStream } from '../transport/sse';
import { loadHidden, saveHidden } from './prefs';
import { convKey, extendWindow, placeMessage, replaceWindow, threadKey, touch, unreferenced, type TimelineKey, type Window } from './windows';

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
  messages: Record<Id, Message>; // only messages some window holds (plus thread roots)
  windows: Partial<Record<TimelineKey, Window>>; // loaded slice per channel / thread
  lru: TimelineKey[]; // most recently opened first; windows past CACHE_SIZE are dropped
  threadReads: Record<Id, number | null>; // my read position in each loaded thread; null = not following
  unreadThreads: Record<Id, true>; // followed threads with unread replies: the Threads badge
  threadsVersion: number; // bumps when a followed thread may have changed; the Threads view refetches
  activity: Record<string, ActivityItem>;
  pending: Record<string, Pending>; // optimistic sends, by clientMsgId
  viewingConvId: Id | null; // the open conversation
  following: TimelineKey | null; // a visible list sitting at its live bottom: new messages there are read on arrival
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
  windows: {},
  lru: [],
  threadReads: {},
  unreadThreads: {},
  threadsVersion: 0,
  activity: {},
  pending: {},
  viewingConvId: null,
  following: null,
  editingId: null,
  toast: null,
  hidden: {},
};

export const useStore = create<State>()(() => blank);
const set = useStore.setState;
const get = useStore.getState;

const keyBy = <T,>(xs: T[], key: (x: T) => string) => Object.fromEntries(xs.map((x) => [key(x), x]));

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
      unreadThreads: Object.fromEntries(b.unreadThreadIds.map((id) => [id, true as const])),
      messages: {},
      windows: {},
      lru: [],
      threadReads: {},
    });
    counted.clear();
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
      if (e.item.kind === 'thread' && e.item.threadRootId) {
        setThreadUnread(e.item.threadRootId, !e.item.read);
        // A thread item means I'm in the thread now (I replied, or was mentioned), though it may
        // have opened while I wasn't. 0 is a safe floor: the server only moves reads forward.
        const rootId = e.item.threadRootId;
        if (get().threadReads[rootId] === null) set((s) => ({ threadReads: { ...s.threadReads, [rootId]: 0 } }));
      }
      ensureUsers(e.item.entries.map((x) => x.authorId));
      return;
    case 'activity.removed':
      set((s) => {
        const activity = { ...s.activity };
        delete activity[e.itemId];
        return { activity };
      });
      if (e.itemId.startsWith('thread:')) setThreadUnread(e.itemId.slice('thread:'.length), false);
      return;
    default: {
      const prev = get().messages[e.message.id];
      upsertMessages(e.root ? [e.root, e.message] : [e.message]);
      if (e.type === 'message.created') countUnread(e.message);
      else adjustUnread(prev, e.message);
      if (e.message.threadRootId || e.message.thread) set((s) => ({ threadsVersion: s.threadsVersion + 1 }));
    }
  }
}

function setThreadUnread(rootId: Id, unread: boolean) {
  set((s) => {
    if (!!s.unreadThreads[rootId] === unread) return { threadsVersion: s.threadsVersion + 1 };
    const unreadThreads = { ...s.unreadThreads };
    if (unread) unreadThreads[rootId] = true;
    else delete unreadThreads[rootId];
    return { unreadThreads, threadsVersion: s.threadsVersion + 1 };
  });
}

/** The window a message belongs to, and whether it shows there (deleted ones don't). */
function placement(m: Message): { key: TimelineKey; visible: boolean } {
  return m.threadRootId ? { key: threadKey(m.threadRootId), visible: !m.deletedAt } : { key: convKey(m.convId), visible: !m.deletedAt || !!m.thread };
}

/**
 * The single place messages enter the store, from HTTP responses and SSE alike. Ignores
 * anything not newer than what we have, so duplicates and out-of-order events are harmless.
 * A message is kept only where a window shows it (or it roots a loaded thread); anything
 * else only moves badges and the feed.
 */
function upsertMessages(list: Message[]) {
  let trimmed = false;
  set((s) => {
    const messages = { ...s.messages };
    const windows = { ...s.windows };
    const pending = { ...s.pending };
    for (const m of list) {
      if (m.authorId === s.me?.id) delete pending[m.clientMsgId];
      const cur = messages[m.id];
      if (cur && cur.version >= m.version) continue;
      const { key, visible } = placement(m);
      const w = windows[key];
      const placed = w && placeMessage(w, m, visible, (id) => (id === m.id ? m.seq : messages[id].seq));
      if (w && placed !== w) {
        windows[key] = placed;
        trimmed ||= placed!.firstIndex > w.firstIndex;
      }
      if (cur || placed?.ids.includes(m.id) || windows[threadKey(m.id)]) messages[m.id] = m;
    }
    return { messages, windows, pending };
  });
  if (trimmed) collectGarbage();
  ensureUsers(list.flatMap(userIdsIn));
}

/** Stores messages from a page whose window is set separately; same version guard. */
function storeMessages(list: Message[]) {
  set((s) => {
    const messages = { ...s.messages };
    for (const m of list) if (!messages[m.id] || messages[m.id].version < m.version) messages[m.id] = m;
    return { messages };
  });
  ensureUsers(list.flatMap(userIdsIn));
}

/** Drops messages no window references any more. */
function collectGarbage() {
  set((s) => {
    const gone = unreferenced(s.messages, s.windows);
    if (!gone.length) return {};
    const messages = { ...s.messages };
    for (const id of gone) delete messages[id];
    return { messages };
  });
}

// Messages already counted toward unread badges, so a redelivered event doesn't count twice.
// Bounded: only recent events can be redelivered.
const counted = new Set<Id>();
function firstCount(id: Id) {
  if (counted.has(id)) return false;
  counted.add(id);
  if (counted.size > 2000) counted.delete(counted.values().next().value!);
  return true;
}

function countUnread(m: Message) {
  const { me, following, convs } = get();
  if (!me || m.authorId === me.id || m.threadRootId || !convs[m.convId] || !firstCount(m.id)) return;
  countsChanged.set(m.convId, (countsChanged.get(m.convId) ?? 0) + 1);
  // Someone watching the bottom of this channel sees it arrive.
  if (following === convKey(m.convId) && document.visibilityState === 'visible') return markReadUpTo(m.convId, m.seq);
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

export const setFollowing = (following: TimelineKey | null) => set({ following });

export function setHidden(convId: Id, hide: boolean) {
  const { me, hidden } = get();
  if (!me || !!hidden[convId] === hide) return;
  const next = { ...hidden };
  if (hide) next[convId] = true;
  else delete next[convId];
  set({ hidden: next });
  saveHidden(me.id, next);
}

/** Where a window opens: around a message, at my first unread, or at the newest. */
export type WindowTarget = { around: Id } | { firstUnread: true } | { latest: true };

const pageQuery = (target: WindowTarget) =>
  'around' in target ? `?around=${encodeURIComponent(target.around)}` : 'firstUnread' in target ? '?anchor=first_unread' : '';

async function fetchPage(key: TimelineKey, query: string): Promise<{ page: MessagePage; root?: Message; lastReadSeq?: number | null }> {
  const id = key.slice(2);
  if (key.startsWith('c:')) return { page: await api<MessagePage>('GET', `/conversations/${id}/messages${query}`) };
  const t = await api<ThreadView>('GET', `/threads/${id}${query}`);
  return { page: { messages: t.replies, hasBefore: t.hasBefore, hasAfter: t.hasAfter }, root: t.root, lastReadSeq: t.lastReadSeq };
}

/** Marks `key` recently used; windows that fall out of the cache are dropped with their messages. */
function touchWindow(key: TimelineKey) {
  const { lru, evicted } = touch(get().lru, key);
  set((s) => {
    const windows = { ...s.windows };
    for (const k of evicted) delete windows[k];
    return { lru, windows };
  });
  if (evicted.length) collectGarbage();
}

/** Loads a window from scratch (first open, or a jump outside the loaded one). */
export async function openWindow(key: TimelineKey, target: WindowTarget) {
  try {
    const { page, root, lastReadSeq } = await fetchPage(key, pageQuery(target));
    set((s) => ({
      windows: { ...s.windows, [key]: replaceWindow(page, s.windows[key]) },
      ...(lastReadSeq !== undefined && { threadReads: { ...s.threadReads, [key.slice(2)]: lastReadSeq } }),
    }));
    storeMessages(root ? [root, ...page.messages] : page.messages);
    touchWindow(key);
    collectGarbage(); // what the replaced window held
  } catch (e) {
    toastError(e);
  }
}

const loadingMore = new Set<string>();

/** Loads the page above (`before`) or below (`after`) the window, if there is one. */
export async function loadMore(key: TimelineKey, side: 'before' | 'after') {
  const s = get();
  const w = s.windows[key];
  if (!w || !w.ids.length || !(side === 'before' ? w.hasBefore : w.hasAfter) || loadingMore.has(`${key}:${side}`)) return;
  loadingMore.add(`${key}:${side}`);
  try {
    const edge = s.messages[side === 'before' ? w.ids[0] : w.ids[w.ids.length - 1]].seq;
    const { page } = await fetchPage(key, `?${side}=${edge}`);
    storeMessages(page.messages);
    set((st) => {
      const cur = st.windows[key];
      if (!cur || cur.generation !== w.generation) return {}; // replaced meanwhile
      return { windows: { ...st.windows, [key]: extendWindow(cur, page, side) } };
    });
    collectGarbage();
  } catch (e) {
    toastError(e);
  } finally {
    loadingMore.delete(`${key}:${side}`);
  }
}

/** Reopening a cached window at the live edge: fetch what arrived while the stream was away. */
export function refreshWindow(key: TimelineKey) {
  touchWindow(key);
  const w = get().windows[key];
  if (w && !w.hasAfter && w.ids.length) {
    set((s) => ({ windows: { ...s.windows, [key]: { ...w, hasAfter: true } } }));
    void loadMore(key, 'after');
  }
}

// Read positions go to the server at most every READ_DELAY per timeline, with the highest seq seen.
const READ_DELAY = 300;
const readQueue = new Map<TimelineKey, { seq: number; timer: ReturnType<typeof setTimeout> }>();
const countsChanged = new Map<Id, number>(); // live unread counts per conversation, to spot stale read responses

function queueRead(key: TimelineKey, seq: number, send: (seq: number) => Promise<void>) {
  const queued = readQueue.get(key);
  if (queued && queued.seq >= seq) return;
  if (queued) clearTimeout(queued.timer);
  readQueue.set(key, {
    seq,
    timer: setTimeout(() => {
      readQueue.delete(key);
      void send(seq).catch(() => {});
    }, READ_DELAY),
  });
}

/** Mention items for messages I've now seen: they're read by their own flag. */
function seenMentions(match: (i: ActivityItem) => boolean, upToSeq: number) {
  const { activity, messages } = get();
  return Object.values(activity)
    .filter((i) => i.kind === 'mention' && !i.read && match(i))
    .filter((i) => {
      const m = messages[i.entries[0]?.messageId];
      return m && m.seq <= upToSeq;
    })
    .map((i) => i.id);
}

/**
 * Marks the conversation read up to top-level `seq`: the highest one actually scrolled into
 * view, not the end of the loaded window. Badges update at once; the server's answer settles them.
 */
export function markReadUpTo(convId: Id, seq: number) {
  const s = get();
  const view = s.convs[convId];
  const w = s.windows[convKey(convId)];
  if (!view || !s.me) return;
  const me = s.me;
  const lastSeq = w?.ids.length ? s.messages[w.ids[w.ids.length - 1]].seq : 0;
  const caughtUp = !!w && !w.hasAfter && seq >= lastSeq;
  if (seq > view.lastReadSeq || (caughtUp && (view.unreadCount || view.mentionCount))) {
    const nowRead = (w?.ids ?? []).map((id) => s.messages[id]).filter((m) => m.authorId !== me.id && m.seq > view.lastReadSeq && m.seq <= seq);
    const unreadCount = caughtUp ? 0 : Math.max(0, view.unreadCount - nowRead.length);
    const mentionCount = caughtUp ? 0 : Math.max(0, view.mentionCount - nowRead.filter((m) => mentionsUser(m, me.id)).length);
    const lastReadSeq = Math.max(view.lastReadSeq, seq);
    set((st) => ({ convs: { ...st.convs, [convId]: { ...st.convs[convId], lastReadSeq, unreadCount, mentionCount } } }));
    if (seq > view.lastReadSeq) {
      queueRead(convKey(convId), seq, async (sent) => {
        const before = countsChanged.get(convId) ?? 0;
        const r = await api<ReadState>('POST', `/conversations/${convId}/read`, { seq: sent });
        // A live message counted meanwhile isn't in this answer; keep the local count then.
        if ((countsChanged.get(convId) ?? 0) !== before) return;
        set((st) => {
          const cur = st.convs[convId];
          return cur && r.lastReadSeq >= cur.lastReadSeq ? { convs: { ...st.convs, [convId]: { ...cur, ...r } } } : {};
        });
      });
    }
  }
  // Seeing a message covers its mention; a DM item is read once the DM is.
  const dmItem = caughtUp ? Object.values(s.activity).filter((i) => i.kind === 'dm' && i.convId === convId).map((i) => i.id) : [];
  markActivityRead([...seenMentions((i) => i.convId === convId && !i.threadRootId, seq), ...dmItem]);
}

/** Marks the thread read up to reply `seq` (participants only, server side), like markReadUpTo. */
export function markThreadReadUpTo(rootId: Id, seq: number) {
  const s = get();
  const lastRead = s.threadReads[rootId];
  markActivityRead(seenMentions((i) => i.threadRootId === rootId, seq));
  if (lastRead === null || lastRead === undefined || seq <= lastRead) return;
  set((st) => ({ threadReads: { ...st.threadReads, [rootId]: seq } }));
  queueRead(threadKey(rootId), seq, async (sent) => {
    const r = await api<ThreadReadState>('POST', `/threads/${rootId}/read`, { seq: sent });
    setThreadUnread(rootId, r.unreadCount > 0);
    // The thread's feed item follows the read position on the server; mirror it.
    if (r.unreadCount === 0)
      set((st) => {
        const item = st.activity[`thread:${rootId}`];
        return item && !item.read ? { activity: { ...st.activity, [item.id]: { ...item, read: true } } } : {};
      });
  });
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
  for (const id of unread) if (id.startsWith('thread:')) setThreadUnread(id.slice('thread:'.length), false);
  void api('POST', '/activity/read', { ids: unread }).catch(() => {});
}

/** People whose name starts with `prefix`, members of `convId` first; they join `users` too. */
export async function searchUsers(prefix: string, convId: Id | null, limit = 8): Promise<User[]> {
  const params = new URLSearchParams({ q: prefix, limit: String(limit), ...(convId && { convId }) });
  const found = await api<User[]>('GET', `/users?${params}`);
  set((s) => ({ users: { ...s.users, ...keyBy(found, (u) => u.id) } }));
  return found;
}

// ---------- writes ----------

export function sendMessage(convId: Id, text: string, threadRootId: Id | null = null) {
  // Sending from far up the history: go to the newest, where the message will show.
  const key = threadRootId ? threadKey(threadRootId) : convKey(convId);
  if (get().windows[key]?.hasAfter) void openWindow(key, { latest: true });
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
