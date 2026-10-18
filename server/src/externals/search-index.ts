// The search index as an external system. Only ids and text cross the boundary: callers do
// access control and re-check hits against the core store.
import { tokenize } from '../../../shared/search';
import type { Id, Message } from '../../../shared/types';
import type { Network } from './chaos';

export interface SearchDoc {
  id: Id;
  convId: Id;
  authorId: Id;
  text: string;
  createdAt: number;
  version: number;
  deleted: boolean;
}

export const toSearchDoc = (m: Message): SearchDoc => ({
  id: m.id,
  convId: m.convId,
  authorId: m.authorId,
  text: m.text,
  createdAt: m.createdAt,
  version: m.version,
  deleted: m.deletedAt !== null,
});

export interface IndexQuery {
  convIds: Id[];
  authorId: Id | null;
  terms: string[]; // normalized words, prefix-matched
  phrases: string[]; // lowercased, exact
  limit: number;
}

export interface SearchIndex {
  /** Idempotent: an older version than the stored one is ignored, and deletes are final. */
  upsert(doc: SearchDoc): Promise<void>;
  query(q: IndexQuery): Promise<{ ids: Id[]; total: number }>;
  /** Replaces the whole index, e.g. when rebuilding from the source of truth. */
  load(docs: SearchDoc[]): Promise<void>;
}

interface Entry extends SearchDoc {
  tokens: string[];
}

export class InMemorySearchIndex implements SearchIndex {
  private docs = new Map<Id, Entry>();

  constructor(private readonly network: Network) {}

  upsert(doc: SearchDoc) {
    return this.network.call('search', () => {
      const current = this.docs.get(doc.id);
      if (current && (current.deleted || current.version >= doc.version)) return; // stale or already deleted
      this.docs.set(doc.id, { ...doc, text: doc.deleted ? '' : doc.text, tokens: doc.deleted ? [] : tokenize(doc.text) });
    });
  }

  query(q: IndexQuery) {
    return this.network.call('search', () => {
      const convs = new Set(q.convIds);
      const hits = [...this.docs.values()].filter(
        (d) =>
          !d.deleted &&
          convs.has(d.convId) &&
          (!q.authorId || d.authorId === q.authorId) &&
          q.terms.every((t) => d.tokens.some((w) => w.startsWith(t))) &&
          q.phrases.every((p) => d.text.toLowerCase().includes(p)),
      );
      hits.sort((a, b) => b.createdAt - a.createdAt);
      return { ids: hits.slice(0, q.limit).map((d) => d.id), total: hits.length };
    });
  }

  async load(docs: SearchDoc[]) {
    this.docs = new Map(docs.map((d) => [d.id, { ...d, tokens: tokenize(d.text) }]));
  }
}
