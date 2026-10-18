// Search through the external index. The index is eventually consistent and only knows ids,
// so access control happens before the query and every hit is re-checked against the core.
import { isEmptyQuery, parseQuery } from '../../../shared/search';
import type { Id, SearchResult } from '../../../shared/types';
import { type SearchIndex, toSearchDoc } from '../externals/search-index';
import type { Repositories } from '../repositories';
import { AppError } from './errors';

const MAX_LIMIT = 100;

export class SearchService {
  constructor(
    private readonly repos: Repositories,
    private readonly index: SearchIndex,
    /** Changes not yet applied to the index. */
    private readonly pendingChanges: () => number,
  ) {}

  async search(userId: Id, rawQuery: unknown, rawLimit: unknown): Promise<SearchResult> {
    const q = parseQuery(String(rawQuery ?? ''));
    const empty = { messages: [], total: 0, pendingChanges: this.pendingChanges() };
    if (isEmptyQuery(q)) return empty;
    const limit = Math.min(Number(rawLimit) || 50, MAX_LIMIT);

    const convIds = this.repos.conversations
      .memberStates(userId)
      .map((s) => s.convId)
      .filter((id) => !q.in || this.repos.conversations.get(id)?.name === q.in);
    const authorId = q.from ? (this.repos.users.findByName(q.from)?.id ?? null) : null;
    if (q.from && !authorId) return empty;

    // One retry absorbs a blip; if the index is really down, say so instead of "no results".
    const ask = () => this.index.query({ convIds, authorId, terms: q.terms, phrases: q.phrases, limit });
    const hits = await ask()
      .catch(ask)
      .catch(() => {
        throw new AppError('unavailable', 'Search is temporarily unavailable. Try again in a moment.');
      });

    // Never show what the index hasn't caught up with: deleted messages or conversations I left.
    const allowed = new Set(convIds);
    const messages = hits.ids.map((id) => this.repos.messages.get(id)).filter((m) => m && !m.deletedAt && allowed.has(m.convId)).map((m) => m!);
    return { messages, total: hits.total - (hits.ids.length - messages.length), pendingChanges: this.pendingChanges() };
  }

  /** Rebuilds the index from the core store, e.g. on startup since the index lives in memory. */
  rebuild() {
    return this.index.load(this.repos.messages.allLive().map(toSearchDoc));
  }
}
