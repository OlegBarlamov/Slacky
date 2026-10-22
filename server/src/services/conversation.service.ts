import { CHANNEL_NAME_RULES, isValidChannelName, toChannelName } from '../../../shared/names';
import type { Bootstrap, Conversation, ConversationView, Id } from '../../../shared/types';
import type { DomainPublisher } from '../events';
import type { Repositories } from '../repositories';
import { AppError } from './errors';

/** Every workspace has it, and every user is in it. */
export const GENERAL_CHANNEL = 'general';

/** A pair (or a self-DM) always maps to the same key, so its unique index prevents duplicate DMs. */
export const dmKey = (memberIds: Id[]) => [...new Set(memberIds)].sort().join(':');

export class ConversationService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: DomainPublisher,
    /** Position of the realtime stream, so bootstrap and stream line up. */
    private readonly streamCursor: () => number,
  ) {}

  async createChannel(rawName: unknown, memberIds: Id[], at = Date.now()): Promise<Conversation> {
    const name = toChannelName(String(rawName ?? ''));
    if (!isValidChannelName(name)) throw new AppError('invalid', CHANNEL_NAME_RULES);
    return this.repos.transaction(async () => {
      const id = await this.repos.conversations.createChannel(name, at);
      if (!id) throw new AppError('conflict', `#${name} already exists`);
      await this.addMembers(id, memberIds);
      const conversation = await this.get(id);
      this.events.publish('conversation.upserted', { conversation });
      return conversation;
    });
  }

  /** Creates the channel with no members if it doesn't exist yet. Used at startup. */
  async ensureChannel(name: string, at = Date.now()) {
    await this.repos.conversations.createChannel(name, at); // a no-op if it exists
  }

  /** Returns the existing DM between the users, or creates it. */
  async openDm(userId: Id, otherId: Id, at = Date.now()): Promise<Conversation> {
    const key = dmKey([userId, otherId]);
    return this.repos.transaction(async () => {
      // Opened often, created once: looking up first is the cheap path.
      const existing = await this.repos.conversations.findDmId(key);
      if (existing) return this.get(existing);
      const id = await this.repos.conversations.createDm(key, at);
      // Lost a race with a concurrent open: the insert waited for it to commit, so it's visible now.
      if (!id) return this.get((await this.repos.conversations.findDmId(key))!);
      await this.addMembers(id, [userId, otherId]);
      const conversation = await this.get(id);
      this.events.publish('conversation.upserted', { conversation });
      return conversation;
    });
  }

  /** Idempotent. Existing history doesn't count as unread. */
  async join(userId: Id, convId: Id): Promise<Conversation> {
    return this.repos.transaction(async () => {
      await this.requireChannel(convId);
      const joined = await this.repos.conversations.join(convId, userId);
      const conversation = await this.get(convId);
      if (joined) this.events.publish('conversation.upserted', { conversation });
      return conversation;
    });
  }

  /** Idempotent. Mentions and thread read positions stay; readers must check membership. */
  async leave(userId: Id, convId: Id) {
    await this.repos.transaction(async () => {
      await this.requireChannel(convId);
      const left = await this.repos.conversations.leave(convId, userId);
      if (left) this.events.publish('conversation.left', { conversation: await this.get(convId), userId });
    });
  }

  /** Everything the client needs on load. */
  async bootstrap(userId: Id): Promise<Bootstrap> {
    const streamCursor = this.streamCursor(); // read first: events after it are replayed, none missed
    const me = await this.repos.users.get(userId);
    if (!me) throw new AppError('unauthenticated', 'Not signed in');
    return {
      me,
      users: await this.repos.users.listInConversationsOf(userId),
      conversations: await this.views(userId),
      otherChannels: await Promise.all((await this.repos.conversations.channelIdsNotJoined(userId)).map((id) => this.get(id))),
      unreadThreadIds: await this.repos.messages.unreadThreadIds(userId),
      streamCursor,
    };
  }

  /** One conversation as seen by a member. */
  async view(userId: Id, convId: Id): Promise<ConversationView> {
    const view = (await this.views(userId)).find((v) => v.conversation.id === convId);
    if (!view) throw new AppError('forbidden', 'Not a member of this conversation');
    return view;
  }

  private async views(userId: Id): Promise<ConversationView[]> {
    const states = await this.repos.conversations.memberStates(userId);
    return Promise.all(
      states.map(async (s) => ({
        conversation: await this.get(s.convId),
        lastReadSeq: s.readSeq,
        unreadCount: s.unreadCount,
        mentionCount: s.mentionCount,
      })),
    );
  }

  async get(id: Id): Promise<Conversation> {
    const c = await this.repos.conversations.get(id);
    if (!c) throw new AppError('not_found', 'Conversation not found');
    return c;
  }

  /** DMs can't be joined or left. */
  private async requireChannel(convId: Id) {
    if ((await this.get(convId)).kind !== 'channel') throw new AppError('not_found', 'Channel not found');
  }

  /** Unknown users are not added; the caller's transaction then rolls back. */
  private async addMembers(id: Id, memberIds: Id[]) {
    const unique = [...new Set(memberIds)];
    if ((await this.repos.conversations.addMembers(id, unique)) !== unique.length) throw new AppError('not_found', 'User not found');
  }

  async requireMember(userId: Id, convId: Id): Promise<Conversation> {
    const c = await this.get(convId);
    if (!c.memberIds.includes(userId)) throw new AppError('forbidden', 'Not a member of this conversation');
    return c;
  }
}
