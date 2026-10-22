// Listed explicitly (not read from disk) so they work the same under tsx, vitest and a bundle.
// Append new migrations; never edit one that has shipped.
import type { Migration } from 'kysely/migration';
import * as core from './0001_core';
import * as notificationDeliveries from './0002_notification_deliveries';

export const migrations: Record<string, Migration> = {
  '0001_core': core,
  '0002_notification_deliveries': notificationDeliveries,
};
