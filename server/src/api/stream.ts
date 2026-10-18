import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import type { StreamEvent } from '../../../shared/types';
import type { RealtimeHub } from '../realtime/hub';

const HEARTBEAT_MS = 15_000;

/** Server-sent events. Resumes from Last-Event-ID, so a reconnect misses nothing still buffered. */
export function streamRoutes(app: FastifyInstance, hub: RealtimeHub) {
  app.get('/stream', (req, reply) => {
    const stream = new PassThrough();
    const header = Number(req.headers['last-event-id']);
    const lastEventId = Number.isInteger(header) && header >= 0 ? header : hub.cursor;
    const write = (id: number, event: StreamEvent) => stream.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const disconnect = hub.connect(req.userId, lastEventId, write);
    const heartbeat = setInterval(() => stream.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      disconnect();
      stream.end();
    });
    return reply.header('Content-Type', 'text/event-stream').header('Cache-Control', 'no-cache').send(stream);
  });
}
