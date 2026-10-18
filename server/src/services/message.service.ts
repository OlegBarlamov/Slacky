// The write path. Each method is one transaction over the core tables; the event describing
// the change is snapshotted inside it and published only after it commits.
import type { Conversation, Id, Message, MessagePage, ThreadView } from '../../../shared/types';
import type { DomainPublisher, MessageChanged } from '../events';
import type { Repositories } from '../repositories';
import type { MentionTarget } from '../repositories/message.repository';
import type { ConversationService } from './conversation.service';
import { AppError } from './errors';

export interface PostInput {
  clientMsgId: string;
  text: string;
  threadRootId?: Id | null;
}

const MAX_TEXT = 4000;
const PAGE_SIZE = 50;

export class MessageService {
  constructor(
    private readonly repos: Repositories,
    private readonly conversations: ConversationService,
    private readonly events: DomainPublisher,
  ) {}

  post(userId: Id, convId: Id, input: PostInput, at = Date.now()): Message {
    const { messages, conversations } = this.repos;
    return this.commit('message.created', () => {
      const conv = this.conversations.requireMember(userId, convId);
      if (!input.clientMsgId) throw new AppError('invalid', 'clientMsgId is required');
      // Idempotency: a retried POST returns the message created by the first attempt.
      const dup = messages.findByClientMsgId(userId, input.clientMsgId);
      if (dup) return { message: dup, event: null }; // already published by the first attempt

      const text = cleanText(input.text);
      const root = input.threadRootId ? this.get(input.threadRootId) : null;
      if (root && (root.convId !== convId || root.threadRootId || root.deletedAt)) throw new AppError('invalid', 'Invalid thread');

      // Top-level messages are numbered per conversation, replies per thread.
      const seq = root ? messages.nextReplySeq(root.id) : conversations.nextSeq(convId, at);
      const { channel, targets, joining } = this.parseMentions(conv, userId, text, !root);
      const id = messages.insert({ convId, threadRootId: root?.id ?? null, seq, authorId: userId, clientMsgId: input.clientMsgId, text, mentionsChannel: channel, createdAt: at });
      // Mentioned non-members join; a top-level mention starts their unread history at this message.
      for (const u of joining) conversations.join(convId, u, root ? null : seq - 1);
      messages.setMentions(id, targets, at);
      // Your own message is never unread for you.
      if (root) {
        messages.refreshThreadSummary(root.id, at);
        // The first reply starts the thread: in a DM everyone in it, in a channel the root's
        // author and the users the root mentions.
        if (seq === 1) messages.addThreadParticipants(root.id, conv.kind === 'dm' ? conv.memberIds : [root.authorId, ...userMentions(root)]);
        messages.addThreadParticipants(root.id, targets.map((t) => t.userId));
        messages.joinThread(root.id, userId, seq);
      } else {
        conversations.markRead(convId, userId, seq);
      }
      return this.changed(convId, id, null, root?.id ?? null, joining.length > 0);
    });
  }

  edit(userId: Id, id: Id, rawText: string, at = Date.now()): Message {
    const { messages } = this.repos;
    return this.commit('message.edited', () => {
      const m = this.own(userId, id);
      const text = cleanText(rawText);
      if (text === m.text) return { message: m, event: null };

      const conv = this.conversations.get(m.convId);
      const { channel, targets, joining } = this.parseMentions(conv, userId, text, !m.threadRootId);
      messages.updateText(id, text, channel, at);
      for (const u of joining) this.repos.conversations.join(m.convId, u, m.threadRootId ? null : m.seq - 1);
      messages.setMentions(id, targets, at);
      if (m.threadRootId) messages.addThreadParticipants(m.threadRootId, targets.map((t) => t.userId));
      return this.changed(m.convId, id, m, m.threadRootId, joining.length > 0);
    });
  }

  delete(userId: Id, id: Id, at = Date.now()): Message {
    const { messages } = this.repos;
    return this.commit('message.deleted', () => {
      const m = this.own(userId, id);
      if (m.thread) throw new AppError('conflict', "Messages with replies can't be deleted");
      // Soft delete: content is wiped, the row stays as a tombstone so ids never dangle.
      // Its mentions go too, so the feed and unread counts never see a deleted message.
      messages.markDeleted(id, at);
      messages.deleteMentions(id);
      if (m.threadRootId) messages.refreshThreadSummary(m.threadRootId, at);
      return this.changed(m.convId, id, m, m.threadRootId);
    });
  }

  /** A page of the channel timeline, ending before top-level `before` (or at the newest). */
  list(userId: Id, convId: Id, before: unknown): MessagePage {
    const cursor = before === undefined || before === '' ? null : Number(before);
    if (cursor !== null && !Number.isInteger(cursor)) throw new AppError('invalid', 'before must be an integer');
    this.conversations.requireMember(userId, convId);
    return this.repos.messages.listChannel(convId, cursor, PAGE_SIZE);
  }

