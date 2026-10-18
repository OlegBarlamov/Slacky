import type { DomainPublisher } from '../events';
import type { SearchIndex } from '../externals/search-index';
import type { Repositories } from '../repositories';
import { ConversationService } from './conversation.service';
import { FeedService } from './feed.service';
import { MessageService } from './message.service';
import { SearchService } from './search.service';
import { UserService } from './user.service';

export interface ServiceDeps {
  events: DomainPublisher;
  searchIndex: SearchIndex;
  searchPending: () => number;
  streamCursor: () => number;
}

export function createServices(repos: Repositories, deps: ServiceDeps) {
  const conversations = new ConversationService(repos, deps.events, deps.streamCursor);
  return {
    users: new UserService(repos, deps.events),
    conversations,
    messages: new MessageService(repos, conversations, deps.events),
    feed: new FeedService(repos, conversations),
    search: new SearchService(repos, deps.searchIndex, deps.searchPending),
  };
}

export type Services = ReturnType<typeof createServices>;
