import type { FastifyError, FastifyInstance } from 'fastify';
import type { Id } from '../../../shared/types';
import type { RealtimeHub } from '../realtime/hub';
import type { Services } from '../services';
import { AppError } from '../services/errors';
import { authRoutes, SESSION_COOKIE } from './auth';
import { conversationRoutes } from './conversations';
import { feedRoutes } from './feed';
import { messageRoutes } from './messages';
import { searchRoutes } from './search';
import { streamRoutes } from './stream';

declare module 'fastify' {
  interface FastifyRequest {
    userId: Id;
  }
}

const STATUS = { invalid: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;
const PUBLIC = new Set(['/api/auth/register', '/api/auth/login', '/api/auth/logout']);

export interface ApiOptions {
  services: Services;
  hub: RealtimeHub;
}

export async function api(app: FastifyInstance, { services, hub }: ApiOptions) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) return reply.status(STATUS[err.code]).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal error' });
  });

  // The session cookie is signed, so its value (the user id) can't be forged.
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (req) => {
    if (PUBLIC.has(req.url.split('?')[0])) return;
    const raw = req.cookies[SESSION_COOKIE];
    const cookie = raw ? req.unsignCookie(raw) : null;
    if (!cookie?.valid || !cookie.value || !services.users.find(cookie.value)) throw new AppError('unauthenticated', 'Not signed in');
    req.userId = cookie.value;
  });

  authRoutes(app, services);
  conversationRoutes(app, services);
  messageRoutes(app, services);
  feedRoutes(app, services);
  searchRoutes(app, services);
  streamRoutes(app, hub);
}
