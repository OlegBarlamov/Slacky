import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import type { PageParams } from '../services/message.service';
import type { ThreadListParams } from '../services/thread.service';
import type { IdBody, IdParams } from './types';

export function messageRoutes(app: FastifyInstance, { messages, threads }: Services) {
  app.patch<IdBody>('/messages/:id', async (req) => messages.edit(req.userId, req.params.id, String(req.body?.text ?? '')));
  app.delete<IdParams>('/messages/:id', async (req) => messages.delete(req.userId, req.params.id));

  // Threads I follow, for the Threads view: ?cursor=&limit=&unread=1
  app.get<{ Querystring: ThreadListParams }>('/threads', async (req) => threads.list(req.userId, req.query));
  app.get<IdParams & { Querystring: PageParams }>('/threads/:id', async (req) => messages.thread(req.userId, req.params.id, req.query));
  app.post<IdBody>('/threads/:id/read', async (req) => messages.markThreadRead(req.userId, req.params.id, req.body?.seq));
}
