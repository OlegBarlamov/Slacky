// Search over the core store (Postgres full-text search). The search vector is written in the
// same transaction as the message, so results always match the DB. Access control happens
// before the query: only the user's own conversations are searched.
import { isEmptyQuery, parseQuery } from '../../../shared/search';
import type { Id, SearchResult } from '../../../shared/types';
import type { Repositories } from '../repositories';
import { AppError } from './errors';

const MAX_LIMIT = 100;

/** Postgres error code for a statement cancelled by `statement_timeout`. */
const QUERY_CANCELED = '57014';

export class SearchService {
  constructor(private readonly repos: Repositories) {}

  async search(userId: Id, rawQuery: unknown, rawLimit: unknown): Promise<SearchResult> {
    const q = parseQuery(String(rawQuery ?? ''));
    const empty = { messages: [], total: 0 };
    if (isEmptyQuery(q)) return empty;
    const limit = Math.min(Number(rawLimit) || 50, MAX_LIMIT);

    const states = await this.repos.conversations.memberStates(userId);
    const inChannel = q.in ? await this.repos.conversations.findChannelId(q.in) : null;
    const convIds = states.map((s) => s.convId).filter((id) => !q.in || id === inChannel);
    const authorId = q.from ? ((await this.repos.users.findByName(q.from))?.id ?? null) : null;
    if (q.from && !authorId) return empty;

    return this.repos.messages.search({ convIds, authorId, terms: q.terms, phrases: q.phrases, limit }).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === QUERY_CANCELED) {
        throw new AppError('unavailable', 'That search took too long. Try more specific words or a filter like in:#channel.');
      }
      throw err;
    });
  }
}