  thread(userId: Id, rootId: Id): ThreadView {
    const root = this.repos.messages.get(rootId);
    if (!root || root.threadRootId) throw new AppError('not_found', 'Thread not found');
    this.conversations.requireMember(userId, root.convId);
    return { root, replies: this.repos.messages.listReplies(rootId) };
  }

  /** Marks the conversation read up to top-level `seq`. */
  markRead(userId: Id, convId: Id, seq: unknown) {
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new AppError('invalid', 'seq must be an integer');
    this.repos.transaction(() => {
      this.conversations.requireMember(userId, convId);
      this.repos.conversations.markRead(convId, userId, seq);
    });
  }

  /** Marks the thread read up to reply `seq`, for participants. */
  markThreadRead(userId: Id, rootId: Id, seq: unknown) {
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new AppError('invalid', 'seq must be an integer');
    this.repos.transaction(() => {
      const root = this.get(rootId);
      if (root.threadRootId) throw new AppError('invalid', 'Not a thread root');
      this.conversations.requireMember(userId, root.convId);
      this.repos.messages.markThreadRead(rootId, userId, seq);
    });
  }

  /** Marks the user's mentions on these messages read. Only touches the user's own rows. */
  markMentionsRead(userId: Id, messageIds: Id[], at = Date.now()) {
    if (!Array.isArray(messageIds) || !messageIds.every((x) => typeof x === 'string')) throw new AppError('invalid', 'messageIds must be strings');
    this.repos.transaction(() => this.repos.messages.markMentionsRead(userId, messageIds, at));
  }

  /**
   * Runs the write in a transaction, then publishes once committed: the conversation first if
   * mentions added members (so their clients know it before the message), then the message.
   */
  private commit(type: 'message.created' | 'message.edited' | 'message.deleted', write: () => Change) {
    const { message, event, membersChanged } = this.repos.transaction(write);
    if (event && membersChanged) this.events.publish('conversation.upserted', { conversation: event.conversation });
    if (event) this.events.publish(type, event);
    return message;
  }

  /** Snapshots the change inside the transaction, after all its writes. */
  private changed(convId: Id, id: Id, previous: Message | null, rootId: Id | null, membersChanged = false): Change {
    const message = this.get(id);
    const root = rootId ? this.get(rootId) : null;
    const threadParticipantIds = rootId ? this.repos.messages.threadParticipantIds(rootId) : [];
    return { message, event: { conversation: this.conversations.get(convId), message, previous, root, threadParticipantIds }, membersChanged };
  }

  private get(id: Id): Message {
    const m = this.repos.messages.get(id);
    if (!m) throw new AppError('not_found', 'Message not found');
    return m;
  }

  private own(userId: Id, id: Id): Message {
    const m = this.get(id);
    if (m.authorId !== userId) throw new AppError('forbidden', 'You can only change your own messages');
    if (m.deletedAt) throw new AppError('invalid', 'Message was deleted');
    return m;
  }

  /**
   * Resolves mentions to one target per user, author excluded.
   * - @name: in a channel, anyone (channels are open, so a mentioned non-member is `joining`);
   *   in a DM, only its members.
   * - @channel: top-level messages only, every member. In a reply it's plain text.
   */
  private parseMentions(conv: Conversation, authorId: Id, text: string, allowChannel: boolean) {
    const names = [...text.matchAll(/@([a-z0-9._-]+)/gi)].map((m) => m[1].toLowerCase().replace(/[._-]+$/, ''));
    const channel = allowChannel && names.includes('channel');
    const direct = new Set(
      this.repos.users.idsByName(names).filter((u) => u !== authorId && (conv.kind === 'channel' || conv.memberIds.includes(u))),
    );
    const joining = [...direct].filter((u) => !conv.memberIds.includes(u));
    const targets: MentionTarget[] = [...new Set([...conv.memberIds, ...joining])]
      .filter((u) => u !== authorId && (direct.has(u) || channel))
      .map((userId) => ({ userId, channelWide: !direct.has(userId) }));
    return { channel, targets, joining };
  }
}

interface Change {
  message: Message;
  event: MessageChanged | null;
  membersChanged?: boolean;
}

const userMentions = (m: Message) => m.mentions.flatMap((x) => (x.kind === 'user' ? [x.userId] : []));

function cleanText(raw: unknown) {
  const text = String(raw ?? '').trim();
  if (!text) throw new AppError('invalid', 'Message is empty');
  if (text.length > MAX_TEXT) throw new AppError('invalid', `Messages are limited to ${MAX_TEXT} characters`);
  return text;
}
