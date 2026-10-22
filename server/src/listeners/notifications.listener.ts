import { type Conversation, type Id, type Message, mentionsUser } from '../../../shared/types';
import type { DomainEvents, MessageChanged } from '../events';
import type { EventSubscriber, QueueOptions } from '../events-system';
import type { NotificationSender } from '../externals/notification-sender';
import type { NotificationRepository } from '../repositories/notification.repository';

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

export const NOTIFICATION_EVENTS = ['message.created', 'message.edited'] satisfies (keyof DomainEvents)[];

export interface NotificationDeps {
  sender: NotificationSender;
  ledger: NotificationRepository;
  /** The message as it is now, to skip notifications that no longer apply. */
  currentMessage(id: Id): Promise<Message | undefined>;
}

/** Still worth sending: the message is live and, for a mention, still mentions the recipient. */
const stillApplies = (m: Message | undefined, recipientId: Id, reason: Reason) =>
  !!m && !m.deletedAt && (reason !== 'mention' || mentionsUser(m, recipientId));

/**
 * One notification per (message, recipient). Jobs run at least once, so every send goes
 * through the ledger: a retry skips recipients already sent to, and the key doubles as the
 * provider's idempotency key for a crash between sending and recording it.
 */
export function subscribeNotifications(bus: EventSubscriber<DomainEvents>, deps: NotificationDeps, options?: QueueOptions) {
  return bus.subscribe(
    'notifications',
    NOTIFICATION_EVENTS,
    async (e) => {
      const { conversation, message } = e.payload;
      for (const [recipientId, reason] of recipients(e.payload)) {
        const key = `${message.id}:${recipientId}`;
        if ((await deps.ledger.begin({ key, messageId: message.id, recipientId, reason })) !== 'pending') continue;
        const current = await deps.currentMessage(message.id);
        if (!stillApplies(current, recipientId, reason)) {
          await deps.ledger.markSkipped(key);
          continue;
        }
        try {
          await deps.sender.send({ key, recipientId, reason, convId: conversation.id, messageId: message.id, text: current!.text, sentAt: Date.now() });
        } catch (err) {
          await deps.ledger.markFailed(key, String((err as Error)?.message ?? err));
          throw err; // the job retries; recipients already sent to are skipped
        }
        await deps.ledger.markSent(key);
      }
    },
    options,
  );
}
