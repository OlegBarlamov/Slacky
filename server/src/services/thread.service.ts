// The Threads view: threads the user follows (thread_participants), newest reply first.
import type { Id, ThreadList } from '../../../shared/types';
import type { Repositories } from '../repositories';
import type { ThreadCursor } from '../repositories/message.repository';
import { AppError } from './errors';

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const LATEST_REPLIES = 3; // shown under each root

export interface ThreadListParams {
  cursor?: unknown;
  limit?: unknown;
  unread?: unknown;
}

// Opaque to clients: `<latest reply ms>:<root id>` of the last item.
const encodeCursor = (c: ThreadCursor) => `${c.at}:${c.rootId}`;

function decodeCursor(raw: unknown): ThreadCursor | null {
  if (raw === undefined || raw === '') return null;
  const [, at, rootId] = /^(\d+):(.+)$/.exec(String(raw)) ?? [];
  if (!at) throw new AppError('invalid', 'Invalid cursor');
  return { at: Number(at), rootId };
}

export class ThreadService {
  constructor(private readonly repos: Repositories) {}

  /** A page of followed threads; `unread=1` keeps those with unread replies from others. */
  async list(userId: Id, params: ThreadListParams = {}): Promise<ThreadList> {
    const limit = params.limit === undefined || params.limit === '' ? PAGE_SIZE : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new AppError('invalid', 'limit must be a positive integer');
    const take = Math.min(limit, MAX_PAGE_SIZE);
    const rows = await this.repos.messages.followedThreads(userId, {
      cursor: decodeCursor(params.cursor),
      unreadOnly: params.unread === '1' || params.unread === 'true',
      limit: take + 1,
    });
    const page = rows.slice(0, take);
    const replies = await this.repos.messages.latestReplies(page.map((r) => r.root.id), LATEST_REPLIES);
    const last = page.at(-1);
    return {
      threads: page.map(({ root, readSeq, unreadCount }) => ({ root, latestReplies: replies.get(root.id) ?? [], lastReadSeq: readSeq, unreadCount })),
      nextCursor: rows.length > take && last ? encodeCursor({ at: last.root.thread!.lastReplyAt, rootId: last.root.id }) : null,
    };
  }
}
