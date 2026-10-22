// Operator commands for dead letters: jobs that ran out of attempts. Same image as the server.
//   npm run ops -w server -- dlq list [listener]
//   npm run ops -w server -- dlq retry <listener> [jobId…]     (all of the listener's, without ids)
//   npm run ops -w server -- dlq discard <listener> <jobId…>
import { PgBoss } from 'pg-boss';
import type { DomainEvents } from './events';
import { PgBossEventBus } from './events-system';
import { LISTENER_CONFIG, ROUTES } from './listeners';
import { LOCAL_DATABASE_URL } from './repositories/db';

const USAGE = 'Usage: ops dlq list [listener] | dlq retry <listener> [jobId…] | dlq discard <listener> <jobId…>';
const [group, command, listener, ...ids] = process.argv.slice(2);
if (group !== 'dlq' || !command) fail(USAGE);
if (listener && !(listener in ROUTES)) fail(`Unknown listener "${listener}". Listeners: ${Object.keys(ROUTES).join(', ')}`);

// No workers and no maintenance: this process only reads and moves jobs.
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL, supervise: false, schedule: false });
boss.on('error', (err) => console.error('pg-boss:', err));
await boss.start();
const bus = new PgBossEventBus<DomainEvents>(boss, ROUTES, LISTENER_CONFIG);
try {
  await bus.createQueues();
  switch (command) {
    case 'list': {
      const dead = await bus.deadLetters(listener);
      for (const d of dead) {
        console.log(`${d.id}  ${d.listener}  ${d.failedAt.toISOString()}  ${d.events.map((e) => e.type).join(',')}  ${d.error ?? ''}`);
      }
      console.log(`${dead.length} dead letter(s)`);
      break;
    }
    case 'retry':
      if (!listener) fail(USAGE);
      console.log(`Moved ${await bus.retryDeadLetters(listener, ids.length ? ids : undefined)} job(s) back to ${listener}`);
      break;
    case 'discard':
      if (!listener || !ids.length) fail(USAGE);
      await bus.discardDeadLetters(listener, ids);
      console.log(`Discarded ${ids.length} job(s) from ${listener}`);
      break;
    default:
      fail(USAGE);
  }
} finally {
  await boss.stop({ graceful: false });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
