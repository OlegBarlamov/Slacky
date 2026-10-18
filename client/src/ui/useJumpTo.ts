import { useEffect, useRef, useState } from 'react';
import type { Id } from '@shared/types';

/**
 * Scrolls to and briefly highlights `msgId` once it's rendered, paging older history in
 * (a few pages at most) if it isn't loaded yet. Returns the id to highlight.
 */
export function useJumpTo(msgId: Id | null, ids: Id[], hasMore: boolean, loadOlder: () => Promise<void>) {
  const [highlighted, setHighlighted] = useState<Id | null>(null);
  const jumpedTo = useRef<Id | null>(null);
  const pagesLoaded = useRef(0);
  const loading = useRef(false);
  const present = !!msgId && ids.includes(msgId);

  useEffect(() => {
    if (!msgId || jumpedTo.current === msgId) return;
    if (!present) {
      if (hasMore && ids.length && !loading.current && pagesLoaded.current++ < 5) {
        loading.current = true;
        void loadOlder().finally(() => (loading.current = false));
      }
      return;
    }
    jumpedTo.current = msgId;
    pagesLoaded.current = 0;
    document.getElementById(`msg-${msgId}`)?.scrollIntoView({ block: 'center' });
    setHighlighted(msgId);
    setTimeout(() => setHighlighted(null), 2000);
  }, [msgId, present, ids.length, hasMore]);

  return highlighted;
}
