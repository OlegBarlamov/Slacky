import type { Conversation, Id, User } from '../../../shared/types';
import type { DomainPublisher } from '../events';
import type { Repositories } from '../repositories';
import { dmName, GENERAL_CHANNEL } from './conversation.service';
import { AppError } from './errors';

const USER_NAME = /^[a-z0-9][a-z0-9._-]{1,19}$/;
/** Taken by mention syntax, so no user can be @mentioned by accident. */
const RESERVED = new Set(['channel', 'here']);

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

  register(rawName: unknown, at = Date.now()): User {
    const name = normalize(rawName);
    if (!USER_NAME.test(name)) throw new AppError('invalid', 'Use 2-20 characters: letters, digits, . _ -');
    if (RESERVED.has(name)) throw new AppError('invalid', `"${name}" is reserved`);
    // One transaction: a user never exists without #general and their own DM (notes to self).
    const { user, general } = this.repos.transaction(() => {
      const user = this.repos.users.create(name, at);
      if (!user) throw new AppError('conflict', `"${name}" is already taken`);
      const generalId = this.repos.conversations.findIdByName(GENERAL_CHANNEL);
      if (generalId) this.repos.conversations.join(generalId, user.id);
      const selfDm = this.repos.conversations.create('dm', dmName([user.id]), at)!; // new user: the name can't be taken
      this.repos.conversations.addMembers(selfDm, [user.id]);
      return { user, general: generalId ? (this.repos.conversations.get(generalId) as Conversation) : null };
    });
    if (general) this.events.publish('conversation.upserted', { conversation: general }); // others see the new member
    return user;
  }

  /** Name-only sign-in: this is a demo, not an identity system. */
  login(rawName: unknown): User {
    const user = this.repos.users.findByName(normalize(rawName));
    if (!user) throw new AppError('not_found', `No user named "${String(rawName ?? '').trim()}"`);
    return user;
  }

  find(id: Id): User | undefined {
    return this.repos.users.get(id);
  }

  list(): User[] {
    return this.repos.users.list();
  }
}
