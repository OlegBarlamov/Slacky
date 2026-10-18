// The notification sender (push / email) as an external system.
import type { SentNotification } from '../../../shared/types';
import type { Network } from './chaos';

export interface NotificationSender {
  /** Idempotent by `key`: sending the same notification twice delivers it once. */
  send(n: SentNotification): Promise<void>;
}

const KEEP = 100;

/** Records what it "sent" so the dev panel can show it. */
export class FakeNotificationSender implements NotificationSender {
  private keys = new Set<string>();
  private log: SentNotification[] = [];

  constructor(private readonly network: Network) {}

  send(n: SentNotification) {
    return this.network.call('notifications', () => {
      if (this.keys.has(n.key)) return;
      this.keys.add(n.key);
      this.log.unshift(n);
      this.log.length = Math.min(this.log.length, KEEP);
    });
  }

  recent(limit: number): SentNotification[] {
    return this.log.slice(0, limit);
  }
}
