// API contract shared by the client and the (fake) server. Everything here crosses the
// "network" as JSON, so it must stay plain data.

export type Id = string;

export interface User {
  id: Id;
  name: string;
  createdAt: number;
}

export interface Conversation {
  id: Id;
  kind: 'channel' | 'dm';
  name: string | null; // null for DMs
  memberIds: Id[];
  createdAt: number;
}

export type Mention = { kind: 'user'; userId: Id } | { kind: 'channel' };

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: number;
  participantIds: Id[];
}

export interface Message {
  id: Id;
  clientMsgId: string; // idempotency key chosen by the sender
  convId: Id;
  seq: number; // per-conversation order, shared by top-level messages and replies
  authorId: Id;
  text: string; // emptied on delete
  mentions: Mention[];
  threadRootId: Id | null;
  thread: ThreadSummary | null; // set on roots that have replies
  version: number; // bumped on every change; clients and consumers drop older versions
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

/** A conversation as seen by one user. */
export interface ConversationView {
  conversation: Conversation;
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
}

export interface Bootstrap {
  me: User;
  users: User[]; // people in my conversations; anyone else comes from GET /users
  unreadThreadIds: Id[]; // threads I follow with unread replies from others
  conversations: ConversationView[];
  otherChannels: Conversation[]; // channels I could join
  streamCursor: number; // pass as Last-Event-ID so nothing between bootstrap and connect is lost
}

/** A contiguous slice of one timeline (a channel's top-level messages or a thread's replies), oldest first. */
export interface MessagePage {
  messages: Message[];
  hasBefore: boolean; // older messages exist outside the page
  hasAfter: boolean; // newer messages exist outside the page
}

export interface ThreadView {
  root: Message;
  replies: Message[]; // a page of them, like MessagePage
  hasBefore: boolean;
  hasAfter: boolean;
  lastReadSeq: number | null; // null when I'm not a participant
}

/** Read state after a read; the server only moves it forward. */
export interface ReadState {
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
}

export interface ThreadReadState {
  lastReadSeq: number | null; // null when I'm not a participant
  unreadCount: number;
}

/** A thread I follow, for the Threads view. */
export interface FollowedThread {
  root: Message;
  latestReplies: Message[]; // oldest first
  lastReadSeq: number;
  unreadCount: number; // replies by others after lastReadSeq
}

export interface ThreadList {
  threads: FollowedThread[]; // newest reply first
  nextCursor: string | null;
}

export type ActivityKind = 'mention' | 'dm' | 'thread';

export interface ActivityEntry {
  messageId: Id;
  authorId: Id;
  text: string;
  edited: boolean;
  at: number;
}

export interface ActivityItem {
  id: string; // group key, unique per user: `mention:<msg>`, `dm:<conv>`, `thread:<root>`
  kind: ActivityKind;
  convId: Id;
  threadRootId: Id | null;
  entries: ActivityEntry[]; // oldest first
  channelWide: boolean; // mention came from @channel
  state: 'active' | 'deleted' | 'retracted';
  read: boolean;
  updatedAt: number; // bumps only when something new happens, not on edits
}

export interface ConsumerStatus {
  name: string;
  pending: number;
  dlq: number;
  latencyMs: number;
  failureRate: number;
  offline: boolean;
}

export interface SentNotification {
  key: string;
  recipientId: Id;
  reason: 'mention' | 'dm';
  convId: Id;
  messageId: Id;
  text: string;
  sentAt: number;
}

export interface PipelineState {
  consumers: ConsumerStatus[];
  sent: SentNotification[];
}

export interface SearchResult {
  messages: Message[];
  total: number; // matches before the limit
}

export type StreamEvent =
  | {
      type: 'message.created' | 'message.edited' | 'message.deleted';
      message: Message;
      root: Message | null; // updated thread root when a reply changes its summary
    }
  | { type: 'conversation.upserted'; conversation: Conversation }
  | { type: 'activity.upserted'; item: ActivityItem }
  | { type: 'activity.removed'; itemId: string }
  | { type: 'resync' };

export const mentionsUser = (m: Message, userId: Id) =>
  m.mentions.some((x) => x.kind === 'channel' || x.userId === userId);
