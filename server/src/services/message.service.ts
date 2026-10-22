// The write path. Each method is one transaction over the core tables; the event describing
// the change is snapshotted and published inside it, so it commits with the change or not at all.
import type { Conversation, Id, Message, MessagePage, ReadState, ThreadReadState, ThreadView } from '../../../shared/types';
import type { DomainPublisher, MessageChanged } from '../events';
import type { Repositories } from '../repositories';
import { isUniqueViolation } from '../repositories/db';
import type { MentionTarget, PageCursor, Timeline } from '../repositories/message.repository';
import type { ConversationService } from './conversation.service';
import { AppError } from './errors';

export interface PostInput {
  clientMsgId: string;
  text: string;
  threadRootId?: Id | null;
}

/** `?before= | after= | around=<message id> | anchor=first_unread`, at most one, and `limit`. */
export interface PageParams {
  before?: unknown;
  after?: unknown;
  around?: unknown;
  anchor?: unknown;
  limit?: unknown;
}

type Position = PageCursor | { aroundId: Id } | { firstUnread: true };

const MAX_TEXT = 4000;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export class MessageService {
  constructor(
    private readonly repos: Repositories,
    private readonly conversations: ConversationService,
    private readonly events: DomainPublisher,
  ) {}

  async post(userId: Id, convId: Id, input: PostInput, at = Date.now()): Promise<Message> {
    const { messages, conversations } = this.repos;
    const write = () =>
      this.commit('message.created', async () => {
        const conv = await this.conversations.requireMember(userId, convId);
        if (!input.clientMsgId) throw new AppError('invalid', 'clientMsgId is required');
        // Idempotency: a retried POST returns the message created by the first attempt.
        const dup = await messages.findByClientMsgId(userId, input.clientMsgId);
        if (dup) return { message: dup, event: null }; // already published by the first attempt

        const text = cleanText(input.text);
        // Locking the root keeps a concurrent delete from removing it under the first reply.
        const root = input.threadRootId ? await this.get(input.threadRootId, true) : null;
        if (root && (root.convId !== convId || root.threadRootId || root.deletedAt)) throw new AppError('invalid', 'Invalid thread');

        // Top-level messages are numbered per conversation, replies per thread.
        const seq = root ? await messages.nextReplySeq(root.id) : await conversations.nextSeq(convId, at);
        const { channel, targets, joining } = await this.parseMentions(conv, userId, text, !root);
        const id = await messages.insert({ convId, threadRootId: root?.id ?? null, seq, authorId: userId, clientMsgId: input.clientMsgId, text, mentionsChannel: channel, createdAt: at });
        // Mentioned non-members join; a top-level mention starts their unread history at this message.
        for (const u of joining) await conversations.join(convId, u, root ? null : seq - 1);
        await messages.setMentions(id, targets, at);
        // Your own message is never unread for you.
        if (root) {
          await messages.refreshThreadSummary(root.id, at);
          // The first reply starts the thread: in a DM everyone in it, in a channel the root's
          // author and the users the root mentions.
          if (seq === 1) await messages.addThreadParticipants(root.id, conv.kind === 'dm' ? conv.memberIds : [root.authorId, ...userMentions(root)]);
          await messages.addThreadParticipants(root.id, targets.map((t) => t.userId));
          await messages.joinThread(root.id, userId, seq);
        } else {
          await conversations.markRead(convId, userId, seq);
        }
        return this.changed(convId, id, null, root?.id ?? null, joining.length > 0);
      });
    try {
      return await write();
    } catch (err) {
      // The same POST raced itself (a client retry while the first attempt was in flight): the
      // other one committed first, so running again finds and returns its message.
      if (isUniqueViolation(err, 'messages_author_client_msg_id')) return write();
      throw err;
    }
  }

  async edit(userId: Id, id: Id, rawText: string, at = Date.now()): Promise<Message> {
    const { messages } = this.repos;
    return this.commit('message.edited', async () => {
      const m = await this.own(userId, id);
      const text = cleanText(rawText);
      if (text === m.text) return { message: m, event: null };

      const conv = await this.conversations.get(m.convId);
      const { channel, targets, joining } = await this.parseMentions(conv, userId, text, !m.threadRootId);
      await messages.updateText(id, text, channel, at);
      for (const u of joining) await this.repos.conversations.join(m.convId, u, m.threadRootId ? null : m.seq - 1);
      await messages.setMentions(id, targets, at);
      // Mentioned by name in a reply, or in a root that already has replies: they're in the thread now.
      const rootId = m.threadRootId ?? (m.thread ? m.id : null);
      if (rootId) await messages.addThreadParticipants(rootId, targets.filter((t) => !t.channelWide).map((t) => t.userId));
      return this.changed(m.convId, id, m, m.threadRootId, joining.length > 0);
    });
  }

  async delete(userId: Id, id: Id, at = Date.now()): Promise<Message> {
    const { messages } = this.repos;
    return this.commit('message.deleted', async () => {
      // Locked, so a first reply can't land between the check and the delete (post locks it too).
      const m = await this.own(userId, id);
      if (m.thread) throw new AppError('conflict', "Messages with replies can't be deleted");
      // Lock the root before recounting, so the summary sees replies that committed meanwhile.
      if (m.threadRootId) await this.get(m.threadRootId, true);
      // Soft delete: content is wiped, the row stays as a tombstone so ids never dangle.
      // Its mentions go too, so the feed and unread counts never see a deleted message.
      await messages.markDeleted(id, at);
      await messages.deleteMentions(id);
      if (m.threadRootId) await messages.refreshThreadSummary(m.threadRootId, at);
      return this.changed(m.convId, id, m, m.threadRootId);
    });
  }

  /**
   * A page of the channel's top-level messages (see PageParams); the newest by default.
   * `around` a reply lands on its root; `first_unread` is around the member's read position.
   */
  async list(userId: Id, convId: Id, params: PageParams = {}): Promise<MessagePage> {
    const { position, limit } = parsePage(params);
    await this.conversations.requireMember(userId, convId);
    const cursor = await this.resolve({ convId }, position, async () => (await this.repos.conversations.readSeq(convId, userId)) ?? 0);
    return this.repos.messages.page({ convId }, cursor, limit);
  }

  /**
   * The root and a page of its replies, like `list`. `first_unread` starts at the beginning
   * for someone who doesn't follow the thread.
   */
  async thread(userId: Id, rootId: Id, params: PageParams = {}): Promise<ThreadView> {
    const { position, limit } = parsePage(params);
    const root = await this.repos.messages.get(rootId);
    if (!root || root.threadRootId) throw new AppError('not_found', 'Thread not found');
    await this.conversations.requireMember(userId, root.convId);
    const lastReadSeq = await this.repos.messages.threadReadSeq(rootId, userId);
    const cursor = await this.resolve({ rootId }, position, async () => lastReadSeq);
    const { messages: replies, hasBefore, hasAfter } = await this.repos.messages.page({ rootId }, cursor, limit);
    return { root, replies, hasBefore, hasAfter, lastReadSeq };
  }

  /** Marks the conversation read up to top-level `seq`; returns the read state after it. */
  async markRead(userId: Id, convId: Id, seq: unknown): Promise<ReadState> {
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new AppError('invalid', 'seq must be an integer');
    return this.repos.transaction(async () => {
      await this.conversations.requireMember(userId, convId);
      await this.repos.conversations.markRead(convId, userId, seq);
      const [state] = await this.repos.conversations.memberStates(userId, convId);
      return { lastReadSeq: state.readSeq, unreadCount: state.unreadCount, mentionCount: state.mentionCount };
    });
  }

  /** Marks the thread read up to reply `seq`, for participants; returns the read state after it. */
  async markThreadRead(userId: Id, rootId: Id, seq: unknown): Promise<ThreadReadState> {
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new AppError('invalid', 'seq must be an integer');
    return this.repos.transaction(async () => {
      const root = await this.get(rootId);
      if (root.threadRootId) throw new AppError('invalid', 'Not a thread root');
      await this.conversations.requireMember(userId, root.convId);
      await this.repos.messages.markThreadRead(rootId, userId, seq);
      const lastReadSeq = await this.repos.messages.threadReadSeq(rootId, userId);
      return { lastReadSeq, unreadCount: lastReadSeq === null ? 0 : await this.repos.messages.unreadReplyCount(rootId, userId, lastReadSeq) };
    });
  }

  /** Turns a message id or the read position into a seq in `timeline`. */
  private async resolve(timeline: Timeline, position: Position, readSeq: () => Promise<number | null>): Promise<PageCursor> {
    if ('firstUnread' in position) {
      const seq = await readSeq();
      return seq === null ? { after: 0 } : { around: seq + 1 }; // with nothing unread, that is the newest page
    }
    if (!('aroundId' in position)) return position;
    const m = await this.repos.messages.get(position.aroundId);
    if ('convId' in timeline) {
      if (m?.convId === timeline.convId) return { around: m.threadRootId ? (await this.get(m.threadRootId)).seq : m.seq };
    } else if (m?.id === timeline.rootId) {
      return { after: 0 };
    } else if (m?.threadRootId === timeline.rootId) {
      return { around: m.seq };
    }
    throw new AppError('not_found', 'Message not found here');
  }

  /** Marks the user's mentions on these messages read. Only touches the user's own rows. */
  async markMentionsRead(userId: Id, messageIds: Id[], at = Date.now()) {
    if (!Array.isArray(messageIds) || !messageIds.every((x) => typeof x === 'string')) throw new AppError('invalid', 'messageIds must be strings');
    await this.repos.transaction(() => this.repos.messages.markMentionsRead(userId, messageIds, at));
  }

  /**
   * Runs the write and publishes its events in one transaction: the conversation first if
   * mentions added members (so their clients know it before the message), then the message.
   */
  private commit(type: 'message.created' | 'message.edited' | 'message.deleted', write: () => Promise<Change>) {
    return this.repos.transaction(async () => {
      const { message, event, membersChanged } = await write();
      if (event && membersChanged) this.events.publish('conversation.upserted', { conversation: event.conversation });
      if (event) this.events.publish(type, event);
      return message;
    });
  }

  /** Snapshots the change inside the transaction, after all its writes. */
  private async changed(convId: Id, id: Id, previous: Message | null, rootId: Id | null, membersChanged = false): Promise<Change> {
    const message = await this.get(id);
    const root = rootId ? await this.get(rootId) : null;
    const threadParticipantIds = rootId ? await this.repos.messages.threadParticipantIds(rootId) : [];
    return { message, event: { conversation: await this.conversations.get(convId), message, previous, root, threadParticipantIds }, membersChanged };
  }

  private async get(id: Id, forUpdate = false): Promise<Message> {
    const m = await this.repos.messages.get(id, { forUpdate });
    if (!m) throw new AppError('not_found', 'Message not found');
    return m;
  }

  /** Locks the message: callers are about to change it. */
  private async own(userId: Id, id: Id): Promise<Message> {
    const m = await this.get(id, true);
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
  private async parseMentions(conv: Conversation, authorId: Id, text: string, allowChannel: boolean) {
    const names = [...text.matchAll(/@([a-z0-9._-]+)/gi)].map((m) => m[1].toLowerCase().replace(/[._-]+$/, ''));
    const channel = allowChannel && names.includes('channel');
    const direct = new Set(
      (await this.repos.users.idsByName(names)).filter((u) => u !== authorId && (conv.kind === 'channel' || conv.memberIds.includes(u))),
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

function parsePage(params: PageParams): { position: Position; limit: number } {
  const given = (['before', 'after', 'around', 'anchor'] as const).filter((k) => params[k] !== undefined && params[k] !== '');
  if (given.length > 1) throw new AppError('invalid', `Use one of ${given.join(', ')}`);
  const limit = params.limit === undefined || params.limit === '' ? PAGE_SIZE : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new AppError('invalid', 'limit must be a positive integer');
  const seq = (key: 'before' | 'after') => {
    const n = Number(params[key]);
    if (!Number.isInteger(n)) throw new AppError('invalid', `${key} must be an integer`);
    return n;
  };
  const position: Position = (() => {
    switch (given[0]) {
      case 'before':
        return { before: seq('before') };
      case 'after':
        return { after: seq('after') };
      case 'around':
        return { aroundId: String(params.around) };
      case 'anchor':
        if (params.anchor !== 'first_unread') throw new AppError('invalid', 'anchor must be first_unread');
        return { firstUnread: true as const };
      default:
        return { latest: true as const };
    }
  })();
  return { position, limit: Math.min(limit, MAX_PAGE_SIZE) };
}

function cleanText(raw: unknown) {
  const text = String(raw ?? '').trim();
  if (!text) throw new AppError('invalid', 'Message is empty');
  if (text.length > MAX_TEXT) throw new AppError('invalid', `Messages are limited to ${MAX_TEXT} characters`);
  return text;
}
