// Live connections (SSE) per user. Every event gets an id; a client reconnecting with
// Last-Event-ID gets what it missed, or `resync` if that's no longer in the buffer.
import type { Id, StreamEvent } from '../../../shared/types';

export type Send = (id: number, event: StreamEvent) => void;

interface Logged {
  id: number;
  to: Set<Id> | 'everyone';
  event: StreamEvent;
}


const BUFFER = 1000;

export class RealtimeHub {
  private lastId = 0;
  private log: Logged[] = [];
  private conns = new Map<Id, Set<Send>>();

  get cursor() {
    return this.lastId;
  }

  publish(userIds: Id[], event: StreamEvent) {
    this.push(new Set(userIds), event);
  }

  broadcast(event: StreamEvent) {
    this.push('everyone', event);
  }

  /** Connects a user's stream; returns the disconnect function. */
  connect(userId: Id, lastEventId: number, send: Send): () => void {
    const oldest = this.log[0]?.id ?? this.lastId + 1;
    if (lastEventId > this.lastId || lastEventId < oldest - 1) {
      send(this.lastId, { type: 'resync' }); // server restarted or client too far behind
    } else {
      for (const e of this.log) if (e.id > lastEventId && this.isFor(e, userId)) send(e.id, e.event);
    }
    if (!this.conns.has(userId)) this.conns.set(userId, new Set());
    this.conns.get(userId)!.add(send);
    return () => this.conns.get(userId)?.delete(send);
  }

  private push(to: Logged['to'], event: StreamEvent) {
    const logged = { id: ++this.lastId, to, event };
    this.log.push(logged);
    if (this.log.length > BUFFER) this.log.shift();
    for (const [userId, set] of this.conns) if (this.isFor(logged, userId)) for (const send of set) send(logged.id, event);
  }

  private isFor(e: Logged, userId: Id) {
    return e.to === 'everyone' || e.to.has(userId);
  }
}
