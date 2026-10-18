import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import type { Body, IdBody, IdParams } from './types';

// Create, join and open-DM answer with the caller's view, so the client gets read state too.
export function conversationRoutes(app: FastifyInstance, { conversations, messages }: Services) {
  app.post<{ Body: Body }>('/conversations', async (req) => {
    const c = conversations.createChannel(req.body?.name, [req.userId]);
    return conversations.view(req.userId, c.id);
  });

  app.post<IdParams>('/conversations/:id/join', async (req) => {
    conversations.join(req.userId, req.params.id);
    return conversations.view(req.userId, req.params.id);
  });

  app.post<IdParams>('/conversations/:id/leave', async (req, reply) => {
    conversations.leave(req.userId, req.params.id);
    return reply.status(204).send();
  });

  app.post<{ Body: Body }>('/dms', async (req) => {
    const c = conversations.openDm(req.userId, String(req.body?.userId ?? ''));
    return conversations.view(req.userId, c.id);
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/conversations/:id/messages', async (req) =>
    messages.list(req.userId, req.params.id, req.query.before),
  );

  app.post<IdBody>('/conversations/:id/messages', async (req) =>
    messages.post(req.userId, req.params.id, {
      clientMsgId: String(req.body?.clientMsgId ?? ''),
      text: String(req.body?.text ?? ''),
      threadRootId: typeof req.body?.threadRootId === 'string' ? req.body.threadRootId : null,
    }),
  );

  app.post<IdBody>('/conversations/:id/read', async (req, reply) => {
    messages.markRead(req.userId, req.params.id, req.body?.seq);
    return reply.status(204).send();
  });
}
