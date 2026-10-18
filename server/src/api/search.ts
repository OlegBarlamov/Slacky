import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';

export function searchRoutes(app: FastifyInstance, { search }: Services) {
  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', (req) => search.search(req.userId, req.query.q, req.query.limit));
}
