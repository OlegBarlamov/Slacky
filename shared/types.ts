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
  users: User[];
  conversations: ConversationView[];
  otherChannels: Conversation[]; // channels I could join
  streamCursor: number; // pass as Last-Event-ID so nothing between bootstrap and connect is lost
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}

export interface ThreadView {
  root: Message;
  replies: Message[];
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
  channelWide: boolean; // mention came from @channel / @here
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
  pendingChanges: number; // events not yet applied to the index
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
