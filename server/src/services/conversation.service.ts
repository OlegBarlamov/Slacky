import { CHANNEL_NAME_RULES, isValidChannelName, toChannelName } from '../../../shared/names';
import type { Bootstrap, Conversation, ConversationView, Id } from '../../../shared/types';
import type { DomainPublisher } from '../events';
import type { Repositories } from '../repositories';
import { AppError } from './errors';

/** Every workspace has it, and every user is in it. */
export const GENERAL_CHANNEL = 'general';

/** A pair (or a self-DM) always maps to the same name, so UNIQUE(name) prevents duplicate DMs. */
export const dmName = (memberIds: Id[]) => 'dm:' + [...new Set(memberIds)].sort().join(':');

export class ConversationService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: DomainPublisher,
    /** Position of the realtime stream, so bootstrap and stream line up. */
    private readonly streamCursor: () => number,
  ) {}

  /** Channel names follow the shared rules (no ':'), so they never collide with DM names. */
  createChannel(rawName: unknown, memberIds: Id[], at = Date.now()): Conversation {
    const name = toChannelName(String(rawName ?? ''));
    if (!isValidChannelName(name)) throw new AppError('invalid', CHANNEL_NAME_RULES);
    const conversation = this.repos.transaction(() => {
      const id = this.repos.conversations.create('channel', name, at);
      if (!id) throw new AppError('conflict', `#${name} already exists`);
      this.addMembers(id, memberIds);
      return this.get(id);
    });
    this.events.publish('conversation.upserted', { conversation });
    return conversation;
  }

  /** Creates the channel with no members if it doesn't exist yet. Used at startup. */
  ensureChannel(name: string, at = Date.now()) {
    this.repos.transaction(() => this.repos.conversations.findIdByName(name) ?? this.repos.conversations.create('channel', name, at));
  }

  /** Returns the existing DM between the users, or creates it. */
  openDm(userId: Id, otherId: Id, at = Date.now()): Conversation {
    const name = dmName([userId, otherId]);
    const { conversation, created } = this.repos.transaction(() => {
      // Opened often, created once: looking up first is the cheap path.
      const existing = this.repos.conversations.findIdByName(name);
      if (existing) return { conversation: this.get(existing), created: false };
      const id = this.repos.conversations.create('dm', name, at)!; // can't be taken: we're inside the write lock
      this.addMembers(id, [userId, otherId]);
      return { conversation: this.get(id), created: true };
    });
    if (created) this.events.publish('conversation.upserted', { conversation });
    return conversation;
  }

  /** Idempotent. Existing history doesn't count as unread. */
  join(userId: Id, convId: Id): Conversation {
    const { conversation, joined } = this.repos.transaction(() => {
      this.requireChannel(convId);
      const joined = this.repos.conversations.join(convId, userId);
      return { conversation: this.get(convId), joined };
    });
    if (joined) this.events.publish('conversation.upserted', { conversation });
    return conversation;
  }

  /** Idempotent. Mentions and thread read positions stay; readers must check membership. */
  leave(userId: Id, convId: Id) {
    const { conversation, left } = this.repos.transaction(() => {
      this.requireChannel(convId);
      const left = this.repos.conversations.leave(convId, userId);
      return { conversation: this.get(convId), left };
    });
    if (left) this.events.publish('conversation.left', { conversation, userId });
  }

  /** Everything the client needs on load. */
  bootstrap(userId: Id): Bootstrap {
    const streamCursor = this.streamCursor(); // read first: events after it are replayed, none missed
    const me = this.repos.users.get(userId);
    if (!me) throw new AppError('unauthenticated', 'Not signed in');
    return {
      me,
      users: this.repos.users.list(),
      conversations: this.views(userId),
      otherChannels: this.repos.conversations.channelIdsNotJoined(userId).map((id) => this.get(id)),
      streamCursor,
    };
  }

  /** One conversation as seen by a member. */
  view(userId: Id, convId: Id): ConversationView {
    const view = this.views(userId).find((v) => v.conversation.id === convId);
    if (!view) throw new AppError('forbidden', 'Not a member of this conversation');
    return view;
  }

  private views(userId: Id): ConversationView[] {
    return this.repos.conversations.memberStates(userId).map((s) => ({
      conversation: this.get(s.convId),
      lastReadSeq: s.readSeq,
      unreadCount: s.unreadCount,
      mentionCount: s.mentionCount,
    }));
  }

  get(id: Id): Conversation {
    const c = this.repos.conversations.get(id);
    if (!c) throw new AppError('not_found', 'Conversation not found');
    return c;
  }

  /** DMs can't be joined or left. */
  private requireChannel(convId: Id) {
    if (this.get(convId).kind !== 'channel') throw new AppError('not_found', 'Channel not found');
  }

  /** Unknown users are not added; the caller's transaction then rolls back. */
  private addMembers(id: Id, memberIds: Id[]) {
    const unique = [...new Set(memberIds)];
    if (this.repos.conversations.addMembers(id, unique) !== unique.length) throw new AppError('not_found', 'User not found');
  }

  requireMember(userId: Id, convId: Id): Conversation {
    const c = this.get(convId);
    if (!c.memberIds.includes(userId)) throw new AppError('forbidden', 'Not a member of this conversation');
    return c;
  }
}
