import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import type { Body } from './types';

export function feedRoutes(app: FastifyInstance, { feed }: Services) {
  app.get('/activity', async (req) => ({ items: await feed.list(req.userId) }));
  app.post<{ Body: Body }>('/activity/read', async (req, reply) => {
    await feed.markRead(req.userId, req.body?.ids ?? []);
    return reply.status(204).send();
  });
}
