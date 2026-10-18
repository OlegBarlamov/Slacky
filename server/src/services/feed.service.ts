// The activity feed: what deserves the user's attention, read straight from the core tables.
//   mention:<message>  someone @mentioned me (or @channel) in a channel I'm in
//   dm:<conversation>  DMs from others, grouped; shows what's unread, or the last one once read
//   thread:<root>      threads I'm in: unread replies from others, grouped; or the latest reply once read
import type { ActivityEntry, ActivityItem, Id, Message } from '../../../shared/types';
import type { Repositories } from '../repositories';
import type { FeedPosition } from '../repositories/feed.repository';
import type { ConversationService } from './conversation.service';
import { AppError } from './errors';

const LIMIT = 50; // items per source and in total
const ENTRIES = 5; // newest messages shown per grouped item

const entry = (m: Message): ActivityEntry => ({ messageId: m.id, authorId: m.authorId, text: m.text, edited: m.editedAt !== null, at: m.createdAt });

export class FeedService {
  constructor(
    private readonly repos: Repositories,
    private readonly conversations: ConversationService,
  ) {}

  list(userId: Id): ActivityItem[] {
    const { feed } = this.repos;
    const dms = feed.dms(userId, LIMIT).map((p) =>
      this.group('dm', p, null, (after, limit) => feed.dmMessagesFromOthers(p.id, userId, after, limit), () => []),
    );
    // A thread shows as soon as I'm in it, even if only I have replied so far.
    const threads = feed.threads(userId, LIMIT).map((p) =>
      this.group('thread', p, p.id, (after, limit) => feed.replies(p.id, userId, after, limit), () => feed.replies(p.id, null, 0, 1)),
    );
    const mentions = feed.mentions(userId, LIMIT).map((x): ActivityItem => {
      const m = this.message(x.messageId);
      return {
        id: `mention:${m.id}`,
        kind: 'mention',
        convId: m.convId,
        threadRootId: m.threadRootId,
        entries: [entry(m)],
        channelWide: x.channelWide,
        state: 'active',
        read: x.readAt !== null,
        updatedAt: x.createdAt,
      };
    });
    return [...dms, ...threads, ...mentions]
      .filter((i): i is ActivityItem => i !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, LIMIT);
  }

  /**
   * One item as the user would see it now, or null if it's gone. Recomputes the user's
   * feed: simple, and cheap at this size (the realtime listener calls it per change).
   */
  item(userId: Id, itemId: string): ActivityItem | null {
    return this.list(userId).find((i) => i.id === itemId) ?? null;
  }

  /** Marks items read: a mention by its flag, a DM or thread by moving the read position to the end. */
  markRead(userId: Id, itemIds: unknown, at = Date.now()) {
    if (!Array.isArray(itemIds) || !itemIds.every((x) => typeof x === 'string')) throw new AppError('invalid', 'ids must be strings');
    const parsed = (itemIds as string[]).map((id) => {
      const i = id.indexOf(':');
      return { kind: id.slice(0, i), target: id.slice(i + 1) };
    });
    this.repos.transaction(() => {
      this.repos.messages.markMentionsRead(userId, parsed.filter((p) => p.kind === 'mention').map((p) => p.target), at);
      for (const { kind, target } of parsed) {
        if (kind === 'dm') {
          this.conversations.requireMember(userId, target);
          this.repos.conversations.markAllRead(target, userId);
        } else if (kind === 'thread') {
          this.conversations.requireMember(userId, this.message(target).convId);
          this.repos.messages.markThreadReadToEnd(target, userId);
        } else if (kind !== 'mention') {
          throw new AppError('invalid', `Unknown activity item "${kind}:${target}"`);
        }
      }
    });
  }

  /**
   * A DM or thread item: the unread messages from others, or else the last one from others,
   * or else `fallback` (the latest of mine, for threads). Null when there's nothing to show.
   */
  private group(
    kind: 'dm' | 'thread',
    p: FeedPosition,
    threadRootId: Id | null,
    fromOthers: (afterSeq: number, limit: number) => Id[],
    fallback: () => Id[],
  ): ActivityItem | null {
    const unread = fromOthers(p.readSeq, ENTRIES);
    const lastFromOthers = unread.length ? [] : fromOthers(0, 1);
    const ids = unread.length ? unread : lastFromOthers.length ? lastFromOthers : fallback();
    if (!ids.length) return null;
    const messages = ids.reverse().map((id) => this.message(id));
    return {
      id: `${kind}:${p.id}`,
      kind,
      convId: kind === 'dm' ? p.id : this.message(p.id).convId,
      threadRootId,
      entries: messages.map(entry),
      channelWide: false,
      state: 'active',
      read: unread.length === 0,
      updatedAt: messages[messages.length - 1].createdAt,
    };
  }

  private message(id: Id): Message {
    const m = this.repos.messages.get(id);
    if (!m) throw new AppError('not_found', 'Message not found');
    return m;
  }
}
