import type { Conversation, Id, Message } from '../../../shared/types';
import type { DomainEvents, MessageChanged } from '../events';
import type { EventSubscriber, QueueOptions } from '../events-system';
import type { NotificationSender } from '../externals/notification-sender';

type Reason = 'mention' | 'dm';

const mentioned = (c: Conversation, m: Message | null): Id[] =>
  !m ? [] : m.mentions.some((x) => x.kind === 'channel') ? c.memberIds : m.mentions.flatMap((x) => (x.kind === 'user' ? [x.userId] : []));

/**
 * Who gets pinged: people newly @mentioned (an edit only pings mentions it added) and the
 * other side of a new DM. Never the author.
 */
export function recipients({ conversation: c, message: m, previous }: MessageChanged): Map<Id, Reason> {
  const out = new Map<Id, Reason>();
  const before = new Set(mentioned(c, previous));
  for (const u of mentioned(c, m)) if (u !== m.authorId && !before.has(u)) out.set(u, 'mention');
  if (!previous && c.kind === 'dm') for (const u of c.memberIds) if (u !== m.authorId && !out.has(u)) out.set(u, 'dm');
  return out;
}

/** One notification per (message, recipient): the key makes retries and redelivery harmless. */
export function subscribeNotifications(bus: EventSubscriber<DomainEvents>, sender: NotificationSender, options?: QueueOptions) {
  return bus.subscribe(
    'notifications',
    ['message.created', 'message.edited'],
    async (e) => {
      const { conversation, message } = e.payload;
      for (const [recipientId, reason] of recipients(e.payload)) {
        await sender.send({ key: `${message.id}:${recipientId}`, recipientId, reason, convId: conversation.id, messageId: message.id, text: message.text, sentAt: Date.now() });
      }
    },
    options,
  );
}
