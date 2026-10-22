// The notifications listener's ledger: one row per (message, recipient). Jobs are delivered
// at least once; the ledger makes a retry skip whoever already got the notification.
import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>) {
  await sql`
    CREATE TABLE notification_deliveries (
      key          text PRIMARY KEY,  -- <messageId>:<recipientId>, also the provider's idempotency key
      message_id   text NOT NULL REFERENCES messages(id),
      recipient_id text NOT NULL REFERENCES users(id),
      reason       text NOT NULL,
      status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
      attempts     int  NOT NULL DEFAULT 0,
      last_error   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      sent_at      timestamptz
    );
    CREATE INDEX notification_deliveries_by_recipient ON notification_deliveries (recipient_id, created_at DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql`DROP TABLE notification_deliveries`.execute(db);
}
