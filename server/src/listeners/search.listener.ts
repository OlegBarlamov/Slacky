import type { DomainEvents } from '../events';
import type { EventSubscriber, QueueOptions } from '../events-system';
import { type SearchIndex, toSearchDoc } from '../externals/search-index';

/** Keeps the search index in step with messages. The index ignores stale versions, so redelivery is safe. */
export function subscribeSearch(bus: EventSubscriber<DomainEvents>, index: SearchIndex, options?: QueueOptions) {
  return bus.subscribe('search', ['message.created', 'message.edited', 'message.deleted'], (e) => index.upsert(toSearchDoc(e.payload.message)), options);
}
