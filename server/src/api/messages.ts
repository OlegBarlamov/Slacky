import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import type { IdBody, IdParams } from './types';

export function messageRoutes(app: FastifyInstance, { messages }: Services) {
  app.patch<IdBody>('/messages/:id', async (req) => messages.edit(req.userId, req.params.id, String(req.body?.text ?? '')));
  app.delete<IdParams>('/messages/:id', async (req) => messages.delete(req.userId, req.params.id));

  app.get<IdParams>('/threads/:id', async (req) => messages.thread(req.userId, req.params.id));
  app.post<IdBody>('/threads/:id/read', async (req, reply) => {
    messages.markThreadRead(req.userId, req.params.id, req.body?.seq);
    return reply.status(204).send();
  });
}
