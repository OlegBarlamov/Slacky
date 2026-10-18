// Domain events: what the core publishes after a transaction commits. Payloads are full
// snapshots taken inside the transaction, so listeners don't depend on reading back.
import type { Conversation, Id, Message } from '../../shared/types';
import type { EventPublisher } from './events-system';

export interface MessageChanged {
  conversation: Conversation;
  message: Message; // state after the change
  previous: Message | null; // state before an edit or delete
  root: Message | null; // the thread root after the change, for replies
  threadParticipantIds: Id[]; // for replies: who is in the thread after the change
}

export type DomainEvents = {
  'message.created': MessageChanged;
  'message.edited': MessageChanged;
  'message.deleted': MessageChanged;
  'conversation.upserted': { conversation: Conversation };
  'conversation.left': { conversation: Conversation; userId: Id };
};

export type DomainPublisher = EventPublisher<DomainEvents>;
