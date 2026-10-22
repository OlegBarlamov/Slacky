import type { DomainPublisher } from '../events';
import type { Repositories } from '../repositories';
import { ConversationService } from './conversation.service';
import { FeedService } from './feed.service';
import { MessageService } from './message.service';
import { SearchService } from './search.service';
import { ThreadService } from './thread.service';
import { UserService } from './user.service';

export interface ServiceDeps {
  events: DomainPublisher;
  streamCursor: () => number;
}

export function createServices(repos: Repositories, deps: ServiceDeps) {
  const conversations = new ConversationService(repos, deps.events, deps.streamCursor);
  return {
    users: new UserService(repos, deps.events),
    conversations,
    messages: new MessageService(repos, conversations, deps.events),
    feed: new FeedService(repos, conversations),
    search: new SearchService(repos),
    threads: new ThreadService(repos),
  };
}

export type Services = ReturnType<typeof createServices>;
