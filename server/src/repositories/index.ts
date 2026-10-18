import { ConversationRepository } from './conversation.repository';
import type { DB } from './db';
import { FeedRepository } from './feed.repository';
import { MessageRepository } from './message.repository';
import { UserRepository } from './user.repository';

export function createRepositories(db: DB) {
  return {
    /** Runs `fn` in one IMMEDIATE transaction: every write inside commits or none does. Nested calls become savepoints. */
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    users: new UserRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    feed: new FeedRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
