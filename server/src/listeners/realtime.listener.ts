import type { ActivityItem, Id } from '../../../shared/types';
import type { DomainEvents, MessageChanged } from '../events';
import type { EventSubscriber, QueueOptions } from '../events-system';
import type { Network } from '../externals/chaos';
import type { RealtimeHub } from '../realtime/hub';

export interface FeedReader {
  item(userId: Id, itemId: string): Promise<ActivityItem | null>;
}

/** Feed items a message change can affect, and for whom. Mirrors the feed's rules. */
export function affectedItems({ conversation: c, message: m, previous, root, threadParticipantIds }: MessageChanged): Map<string, Set<Id>> {
  const out = new Map<string, Set<Id>>();
  // My own message never needs my attention, except that my thread item moves when I reply.
  const add = (itemId: string, users: Id[], includeAuthor = false) => {
    const set = out.get(itemId) ?? new Set();
    for (const u of users) if (includeAuthor || u !== m.authorId) set.add(u);
    if (set.size) out.set(itemId, set);
  };
  const mentionedIn = (x: typeof m | null) =>
    !x ? [] : x.mentions.some((k) => k.kind === 'channel') ? c.memberIds : x.mentions.flatMap((k) => (k.kind === 'user' ? [k.userId] : []));

  if (c.kind === 'channel') add(`mention:${m.id}`, [...mentionedIn(m), ...mentionedIn(previous)]);
  if (c.kind === 'dm' && !m.threadRootId) add(`dm:${c.id}`, c.memberIds);
  if (root) add(`thread:${root.id}`, threadParticipantIds, true);
  return out;
}

/** Pushes changes to connected clients: the change itself to members, and their refreshed feed items. */
export const REALTIME_EVENTS = ['message.created', 'message.edited', 'message.deleted', 'conversation.upserted', 'conversation.left'] satisfies (keyof DomainEvents)[];

export function subscribeRealtime(bus: EventSubscriber<DomainEvents>, hub: RealtimeHub, feed: FeedReader, network: Network, options?: QueueOptions) {
  return bus.subscribe(
    'realtime',
    REALTIME_EVENTS,
    (e) =>
      network.call('realtime', async () => {
        switch (e.type) {
          case 'message.created':
          case 'message.edited':
          case 'message.deleted': {
            const { conversation, message, root } = e.payload;
            hub.publish(conversation.memberIds, { type: e.type, message, root });
            for (const [itemId, users] of affectedItems(e.payload)) {
              for (const userId of users) {
                const item = await feed.item(userId, itemId);
                hub.publish([userId], item ? { type: 'activity.upserted', item } : { type: 'activity.removed', itemId });
              }
            }
            return;
          }
          case 'conversation.upserted': {
            const { conversation } = e.payload;
            // A new or changed channel is visible to everyone (it's joinable); a DM only to its members.
            if (conversation.kind === 'channel') hub.broadcast({ type: 'conversation.upserted', conversation });
            else hub.publish(conversation.memberIds, { type: 'conversation.upserted', conversation });
            return;
          }
          case 'conversation.left': {
            const { conversation, userId } = e.payload;
            hub.publish([...conversation.memberIds, userId], { type: 'conversation.upserted', conversation });
          }
        }
      }),
    options,
  );
}
