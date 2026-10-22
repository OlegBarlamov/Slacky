import type { Conversation, Id, User } from '../../../shared/types';
import type { DomainPublisher } from '../events';
import type { Repositories } from '../repositories';
import { dmKey, GENERAL_CHANNEL } from './conversation.service';
import { AppError } from './errors';

const USER_NAME = /^[a-z0-9][a-z0-9._-]{1,19}$/;
/** Taken by mention syntax, so no user can be @mentioned by accident. */
const RESERVED = new Set(['channel', 'here']);
const SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 100;

const normalize = (raw: unknown) =>
  String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[@#]/, '');

export class UserService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: DomainPublisher,
  ) {}

  async register(rawName: unknown, at = Date.now()): Promise<User> {
    const name = normalize(rawName);
    if (!USER_NAME.test(name)) throw new AppError('invalid', 'Use 2-20 characters: letters, digits, . _ -');
    if (RESERVED.has(name)) throw new AppError('invalid', `"${name}" is reserved`);
    // One transaction: a user never exists without #general and their own DM (notes to self).
    return this.repos.transaction(async () => {
      const user = await this.repos.users.create(name, at);
      if (!user) throw new AppError('conflict', `"${name}" is already taken`);
      const generalId = await this.repos.conversations.findChannelId(GENERAL_CHANNEL);
      if (generalId) await this.repos.conversations.join(generalId, user.id);
      const selfDm = (await this.repos.conversations.createDm(dmKey([user.id]), at))!; // new user: the key can't be taken
      await this.repos.conversations.addMembers(selfDm, [user.id]);
      // Others see the new member.
      if (generalId) this.events.publish('conversation.upserted', { conversation: (await this.repos.conversations.get(generalId)) as Conversation });
      return user;
    });
  }

  /** Name-only sign-in: this is a demo, not an identity system. */
  async login(rawName: unknown): Promise<User> {
    const user = await this.repos.users.findByName(normalize(rawName));
    if (!user) throw new AppError('not_found', `No user named "${String(rawName ?? '').trim()}"`);
    return user;
  }

  find(id: Id): Promise<User | undefined> {
    return this.repos.users.get(id);
  }

  /** Users whose name starts with `q`; members of `convId` (when given and I'm in it) first. */
  async search(userId: Id, q: unknown, convId: unknown, limit: unknown): Promise<User[]> {
    const n = limit === undefined || limit === '' ? SEARCH_LIMIT : Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new AppError('invalid', 'limit must be a positive integer');
    const conv = typeof convId === 'string' && convId ? await this.repos.conversations.get(convId) : undefined;
    const preferIds = conv?.memberIds.includes(userId) ? conv.memberIds : [];
    return this.repos.users.search(normalize(q), Math.min(n, MAX_SEARCH_LIMIT), preferIds);
  }
}
