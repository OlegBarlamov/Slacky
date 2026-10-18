import type { DomainEvents } from '../events';
import type { EventSubscriber, QueueOptions } from '../events-system';
import type { Network } from '../externals/chaos';
import type { NotificationSender } from '../externals/notification-sender';
import type { SearchIndex } from '../externals/search-index';
import type { RealtimeHub } from '../realtime/hub';
import { subscribeNotifications } from './notifications.listener';
import { type FeedReader, subscribeRealtime } from './realtime.listener';
import { subscribeSearch } from './search.listener';

export interface ListenerDeps {
  searchIndex: SearchIndex;
  notifications: NotificationSender;
  hub: RealtimeHub;
  feed: FeedReader;
  network: Network;
}

/** Each listener gets its own queue, so one slow or failing system never holds up another. */
export function subscribeListeners(bus: EventSubscriber<DomainEvents>, deps: ListenerDeps, options?: QueueOptions) {
  return [
    subscribeSearch(bus, deps.searchIndex, options),
    subscribeNotifications(bus, deps.notifications, options),
    subscribeRealtime(bus, deps.hub, deps.feed, deps.network, options),
  ];
}
