import type { DomainEvents } from '../events';
import type { EventSubscriber, ListenerConfig, QueueOptions, Routes } from '../events-system';
import type { Network } from '../externals/chaos';
import type { RealtimeHub } from '../realtime/hub';
import { type NotificationDeps, NOTIFICATION_EVENTS, subscribeNotifications } from './notifications.listener';
import { type FeedReader, REALTIME_EVENTS, subscribeRealtime } from './realtime.listener';

/**
 * Every listener and the events it takes. Publishers route with this, so an API process can
 * enqueue jobs for listeners running in a worker process.
 */
export const ROUTES = {
  notifications: NOTIFICATION_EVENTS,
  realtime: REALTIME_EVENTS,
} satisfies Routes<DomainEvents>;

/** Per-listener delivery settings for the durable bus. */
export const LISTENER_CONFIG: Record<keyof typeof ROUTES, ListenerConfig> = {
  // ~10 attempts over ~1 h, so a provider outage is absorbed before anything dead-letters.
  notifications: { queue: { maxAttempts: 10, baseDelayMs: 10_000, maxDelayMs: 600_000 } },
  // One at a time, oldest first: clients see changes in order (version guards cover the rest).
  realtime: { serial: true, queue: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000 } },
};

export interface ListenerDeps {
  notifications: NotificationDeps;
  hub: RealtimeHub;
  feed: FeedReader;
  network: Network;
}

/** Each listener gets its own queue, so one slow or failing system never holds up another. */
export function subscribeListeners(bus: EventSubscriber<DomainEvents>, deps: ListenerDeps, options?: QueueOptions) {
  return [
    subscribeNotifications(bus, deps.notifications, options),
    subscribeRealtime(bus, deps.hub, deps.feed, deps.network, options),
  ];
}
