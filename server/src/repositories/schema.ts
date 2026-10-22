// Row types for Kysely, mirroring migrations/. Timestamps are timestamptz (Date here); the
// repositories convert to epoch ms at the boundary, so the API is unchanged.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date, Date>;
type CreatedAt = ColumnType<Date, Date | undefined, never>;

export interface UsersTable {
  id: string;
  name: string; // citext
  created_at: CreatedAt;
}

export interface ConversationsTable {
  id: string;
  kind: 'channel' | 'dm';
  name: string | null; // channels only
  dm_key: string | null; // DMs only: sorted member ids
  last_seq: Generated<number>;
  last_message_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface ConversationMembersTable {
  conversation_id: string;
  user_id: string;
  read_seq: Generated<number>;
  joined_at: Generated<Date>;
}

export interface MessagesTable {
  id: string;
  conversation_id: string;
  thread_root_id: string | null;
  seq: number;
  author_id: string;
  client_msg_id: string;
  text: string;
  mentions_channel: Generated<boolean>;
  reply_count: Generated<number>;
  last_reply_seq: Generated<number>;
  last_reply_at: Timestamp | null;
  version: Generated<number>;
  search: unknown; // tsvector, written with to_tsvector()
  created_at: Timestamp;
  updated_at: Timestamp;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface MentionsTable {
  message_id: string;
  user_id: string;
  channel_wide: Generated<boolean>;
  created_at: Timestamp;
  read_at: Timestamp | null;
}

export interface ThreadParticipantsTable {
  user_id: string;
  root_id: string;
  read_seq: number;
}

export interface NotificationDeliveriesTable {
  key: string; // <messageId>:<recipientId>
  message_id: string;
  recipient_id: string;
  reason: string;
  status: Generated<'pending' | 'sent' | 'skipped'>;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: CreatedAt;
  sent_at: Timestamp | null;
}

export interface Database {
  users: UsersTable;
  conversations: ConversationsTable;
  conversation_members: ConversationMembersTable;
  messages: MessagesTable;
  mentions: MentionsTable;
  thread_participants: ThreadParticipantsTable;
  notification_deliveries: NotificationDeliveriesTable;
}
