import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../services';
import { AppError } from '../services/errors';
import type { Body, IdParams } from './types';

export const SESSION_COOKIE = 'sid';

const startSession = (reply: FastifyReply, userId: string) =>
  reply.setCookie(SESSION_COOKIE, userId, { signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86_400 });

export function authRoutes(app: FastifyInstance, { users, conversations }: Services) {
  app.post<{ Body: Body }>('/auth/register', async (req, reply) => {
    const user = await users.register(req.body?.name);
    startSession(reply, user.id);
    return user;
  });

  app.post<{ Body: Body }>('/auth/login', async (req, reply) => {
    const user = await users.login(req.body?.name);
    startSession(reply, user.id);
    return user;
  });

  app.post('/auth/logout', async (_req, reply) => reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send());

  app.get('/me', async (req) => users.find(req.userId));
  // Bootstrap only carries people in my conversations; anyone else is found by name prefix.
  app.get<{ Querystring: { q?: string; convId?: string; limit?: string } }>('/users', async (req) =>
    users.search(req.userId, req.query.q, req.query.convId, req.query.limit),
  );
  // For clients that meet a user outside their bootstrap (e.g. a message author).
  app.get<IdParams>('/users/:id', async (req) => {
    const user = await users.find(req.params.id);
    if (!user) throw new AppError('not_found', 'User not found');
    return user;
  });
  app.get('/bootstrap', async (req) => conversations.bootstrap(req.userId));
}
