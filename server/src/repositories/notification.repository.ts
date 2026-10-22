import { sql } from 'kysely';
import type { Id } from '../../../shared/types';
import { toDate, type DB } from './db';

export type DeliveryStatus = 'pending' | 'sent' | 'skipped';

/** The notification delivery ledger: what was sent to whom, so a retried job sends nothing twice. */
export class NotificationRepository {
  constructor(private readonly db: DB) {}

  /** Records the delivery if it's new, and returns its status. */
  async begin(d: { key: string; messageId: Id; recipientId: Id; reason: string }): Promise<DeliveryStatus> {
    await this.db.current
      .insertInto('notification_deliveries')
      .values({ key: d.key, message_id: d.messageId, recipient_id: d.recipientId, reason: d.reason })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    const row = await this.db.current.selectFrom('notification_deliveries').select('status').where('key', '=', d.key).executeTakeFirstOrThrow();
    return row.status;
  }

  async markSent(key: string, at = Date.now()) {
    await this.db.current
      .updateTable('notification_deliveries')
      .set({ status: 'sent', sent_at: toDate(at), attempts: sql`attempts + 1`, last_error: null })
      .where('key', '=', key)
      .execute();
  }

  async markSkipped(key: string) {
    await this.db.current.updateTable('notification_deliveries').set({ status: 'skipped' }).where('key', '=', key).execute();
  }

  async markFailed(key: string, error: string) {
    await this.db.current
      .updateTable('notification_deliveries')
      .set({ attempts: sql`attempts + 1`, last_error: error })
      .where('key', '=', key)
      .execute();
  }

  async status(key: string): Promise<{ status: DeliveryStatus; attempts: number } | undefined> {
    return this.db.current.selectFrom('notification_deliveries').select(['status', 'attempts']).where('key', '=', key).executeTakeFirst();
  }
}
