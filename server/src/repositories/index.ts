import { ConversationRepository } from './conversation.repository';
import type { DB } from './db';
import { FeedRepository } from './feed.repository';
import { MessageRepository } from './message.repository';
import { NotificationRepository } from './notification.repository';
import { UserRepository } from './user.repository';

export function createRepositories(db: DB) {
  return {
    /**
     * Runs `fn` in one transaction (READ COMMITTED): every write inside commits or none does.
     * Unlike SQLite's IMMEDIATE lock, writes don't serialise globally; read-then-write paths
     * take row locks (`FOR UPDATE`, or an `UPDATE … RETURNING` allocator) where it matters.
     */
    transaction: <T>(fn: () => Promise<T>): Promise<T> => db.transaction(fn),
    users: new UserRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    feed: new FeedRepository(db),
    notifications: new NotificationRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
